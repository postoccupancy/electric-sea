'use strict';
const { buildTypedOSCMessage } = require('./osc-codec');

// Cache authoritative frames, using the existing tracker's IDs and fields.
class VoiceOsc {
  constructor() { this.latest = new Map(); }
  update(message) {
    if (message.type !== 'resident_voices' || !/^osc\/[^/]+\/[^/]+$/.test(message.device)) return [];
    const previous = this.latest.get(message.device);
    const current = { ...message, voices: message.ready ? message.voices : [] };
    this.latest.set(message.device, current);
    const ids = new Set(current.voices.map(voice => voice.id));
    const ended = (previous?.voices || []).filter(voice => !ids.has(voice.id))
      .map(voice => ({ ...voice, active: false, confidence: 0 }));
    return this.packets(current, ended);
  }
  packets(message, ended = []) {
    const base = `/${message.device}/cwt`;
    const timestamp = message.timestampUs ?? -1;
    const packets = [...ended, ...message.voices].map(voice => buildTypedOSCMessage(
      `${base}/voice/${voice.id}`, 'ddddidd',
      [voice.frequencyHz, voice.strength, voice.phase, voice.confidence, voice.active ? 1 : 0,
        timestamp, voice.lastTimestampUs ?? -1],
    ));
    const active = message.voices.filter(voice => voice.active).map(voice => voice.id);
    packets.push(buildTypedOSCMessage(`${base}/voices`, `disdi${'i'.repeat(active.length)}`,
      [timestamp, message.ready ? 1 : 0, message.reason || '', message.coverage || 0, active.length, ...active]));
    return packets;
  }
  snapshot() { return [...this.latest.values()].flatMap(message => this.packets(message)); }
  unavailable(reason) {
    return [...this.latest.values()].flatMap(message => this.update({ ...message, ready: false, reason, coverage: 0, voices: [] }));
  }
}
module.exports = { VoiceOsc };
