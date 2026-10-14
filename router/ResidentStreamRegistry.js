'use strict';

const { randomUUID } = require('node:crypto');
const { StreamBuffer } = require('./StreamBuffer');
const { ResidentAnalyzer } = require('./ResidentAnalyzer');
const { VoiceTracker } = require('./VoiceTracker');

class ResidentStreamRegistry {
  constructor({
    bufferOptions = { durationSeconds: 120, maxInterpolationGapSeconds: 1 },
    analyzerOptions = {},
    trackerOptions = {},
    interpolationFor = () => 'linear',
    staleAfterSeconds = 300,
    timestampDiscontinuitySeconds = 10,
    createBuffer = options => new StreamBuffer(options),
    createAnalyzer = options => new ResidentAnalyzer(options),
    createTracker = options => new VoiceTracker(options),
  } = {}) {
    if (typeof interpolationFor !== 'function') throw new TypeError('interpolationFor must be a function');
    if (!(staleAfterSeconds > 0)) throw new RangeError('staleAfterSeconds must be greater than zero');
    if (!(timestampDiscontinuitySeconds > 0)) {
      throw new RangeError('timestampDiscontinuitySeconds must be greater than zero');
    }

    Object.assign(this, {
      bufferOptions,
      analyzerOptions,
      trackerOptions,
      interpolationFor,
      staleAfterUs: staleAfterSeconds * 1e6,
      timestampDiscontinuityUs: timestampDiscontinuitySeconds * 1e6,
      createBuffer,
      createAnalyzer,
      createTracker,
    });
    this.streams = new Map();
    this.analysisCursor = 0;
    this.latest = new Map();
    this.pending = [];
    this.nextIds = new Map();
  }

  get size() {
    return this.streams.size;
  }

  remove(streamId, reason = 'idle') {
    const entry = this.streams.get(streamId);
    if (!entry) return false;
    this.nextIds.set(streamId, entry.tracker.nextId);
    const message = {
      type: 'resident_voices', device: streamId, timestampUs: entry.lastTimestampUs,
      value: entry.lastValue, ready: false, reason, coverage: 0, voices: [],
      spectrum: { epoch: entry.epoch, frame: ++entry.frame, scales: [] },
    };
    this.latest.set(streamId, message);
    this.pending.push(message);
    return this.streams.delete(streamId);
  }

  drainPending() { return this.pending.splice(0); }

  expire(nowTimestampUs) {
    for (const [streamId, entry] of this.streams) {
      if (nowTimestampUs - entry.lastReceivedAtUs > this.staleAfterUs) this.remove(streamId, 'stale');
    }
  }

  ingest(streamId, timestampUs, value, sequence = null, receivedAtUs = Date.now() * 1000) {
    if (typeof streamId !== 'string' || !streamId) throw new TypeError('streamId must be a non-empty string');
    timestampUs = Number(timestampUs);
    value = Number(value);
    receivedAtUs = Number(receivedAtUs);
    if (!Number.isFinite(timestampUs) || !Number.isFinite(value)) return false;

    const entry = this.#entryForTimestamp(streamId, timestampUs, receivedAtUs);
    entry.buffer.push(timestampUs, value, sequence);
    if (timestampUs >= (entry.lastTimestampUs ?? -Infinity)) entry.lastValue = value;
    entry.lastTimestampUs = Math.max(entry.lastTimestampUs ?? -Infinity, timestampUs);
    if (Number.isFinite(receivedAtUs)) entry.lastReceivedAtUs = receivedAtUs;
    return true;
  }

  ingestBatch(streamId, samples, receivedAtUs = Date.now() * 1000) {
    if (typeof streamId !== 'string' || !streamId) throw new TypeError('streamId must be a non-empty string');
    if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
    const finite = samples.filter(sample => Array.isArray(sample)
      && Number.isFinite(Number(sample[1]))
      && Number.isFinite(Number(sample[2])));
    if (finite.length === 0) return 0;

    const latest = finite.reduce((candidate, sample) =>
      Number(sample[1]) >= Number(candidate[1]) ? sample : candidate);
    let entry = this.#entryForTimestamp(streamId, Number(latest[1]), receivedAtUs);
    entry.buffer.pushBatch(finite);
    if (Number(latest[1]) >= (entry.lastTimestampUs ?? -Infinity)) {
      entry.lastValue = Number(latest[2]);
    }
    entry.lastTimestampUs = entry.buffer.lastTimestampUs;
    receivedAtUs = Number(receivedAtUs);
    if (Number.isFinite(receivedAtUs)) entry.lastReceivedAtUs = receivedAtUs;
    return finite.length;
  }

