'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { buildTypedOSCMessage } = require('./osc-codec');

const MAX_PACKET_BYTES = 1200;
const HEADER_TYPES = 'isddisiii';

function spectrumConfig(env = process.env) {
  const enabled = env.CWT_SPECTRUM_OSC_ENABLED ?? '0';
  if (!['0', '1'].includes(enabled)) throw new RangeError('CWT_SPECTRUM_OSC_ENABLED must be 0 or 1');
  const minIntervalMs = Number(env.CWT_SPECTRUM_OSC_INTERVAL_MS ?? 1000);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 1000) {
    throw new RangeError('CWT_SPECTRUM_OSC_INTERVAL_MS must be at least 1000');
  }
  return { enabled: enabled === '1', minIntervalMs };
}

function validateSpectrum(frame) {
  if (!Number.isFinite(frame.timestampUs)) return 'invalid-timestamp';
  if (!frame.ready) return frame.reason || 'not-ready';
  const scales = frame.spectrum.scales;
  if (!Array.isArray(scales) || scales.length === 0) return 'missing-scales';
  let previousFrequency = Infinity;
  for (const scale of scales) {
    if (!Array.isArray(scale) || scale.length !== 3) return 'invalid-scale';
    const [frequency, magnitude, phase] = scale;
    if (phase === null || phase === undefined) return 'phase-unavailable';
    if (!scale.every(value => typeof value === 'number' && Number.isFinite(value)
      && Number.isFinite(Math.fround(value)))) return 'invalid-scale';
    if (!(frequency > 0) || !(Math.fround(frequency) > 0) || frequency >= previousFrequency
      || magnitude < 0 || Math.abs(phase) > Math.PI) return 'invalid-scale';
    previousFrequency = frequency;
  }
  return '';
}

// New messages only: no timer, snapshot replay, CWT, or voice-tracker work here.
class SpectrumOsc {
  constructor({ enabled = false, minIntervalMs = 1000, now = () => performance.now() } = {}) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 1000) throw new RangeError('minIntervalMs must be at least 1000');
    Object.assign(this, { enabled, minIntervalMs, now });
    this.streams = new Map();
  }

  update(frame) {
    if (!this.enabled || frame.type !== 'resident_voices'
      || !/^osc\/[^/]+\/[^/]+$/.test(frame.device)) return [];
    const source = frame.spectrum;
    // An older sidecar can keep supplying voices without spectrum support.
    if (!source || typeof source.epoch !== 'string' || !source.epoch
      || !Number.isSafeInteger(source.frame) || source.frame < 1) return [];
    let state = this.streams.get(frame.device);
    const reset = !state || state.sourceEpoch !== source.epoch;
    if (reset) {
      state = { sourceEpoch: source.epoch, epoch: randomUUID(), sequence: 0, lastSent: -Infinity, status: null };
      this.streams.set(frame.device, state);
    }
    // The router may invalidate a cached frame on bridge disconnect. Treat that
    // status change as a new publication; keep its last available source timestamp.
    const key = `${source.frame}:${frame.ready}:${frame.reason || ''}`;
    if (state.lastObserved === key) return [];
    state.lastObserved = key;
    const reason = validateSpectrum(frame);
    const status = reason ? `invalid:${reason}` : 'ready';
    const transition = status !== state.status;
    const now = this.now();
    // Readiness/reset transitions bypass the rate limit so obsolete sound can stop.
    if (!reset && !transition && now - state.lastSent < this.minIntervalMs) return [];
    // Repeated unavailable results contain no new coefficients.
    if (!transition && reason) return [];
    state.status = status;
    state.lastSent = now;
    state.sequence++;
    const scales = reason ? [] : source.scales;
    const address = `/${frame.device}/cwt/spectrum`;
    const header = [1, state.epoch, state.sequence,
      Number.isFinite(frame.timestampUs) ? frame.timestampUs : -1,
      reason ? 0 : 1, reason, scales.length, 0, 0];
    const headerBytes = buildTypedOSCMessage(address, HEADER_TYPES, header).length;
    // Each fff triple adds 12 payload bytes and 3 type-tag bytes; allow padding.
    const perPacket = Math.floor((MAX_PACKET_BYTES - headerBytes - 3) / 15);
    if (perPacket < 1) return []; // Path too long to represent within the datagram budget.
    if (!scales.length) return [buildTypedOSCMessage(address, HEADER_TYPES, header)];
    const packets = [];
    for (let offset = 0; offset < scales.length; offset += perPacket) {
      const count = Math.min(perPacket, scales.length - offset);
      const args = [...header];
      args[7] = offset;
      args[8] = count;
      for (let i = offset; i < offset + count; i++) args.push(...scales[i]);
      packets.push(buildTypedOSCMessage(address, HEADER_TYPES + 'fff'.repeat(count), args));
    }
    return packets;
  }
}
module.exports = { SpectrumOsc, spectrumConfig, validateSpectrum, MAX_PACKET_BYTES };
