const http = require('node:http');
const https = require('node:https');

function postBatch(url, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload), 'X-Ingest-Token': token }
    }, response => {
      let text = '';
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 65536) request.destroy(new Error('response too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result = JSON.parse(text);
          if (response.statusCode !== 200 || result.ok !== true ||
              result.accepted !== body.buckets.length ||
              result.inserted + result.duplicates !== result.accepted) {
            throw new Error('archive response rejected');
          }
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('archive timeout')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(payload);
  });
}

class WeatherBrainArchive {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.post = options.post || postBatch;
    this.log = options.log || (message => console.warn(message));
    this.url = new URL(`${options.baseUrl.replace(/\/$/, '')}/ingest/signal-buckets`);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) {
      throw new Error('Invalid archive URL');
    }
    this.token = options.token;
    this.maxRecords = options.maxRecords ?? 5000;
    this.maxClocks = options.maxClocks ?? 256;
    this.flushMs = options.flushMs ?? 10000;
    this.lateMs = options.lateMs ?? 2000;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.active = new Map();
    this.queue = [];
    this.clocks = new Map();
    this.closedBefore = -Infinity;
    this.nextFlush = this.now() + this.flushMs;
    this.retryAt = 0;
    this.failures = 0;
    this.pending = null;
    this.running = false;
    this.drops = {};
  }

  drop(reason) { this.drops[reason] = (this.drops[reason] || 0) + 1; }

  // Device uptime is anchored once, preserving sample spacing across packet jitter.
  clockTime(key, sendUs, sampleUs, receivedAt, trackDrift = false) {
    if (!Number.isFinite(sampleUs)) return null;
    if (sampleUs >= 1e15) return sampleUs / 1000; // Unix microseconds
    if (!Number.isFinite(sendUs)) return null;
    let clock = this.clocks.get(key);
    if (clock && sendUs < clock.lastUs - this.lateMs * 1000) {
      // A reboot and an old packet cannot be distinguished immediately.
      if (receivedAt - clock.lastSeen < 30000) return null;
      clock = null;
    }
    if (!clock) {
      if (!this.clocks.has(key) && this.clocks.size >= this.maxClocks) {
        this.drop('clock capacity'); return null;
      }
      clock = { offset: receivedAt - sendUs / 1000, lastUs: sendUs, lastSeen: receivedAt };
      this.clocks.set(key, clock);
    }
    if (sendUs > clock.lastUs) {
      if (trackDrift) {
        const observedOffset = receivedAt - sendUs / 1000;
        const correction = Math.max(-50, Math.min(50, observedOffset - clock.offset));
        clock.offset += correction;
      }
      clock.lastUs = sendUs;
      clock.lastSeen = receivedAt;
    }
    return clock.offset + sampleUs / 1000;
  }

  observe(message) {
    // Archival failures must not escape into the live routing path.
    try {
      const receivedAt = this.now();
      if (message?.type === 'sample_batch') {
        for (const stream of message.streams || []) {
          const key = JSON.stringify([stream.name, message.source]);
          for (const sample of stream.samples || []) {
            const time = this.clockTime(key, message.sendTimeUs, sample[1], receivedAt,
              message.transport === 'usb');
            this.add(stream.name, stream.param, stream.unit, sample[2], time, receivedAt);
          }
        }
      } else {
        for (const signal of message?.type === 'signal_batch' ? message.signals : [message]) {
          if (signal?.type !== 'osc') continue;
          const node = signal.name || signal.source;
          const param = signal.param || signal.device?.split('/').slice(2).join('/');
          const time = signal.timeUs === undefined ? receivedAt :
            this.clockTime(JSON.stringify([node, signal.source]), signal.timeUs, signal.timeUs, receivedAt);
          this.add(node, param, signal.unit, signal.value, time, receivedAt);
        }
      }
    } catch { this.drop('invalid normalized message'); }
  }

  add(node, signal, unit, value, time, now) {
    if (typeof node !== 'string' || !node || node.length > 255 ||
        typeof signal !== 'string' || !signal || signal.length > 255 ||
        !Number.isFinite(value) || !Number.isFinite(time) ||
        (unit != null && (typeof unit !== 'string' || unit.length > 80))) return;
    const start = Math.floor(time / 1000) * 1000;
    const cutoff = Math.max(this.closedBefore, Math.floor((now - this.lateMs) / 1000) * 1000);
    if (start < cutoff || time > now + this.lateMs) { this.drop('late/future sample'); return; }
    const key = JSON.stringify([node, signal, start]);
    let bucket = this.active.get(key);
    unit = unit || null;
    if (bucket && bucket.unit !== unit) { this.drop('unit conflict'); return; }
    if (!bucket) {
      if (this.active.size + this.queue.length >= this.maxRecords) {
        this.drop('queue full'); return;
      }
      bucket = { node, signal_id: signal, unit, start, mean: 0, m2: 0,
        min: value, max: value, sample_count: 0 };
      this.active.set(key, bucket);
    }
    if (bucket.sample_count >= 100000) { this.drop('sample count limit'); return; }
    const count = bucket.sample_count + 1;
    const delta = value - bucket.mean;
    const mean = bucket.mean + delta / count;
    const m2 = bucket.m2 + delta * (value - mean);
    if (!Number.isFinite(mean) || !Number.isFinite(m2)) { this.drop('numeric overflow'); return; }
    Object.assign(bucket, { mean, m2, sample_count: count,
      min: Math.min(bucket.min, value), max: Math.max(bucket.max, value) });
  }

  async tick() {
    const now = this.now();
    this.closedBefore = Math.max(this.closedBefore, Math.floor((now - this.lateMs) / 1000) * 1000);
    for (const [key, bucket] of this.active) {
      if (bucket.start >= this.closedBefore) continue;
      this.active.delete(key);
      if (!bucket.sample_count) continue;
      this.queue.push({ node: bucket.node, record: {
        signal_id: bucket.signal_id, unit: bucket.unit,
        bucket_start: new Date(bucket.start).toISOString(), mean: bucket.mean,
        min: bucket.min, max: bucket.max, sample_count: bucket.sample_count,
        stddev: Math.sqrt(Math.max(0, bucket.m2 / bucket.sample_count))
      } });
    }
    for (const [reason, count] of Object.entries(this.drops)) {
      this.log(`[archive] dropped ${count}: ${reason}`);
    }
    this.drops = {};
    if (this.running || now < this.retryAt || (!this.pending && now < this.nextFlush)) return;
    if (!this.pending) this.nextFlush = now + this.flushMs;
    this.running = true;
    // Snapshot prevents live arrivals from extending a flush indefinitely.
    const ready = this.queue.slice();
    try {
      while (this.pending || ready.length) {
        if (!this.pending) {
          const node = ready[0].node;
          const entries = ready.filter(entry => entry.node === node).slice(0, 5000);
          this.pending = { entries, body: { node_id: node, buckets: entries.map(entry => entry.record) } };
        }
        const batch = this.pending;
        await this.post(this.url, this.token, batch.body, this.timeoutMs);
        const sent = new Set(batch.entries);
        this.queue = this.queue.filter(entry => !sent.has(entry));
        for (let i = ready.length - 1; i >= 0; i--) if (sent.has(ready[i])) ready.splice(i, 1);
        this.pending = null;
        this.failures = 0;
        this.retryAt = 0;
      }
    } catch {
      this.failures = Math.min(this.failures + 1, 7);
      const delay = Math.min(60000, 1000 * 2 ** (this.failures - 1));
      this.retryAt = this.now() + delay;
      this.log(`[archive] request failed; retry in ${delay}ms`);
    } finally { this.running = false; }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
    this.timer.unref();
    return this;
  }
  stop() { clearInterval(this.timer); }
}

function createArchive(env = process.env) {
  if (!env.WEATHER_BRAIN_URL && !env.WEATHER_BRAIN_INGEST_TOKEN) return { observe() {} };
  try {
    if (!env.WEATHER_BRAIN_URL || !env.WEATHER_BRAIN_INGEST_TOKEN) throw new Error('Incomplete config');
    return new WeatherBrainArchive({ baseUrl: env.WEATHER_BRAIN_URL,
      token: env.WEATHER_BRAIN_INGEST_TOKEN }).start();
  } catch {
    console.warn('[archive] disabled: invalid or incomplete Weather Brain configuration');
    return { observe() {} };
  }
}

module.exports = { WeatherBrainArchive, createArchive, postBatch };