  analyzeAll({ nowTimestampUs = Date.now() * 1000 } = {}) {
    this.expire(nowTimestampUs);
    return [...this.drainPending(), ...[...this.streams].map(([id, entry]) => this.#analyze(id, entry))];
  }

  analyzeNext({ nowTimestampUs = Date.now() * 1000 } = {}) {
    this.expire(nowTimestampUs);
    if (this.pending.length) return this.pending.shift();
    const entries = [...this.streams.entries()];
    if (entries.length === 0) return null;
    this.analysisCursor %= entries.length;
    const [streamId, entry] = entries[this.analysisCursor++];
    return this.#analyze(streamId, entry);
  }

  snapshot(streamId) {
    const entry = this.streams.get(streamId);
    if (!entry) return null;
    return {
      device: streamId,
      lastTimestampUs: entry.lastTimestampUs,
      value: entry.lastValue,
      sampleCount: entry.buffer.size,
      voices: entry.tracker.snapshot(),
    };
  }

  #entry(streamId) {
    let entry = this.streams.get(streamId);
    if (!entry) {
      entry = {
        epoch: randomUUID(),
        frame: 0,
        buffer: this.createBuffer(this.bufferOptions),
        analyzer: this.createAnalyzer(this.analyzerOptions),
        tracker: this.createTracker(this.trackerOptions),
        lastTimestampUs: null,
        lastValue: null,
        lastReceivedAtUs: Date.now() * 1000,
      };
      if (this.nextIds.has(streamId)) entry.tracker.nextId = this.nextIds.get(streamId);
      this.streams.set(streamId, entry);
    }
    return entry;
  }

  #entryForTimestamp(streamId, timestampUs, receivedAtUs) {
    const existing = this.streams.get(streamId);
    if (!existing || !Number.isFinite(existing.lastTimestampUs)) return this.#entry(streamId);
    const receivedGapUs = Number.isFinite(receivedAtUs) && Number.isFinite(existing.lastReceivedAtUs)
      ? Math.max(0, receivedAtUs - existing.lastReceivedAtUs)
      : 0;
    const allowedGapUs = Math.max(this.timestampDiscontinuityUs, receivedGapUs * 4);
    if (Math.abs(timestampUs - existing.lastTimestampUs) <= allowedGapUs) return existing;

    // A device reboot changes its uptime origin; a malformed transport frame
    // can produce an impossible future timestamp. Either way, begin a clean
    // analysis epoch instead of leaving one outlier to poison the ring buffer.
    this.remove(streamId, 'timestamp-discontinuity');
    return this.#entry(streamId);
  }

  #analyze(streamId, entry) {
    if (entry.latest?.timestampUs === entry.lastTimestampUs) return entry.latest;
    const interpolation = this.interpolationFor(streamId);
    const analysis = entry.analyzer.analyze(entry.buffer, {
      endTimestampUs: entry.lastTimestampUs,
      interpolation,
    });
    // Readiness loss terminates tracks immediately; IDs are never reused in this process.
    if (!analysis.ready) entry.tracker.voices = [];
    const voices = analysis.ready ? entry.tracker.update(
      analysis.candidates, { timestampUs: entry.lastTimestampUs },
    ) : [];
    const message = {
      type: 'resident_voices',
      device: streamId,
      timestampUs: entry.lastTimestampUs,
      value: entry.lastValue,
      interpolation,
      ready: analysis.ready,
      reason: analysis.reason,
      coverage: analysis.coverage,
      voices,
      spectrum: {
        epoch: entry.epoch,
        frame: ++entry.frame,
        // Preserve summarizeCwt's existing recent-window reduction, not tracker fields.
        scales: analysis.ready ? (analysis.scales || []).map(scale => [
          scale.frequencyHz, Math.sqrt(scale.recentPower),
          scale.phaseDefined === false ? null : scale.phase,
        ]) : [],
      },
    };
    entry.latest = message;
    this.latest.set(streamId, message);
    return message;
  }
}

module.exports = { ResidentStreamRegistry };
