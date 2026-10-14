'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResidentStreamRegistry } = require('../ResidentStreamRegistry');

function fakeRegistry({ interpolationFor = () => 'linear', staleAfterSeconds = 300 } = {}) {
  const analyzed = [];
  const tracked = [];
  return {
    analyzed,
    tracked,
    registry: new ResidentStreamRegistry({
      interpolationFor,
      staleAfterSeconds,
      createBuffer: () => ({
        samples: [],
        size: 0,
        lastTimestampUs: null,
        push(timestampUs, value, sequence) {
          this.samples.push({ timestampUs, value, sequence });
          this.size = this.samples.length;
          this.lastTimestampUs = timestampUs;
        },
        pushBatch(samples) {
          for (const [sequence, timestampUs, value] of samples) this.push(timestampUs, value, sequence);
        },
      }),
      createAnalyzer: () => ({
        analyze(buffer, options) {
          analyzed.push({ buffer, options });
          return {
            ready: true,
            reason: null,
            coverage: 1,
            candidates: [{ frequencyHz: 0.5, periodSeconds: 2, strength: 3, excessRatio: 4, phase: 0.2 }],
          };
        },
      }),
      createTracker: () => ({
        update(candidates, options) {
          tracked.push({ candidates, options });
          return [{ id: 1, active: true, frequencyHz: candidates[0].frequencyHz }];
        },
        snapshot() { return []; },
      }),
    }),
  };
}

test('creates one independent pipeline per numeric stream', () => {
  const { registry } = fakeRegistry();
  assert.equal(registry.ingest('osc/electric-sky/temperature', 1_000_000, 20, 1), true);
  assert.equal(registry.ingest('midi/MPK/ch1/cc73', 1_000_000, 64, 2), true);
  assert.equal(registry.ingest('osc/electric-sky/temperature', 2_000_000, 21, 3), true);

  assert.equal(registry.size, 2);
  assert.equal(registry.snapshot('osc/electric-sky/temperature').sampleCount, 2);
  assert.equal(registry.snapshot('osc/electric-sky/temperature').value, 21);
  assert.equal(registry.snapshot('midi/MPK/ch1/cc73').sampleCount, 1);
});

test('ignores non-finite samples instead of creating streams', () => {
  const { registry } = fakeRegistry();
  assert.equal(registry.ingest('osc/test', 1_000_000, Number.NaN), false);
  assert.equal(registry.ingest('osc/test', Number.NaN, 1), false);
  assert.equal(registry.size, 0);
});

test('publishes resident voice messages and forwards interpolation mode', () => {
  const { registry, analyzed, tracked } = fakeRegistry({
    interpolationFor: streamId => streamId.startsWith('midi/') ? 'hold' : 'linear',
  });
  registry.ingest('midi/MPK/ch1/cc73', 2_000_000, 64, 1);

  const messages = registry.analyzeAll({ nowTimestampUs: 2_000_000 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'resident_voices');
  assert.equal(messages[0].device, 'midi/MPK/ch1/cc73');
  assert.equal(messages[0].value, 64);
  assert.equal(messages[0].interpolation, 'hold');
  assert.equal(messages[0].ready, true);
  assert.deepEqual(messages[0].voices, [{ id: 1, active: true, frequencyHz: 0.5 }]);
  assert.equal(analyzed[0].options.interpolation, 'hold');
  assert.equal(tracked[0].options.timestampUs, 2_000_000);
});

test('staggers analysis across streams in round-robin order', () => {
  const { registry, analyzed } = fakeRegistry();
  registry.ingest('osc/a', 2_000_000, 1);
  registry.ingest('osc/b', 2_000_000, 2);

  assert.equal(registry.analyzeNext({ nowTimestampUs: 2_000_000 }).device, 'osc/a');
  assert.equal(registry.analyzeNext({ nowTimestampUs: 2_000_000 }).device, 'osc/b');
  assert.equal(registry.analyzeNext({ nowTimestampUs: 2_000_000 }).device, 'osc/a');
  assert.equal(analyzed.length, 2);
});

test('ingests timestamped router batches', () => {
  const { registry } = fakeRegistry();
  const count = registry.ingestBatch('osc/electric-sky/temperature', [
    [1, 1_000_000, 20],
    [2, 2_000_000, 21],
    [3, 3_000_000, Number.NaN],
  ]);

  assert.equal(count, 2);
  assert.equal(registry.snapshot('osc/electric-sky/temperature').sampleCount, 2);
  assert.equal(registry.snapshot('osc/electric-sky/temperature').value, 21);
});

test('recovers when one malformed batch jumps to an impossible timestamp', () => {
  const { registry } = fakeRegistry();
  registry.ingestBatch('osc/indoor-sky/temperature', [[1, 5_000_000, 21]], 10_000_000);
  registry.ingestBatch('osc/indoor-sky/temperature', [[2, 18_000_000_000_000_000_000, -1e9]], 11_000_000);
  registry.ingestBatch('osc/indoor-sky/temperature', [[3, 5_020_000, 22]], 12_000_000);

  const snapshot = registry.snapshot('osc/indoor-sky/temperature');
  assert.equal(snapshot.sampleCount, 1);
  assert.equal(snapshot.lastTimestampUs, 5_020_000);
  assert.equal(snapshot.value, 22);
});

test('removes streams after the configured inactive interval', () => {
  const { registry } = fakeRegistry({ staleAfterSeconds: 5 });
  registry.ingest('osc/test', 1_000_000, 1, null, 1_000_000);

  const messages = registry.analyzeAll({ nowTimestampUs: 7_000_000 });
  assert.equal(messages[0].reason, 'stale');
  assert.equal(messages[0].ready, false);
  assert.deepEqual(messages[0].voices, []);
  assert.equal(registry.size, 0);
});

test('explicitly removes an unavailable stream', () => {
  const { registry } = fakeRegistry();
  registry.ingest('osc/test', 1_000_000, 1);
  assert.equal(registry.remove('osc/test'), true);
  assert.equal(registry.snapshot('osc/test'), null);
});

test('repeated source frames do not advance confidence; unavailable streams retain latest state', () => {
  const { registry, tracked } = fakeRegistry();
  registry.ingest('osc/test/value', 100, 1);
  registry.analyzeNext();
  registry.analyzeNext();
  assert.equal(tracked.length, 1);
  registry.remove('osc/test/value', 'idle');
  assert.equal(registry.analyzeNext().reason, 'idle');
  assert.equal(registry.latest.get('osc/test/value').ready, false);
  registry.ingest('osc/test/value', 200, 2);
  assert.equal(registry.analyzeNext().ready, true);
});

test('readiness loss clears voices and recovered tracks keep increasing IDs', () => {
  let ready = true;
  const registry = new ResidentStreamRegistry({
    createAnalyzer: () => ({ analyze: () => ({ ready, reason: ready ? null : 'coverage', coverage: ready ? 1 : 0,
      candidates: [{ frequencyHz: 0.5, strength: 1, phase: 0, excessRatio: 4 }] }) }),
  });
  registry.ingest('osc/test/value', 100, 1);
  const first = registry.analyzeNext().voices[0].id;
  ready = false;
  registry.ingest('osc/test/value', 200, 1);
  assert.deepEqual(registry.analyzeNext().voices, []);
  ready = true;
  registry.ingest('osc/test/value', 300, 1);
  const second = registry.analyzeNext().voices[0].id;
  assert.ok(second > first);
  registry.remove('osc/test/value'); registry.drainPending();
  registry.ingest('osc/test/value', 400, 1);
  assert.ok(registry.analyzeNext().voices[0].id > second);
});
