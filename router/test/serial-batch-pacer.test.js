const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialBatchPacer } = require('../serial-batch-pacer');

test('paces burst-delivered serial batches from source timestamps', () => {
  const scheduled = [];
  const delivered = [];
  let now = 1_000;
  const pacer = new SerialBatchPacer(batch => delivered.push(batch.packetSequence), {
    startupBufferMs: 200,
    now: () => now,
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    cancel: () => {}
  });
  pacer.push({ packetSequence: 1, sendTimeUs: 1_000_000 });
  pacer.push({ packetSequence: 2, sendTimeUs: 1_063_000 });
  pacer.push({ packetSequence: 3, sendTimeUs: 1_126_000 });

  assert.equal(scheduled[0].delay, 200);
  now += scheduled[0].delay;
  scheduled.shift().fn();
  assert.deepEqual(delivered, [1]);
  assert.equal(scheduled[0].delay, 63);
  now += scheduled[0].delay;
  scheduled.shift().fn();
  assert.deepEqual(delivered, [1, 2]);
  assert.equal(scheduled[0].delay, 63);
});

test('does not accumulate callback delay into the source timeline', () => {
  const scheduled = [];
  const delivered = [];
  let now = 0;
  const pacer = new SerialBatchPacer(batch => delivered.push(batch.packetSequence), {
    startupBufferMs: 200,
    now: () => now,
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    cancel: () => {}
  });
  for (let sequence = 1; sequence <= 3; sequence++) {
    pacer.push({ packetSequence: sequence, sendTimeUs: 1_000_000 + (sequence - 1) * 63_000 });
  }

  now = 225;
  scheduled.shift().fn();
  assert.deepEqual(delivered, [1]);
  assert.equal(scheduled[0].delay, 38);
  now = 270;
  scheduled.shift().fn();
  assert.deepEqual(delivered, [1, 2]);
  assert.equal(scheduled[0].delay, 56);
});

test('reports queue-boundary delivery and loss counters', () => {
  const pacer = new SerialBatchPacer(() => {}, {
    maxQueue: 2,
    schedule: () => 1,
    cancel: () => {}
  });
  pacer.push({ packetSequence: 1, sendTimeUs: 1_000_000 });
  pacer.push({ packetSequence: 2, sendTimeUs: 1_063_000 });
  pacer.push({ packetSequence: 3, sendTimeUs: 1_126_000 });
  assert.deepEqual(pacer.status(), {
    received: 3, delivered: 0, dropped: 1, resets: 0, maxDepth: 2, queueDepth: 2
  });
});

test('resets queued timing when a device timestamp restarts', () => {
  const scheduled = [];
  const pacer = new SerialBatchPacer(() => {}, {
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    cancel: () => {}
  });
  pacer.push({ packetSequence: 50, sendTimeUs: 5_000_000 });
  pacer.push({ packetSequence: 1, sendTimeUs: 100_000 });
  assert.equal(pacer.queue.length, 1);
  assert.equal(pacer.queue[0].packetSequence, 1);
});
