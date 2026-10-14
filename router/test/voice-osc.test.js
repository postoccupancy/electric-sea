'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceOsc } = require('../voice-osc');
const { buildTypedOSCMessage, parseOSCPacket } = require('../osc-codec');
const { OscClients } = require('../osc-clients');
const frame = (overrides = {}) => ({
  type: 'resident_voices', device: 'osc/indoor-sky/temperature',
  timestampUs: 1791900000123456, ready: true, reason: null, coverage: 0.98,
  voices: [{ id: 7, frequencyHz: 0.125, strength: 3, phase: 0.25,
    confidence: 0.8, active: true, lastTimestampUs: 1791900000123456 }], ...overrides,
});
const decode = packets => packets.flatMap(parseOSCPacket);
test('voice address, explicit argument types and microsecond timestamps round trip', () => {
  const publisher = new VoiceOsc();
  const packets = publisher.update(frame());
  assert.ok(packets[0].includes(Buffer.from(',ddddidd\0')));
  assert.ok(packets[1].includes(Buffer.from(',disdii\0')));
  assert.deepEqual(decode(packets), [
    { address: '/osc/indoor-sky/temperature/cwt/voice/7', args: [0.125, 3, 0.25, 0.8, 1, 1791900000123456, 1791900000123456] },
    { address: '/osc/indoor-sky/temperature/cwt/voices', args: [1791900000123456, 1, '', 0.98, 1, 7] },
  ]);
  assert.deepEqual(publisher.snapshot(), packets);
});
test('removed voices get a final inactive packet and repeated authoritative empty state', () => {
  const publisher = new VoiceOsc();
  publisher.update(frame());
  const messages = decode(publisher.update(frame({ voices: [] })));
  assert.equal(messages[0].args[4], 0);
  assert.equal(messages[0].args[3], 0);
  assert.deepEqual(messages[1].args.slice(4), [0]);
  assert.equal(decode(publisher.snapshot()).length, 1);
  assert.deepEqual(decode(publisher.snapshot())[0].args.slice(4), [0]);
});
test('readiness loss and analyzer disconnect immediately terminate active voices', () => {
  for (const reason of ['coverage', 'stale', 'idle', 'timestamp-discontinuity']) {
    const publisher = new VoiceOsc();
    publisher.update(frame());
    const messages = decode(publisher.update(frame({ ready: false, reason })));
    assert.equal(messages[0].args[4], 0);
    assert.equal(messages[1].args[1], 0);
    assert.equal(messages[1].args[2], reason);
  }
  const publisher = new VoiceOsc();
  publisher.update(frame());
  assert.equal(decode(publisher.unavailable('analyzer-disconnected'))[1].args[2], 'analyzer-disconnected');
});
test('OSC controls round trip and coexist with multiple browser owners over LAN and Tailscale', () => {
  let now = 0;
  const clients = new OscClients({ now: () => now });
  const control = (address, ip, port = 9000) => clients.control(parseOSCPacket(buildTypedOSCMessage(address, 'i', [port]))[0], ip);
  for (const ip of ['192.168.0.42', '100.90.80.70']) {
    const a = {}, b = {};
    clients.add(ip, a); clients.add(ip, b);
    control('/router/subscribe', ip);
    clients.delete(ip, a); clients.delete(ip, b);
    assert.equal(clients.has(ip), true);
    clients.add(ip, a);
    control('/router/unsubscribe', ip);
    assert.equal(clients.has(ip), true);
    clients.delete(ip, a);
    assert.equal(clients.has(ip), false);
    control('/router/subscribe', ip, 9001);
    assert.equal(clients.has(ip), false);
    control('/router/subscribe', ip);
  }
  now = 20000;
  control('/router/heartbeat', '100.90.80.70');
  now = 30000; clients.expire();
  assert.deepEqual([...clients], ['100.90.80.70']);
  now = 50000; clients.expire();
  assert.equal(clients.size, 0);
  assert.equal(clients.control({ address: '/sensor/sky/temp', args: [20] }, '192.168.0.42'), false);
});

test('existing sensor scalar and timestamped batch encoding remains compatible', () => {
  const { buildOSCMessage, buildScalarBatchOsc } = require('../osc-codec');
  assert.deepEqual(parseOSCPacket(buildOSCMessage('/osc/sky/temperature', 21.5, 0.5)), [
    { address: '/osc/sky/temperature', args: [21.5, 0.5] },
  ]);
  assert.deepEqual(parseOSCPacket(buildScalarBatchOsc({ packetSequence: 2, sendTimeUs: 1234567890123,
    streams: [{ name: 'sky', param: 'temperature', unit: 'celsius', samples: [[3, 1234567890100, 21.5]] }] })), [
    { address: '/batch/sky/temperature', args: [2, 1234567890123, 'celsius', 3, -23, 21.5] },
  ]);
});
