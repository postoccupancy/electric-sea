'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ingestRouterMessage, midiStreamId } = require('../resident-live');

function fakeRegistry() {
  return {
    calls: [],
    ingest(...args) { this.calls.push(['ingest', ...args]); return true; },
    ingestBatch(...args) { this.calls.push(['batch', ...args]); return args[1].length; },
  };
}

test('builds stable MIDI stream identifiers', () => {
  assert.equal(midiStreamId({ device: 'controller', msgType: 'cc', channel: 2, cc: 7 }), 'controller/ch2/cc7');
  assert.equal(midiStreamId({ device: 'controller', msgType: 'pitchbend', channel: 3 }), 'controller/ch3/pb');
  assert.equal(midiStreamId({ device: 'controller', msgType: 'noteon', channel: 1 }), null);
});

test('ingests every stream in a timestamped sample batch', () => {
  const registry = fakeRegistry();
  const values = [];
  const count = ingestRouterMessage(registry, {
    type: 'sample_batch',
    streams: [
      { device: 'osc/sky/temp', samples: [[1, 10, 20], [2, 20, 21]] },
      { name: 'sky', param: 'humidity', samples: [[1, 10, 50]] },
    ],
  }, 999, (device, value) => values.push([device, value]));

  assert.equal(count, 3);
  assert.deepEqual(registry.calls, [
    ['batch', 'osc/sky/temp', [[1, 10, 20], [2, 20, 21]]],
    ['batch', 'osc/sky/humidity', [[1, 10, 50]]],
  ]);
  assert.deepEqual(values, [
    ['osc/sky/temp', 21],
    ['osc/sky/humidity', 50],
  ]);
});

test('ingests scalar OSC and MIDI values', () => {
  const registry = fakeRegistry();
  const values = [];
  assert.equal(ingestRouterMessage(registry, {
    type: 'osc', device: 'osc/source/value', timeUs: 123, sequence: 4, value: 0.5,
  }, 999, (device, value) => values.push([device, value])), 1);
  assert.equal(ingestRouterMessage(registry, {
    type: 'midi', device: 'controller', msgType: 'cc', channel: 1, cc: 74, value: 64,
  }, 999), 1);

  assert.deepEqual(registry.calls, [
    ['ingest', 'osc/source/value', 123, 0.5, 4],
    ['ingest', 'controller/ch1/cc74', 999, 64],
  ]);
  assert.deepEqual(values, [['osc/source/value', 0.5]]);
});

test('recursively ingests signal batches and ignores notes', () => {
  const registry = fakeRegistry();
  const count = ingestRouterMessage(registry, {
    type: 'signal_batch',
    signals: [
      { type: 'json', device: 'json/lfo', value: 0.2 },
      { type: 'midi', device: 'keys', msgType: 'noteon', channel: 1, note: 60, velocity: 100 },
    ],
  }, 500);

  assert.equal(count, 1);
  assert.deepEqual(registry.calls, [['ingest', 'json/lfo', 500, 0.2, undefined]]);
});

test('sidecar analyzes with no consumers, replays state and recovers from router loss', async t => {
  const { WebSocketServer, WebSocket } = require('ws');
  const { once } = require('node:events');
  const { startResidentLive } = require('../resident-live');
  const { ResidentStreamRegistry } = require('../ResidentStreamRegistry');
  const router = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(router, 'listening');
  const registry = new ResidentStreamRegistry({
    analyzerOptions: { windowSeconds: 2, minPeriodSeconds: 0.2, maxPeriodSeconds: 1, minCompletedCycles: 0 },
  });
  const connection = once(router, 'connection');
  const live = startResidentLive({ routerUrl: `ws://127.0.0.1:${router.address().port}`, port: 0, analysisIntervalMs: 20, registry });
  t.after(() => { live.close(); for (const ws of router.clients) ws.terminate(); router.close(); });
  const [source] = await connection;
  const samples = Array.from({ length: 61 }, (_, i) => [i, i * 50000, Math.sin(i / 3)]);
  source.send(JSON.stringify({ type: 'sample_batch', streams: [{ device: 'osc/test/value', samples }] }));
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for state');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await waitFor(() => live.latest.get('osc/test/value')?.ready);
  assert.equal(live.latest.get('osc/test/value').timestampUs, 3000000);
  const client = new WebSocket(`ws://127.0.0.1:${live.server.address().port}`);
  t.after(() => client.terminate());
  const [raw] = await once(client, 'message');
  assert.equal(JSON.parse(raw).ready, true);
  client.close();
  await once(client, 'close');
  assert.equal(source.readyState, WebSocket.OPEN);
  const reconnected = once(router, 'connection');
  source.close();
  await waitFor(() => live.latest.get('osc/test/value')?.reason === 'router-disconnected');
  const [nextSource] = await reconnected;
  nextSource.send(JSON.stringify({ type: 'sample_batch', streams: [{ device: 'osc/test/value', samples }] }));
  await waitFor(() => live.latest.get('osc/test/value')?.ready);
});
