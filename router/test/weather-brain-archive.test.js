const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WeatherBrainArchive, createArchive, postBatch } = require('../weather-brain-archive');

const epoch = Date.parse('2026-09-28T12:00:00Z');
function fixture(options = {}) {
  let now = epoch;
  const sent = [], logs = [];
  const archive = new WeatherBrainArchive({ baseUrl: 'http://localhost:8000', token: 'test-token',
    now: () => now, post: async (url, token, body) => sent.push(structuredClone(body)),
    log: text => logs.push(text), ...options });
  return { archive, sent, logs, time: ms => { now = epoch + ms; } };
}
function signal(value, overrides = {}) {
  return { type: 'osc', name: 'electric-sky', param: 'temperature', unit: 'celsius', value, ...overrides };
}
function sampleBatch(samples, overrides = {}) {
  return { type: 'sample_batch', source: '192.168.0.2', sendTimeUs: 1000000,
    streams: [{ name: 'electric-sky', param: 'temperature', unit: 'celsius', samples }], ...overrides };
}

test('Welford summaries use actual count and population standard deviation', async () => {
  const f = fixture();
  for (const value of [2, 4, 4, 4, 5, 5, 7, 9]) f.archive.observe(signal(value));
  f.time(10000); await f.archive.tick();
  assert.deepEqual(f.sent[0], { node_id: 'electric-sky', buckets: [{
    signal_id: 'temperature', unit: 'celsius', bucket_start: '2026-09-28T12:00:00.000Z',
    mean: 5, min: 2, max: 9, sample_count: 8, stddev: 2
  }] });
});

test('sensor clock retains boundary placement despite packet arrival jitter', async () => {
  const f = fixture();
  f.archive.observe(sampleBatch([[0, 1000000, 1]]));
  f.time(1700);
  f.archive.observe(sampleBatch([[1, 1999000, 3], [2, 2000000, 9]], { sendTimeUs: 2100000 }));
  f.time(10000); await f.archive.tick();
  const rows = f.sent[0].buckets;
  assert.deepEqual(rows.map(r => [r.bucket_start, r.sample_count, r.mean]), [
    ['2026-09-28T12:00:00.000Z', 2, 2], ['2026-09-28T12:00:01.000Z', 1, 9]
  ]);
});

test('USB clock follows gradual device drift without dropping the stream', async () => {
  const f = fixture();
  for (let packet = 0; packet < 100; packet++) {
    f.time(packet * 100);
    const sendTimeUs = 1_000_000 + packet * 101_000;
    f.archive.observe(sampleBatch([[packet, sendTimeUs, packet]], {
      transport: 'usb', sendTimeUs
    }));
  }
  f.time(20000); await f.archive.tick();
  assert.equal(f.logs.some(line => line.includes('late/future sample')), false);
  assert.equal(f.sent[0].buckets.reduce((count, row) => count + row.sample_count, 0), 100);
});

test('Indoor USB is archived before presentation pacing and not archived twice', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /weatherBrainArchive\.observe\(batch\);\s*indoorSerialPacer\.push\(batch\)/);
  assert.match(source, /broadcastSampleBatch\(batch, buildScalarBatchOsc\(batch\), false\)/);
});

test('ten-second transport batches retain individual seconds, nodes and features', async () => {
  const f = fixture();
  for (let second = 0; second < 10; second++) {
    f.time(second * 1000);
    f.archive.observe({ type: 'signal_batch', signals: [signal(second),
      signal(20, { name: 'indoor-sky' }), signal(0.3, { param: 'bass', unit: 'normalized-energy' })] });
    await f.archive.tick();
  }
  assert.equal(f.sent.length, 0);
  f.time(10000); await f.archive.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].node_id, 'electric-sky');
  assert.equal(f.sent[0].buckets.length, 16); // last two seconds still in lateness window
  assert.equal(f.sent[1].buckets.length, 8);
  assert.equal(new Set(f.sent[0].buckets.map(r => r.bucket_start)).size, 8);
  assert.equal(f.sent[0].buckets.filter(r => r.signal_id === 'bass').length, 8);
});

test('failed request retries identical body with bounded backoff', async () => {
  const attempts = [];
  let fail = true;
  const f = fixture({ post: async (url, token, body) => {
    attempts.push(JSON.stringify(body)); if (fail) throw new Error('offline');
  } });
  f.archive.observe(signal(3)); f.time(10000); await f.archive.tick();
  f.time(10500); await f.archive.tick(); assert.equal(attempts.length, 1);
  f.time(11000); await f.archive.tick(); assert.equal(attempts.length, 2);
  assert.equal(f.archive.retryAt, epoch + 13000);
  fail = false; f.time(13000); await f.archive.tick();
  assert.equal(attempts[0], attempts[1]); assert.equal(attempts[1], attempts[2]);
  assert.equal(f.archive.queue.length, 0);
  assert.equal(f.archive.pending, null);
});

test('queue and active statistics remain bounded during prolonged outage', async () => {
  const f = fixture({ maxRecords: 3, post: async () => { throw new Error('offline'); } });
  for (let second = 0; second < 150; second++) {
    f.time(second * 1000); f.archive.observe(signal(second)); await f.archive.tick();
    assert.ok(f.archive.queue.length + f.archive.active.size <= 3);
    assert.ok(f.archive.retryAt - (epoch + second * 1000) <= 60000);
  }
  assert.ok(f.logs.some(line => line.includes('queue full')));
  assert.equal(f.archive.pending.body.buckets[0].bucket_start, '2026-09-28T12:00:00.000Z');
});

test('finalized seconds cannot be reopened, gaps are not filled', async () => {
  const f = fixture();
  f.archive.observe(sampleBatch([[0, 1000000, 2]]));
  f.time(10000); await f.archive.tick();
  f.archive.observe(sampleBatch([[0, 1000000, 90]]));
  f.time(20000); await f.archive.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.archive.active.size, 0);
});

test('unit conflicts, nonnumeric values, PCM, MIDI, capabilities are excluded', async () => {
  const f = fixture();
  f.archive.observe(signal(2));
  f.archive.observe(signal(90, { unit: 'fahrenheit' }));
  for (const value of [NaN, Infinity, null, '4', [1, 2]]) f.archive.observe(signal(value));
  for (const type of ['pcm', 'midi', 'audio_capability']) f.archive.observe(signal(99, { type }));
  f.archive.observe(Buffer.from([1, 2, 3]));
  f.time(10000); await f.archive.tick();
  assert.equal(f.sent[0].buckets[0].sample_count, 1);
  assert.equal(f.sent[0].buckets[0].stddev, 0);
  assert.ok(f.logs.some(line => line.includes('unit conflict')));
});

test('clock state is bounded and reboot waits for inactivity before reanchoring', () => {
  const f = fixture({ maxClocks: 1 });
  f.archive.observe(sampleBatch([[0, 100000000, 2]], { sendTimeUs: 100000000 }));
  f.time(1000);
  f.archive.observe(sampleBatch([[1, 1000000, 8]]));
  assert.equal(f.archive.active.size, 1);
  f.time(31000); f.archive.observe(sampleBatch([[2, 2000000, 8]], { sendTimeUs: 2000000 }));
  assert.equal(f.archive.active.size, 2);
  f.archive.observe(sampleBatch([[0, 1000000, 9]], { source: 'other' }));
  assert.equal(f.archive.clocks.size, 1);
});

test('archive ingestion does not await outstanding HTTP or mutate normalized messages', async () => {
  let finish;
  const f = fixture({ post: () => new Promise(resolve => { finish = resolve; }) });
  const message = sampleBatch([[0, 1000000, 2]]);
  const original = structuredClone(message);
  f.archive.observe(message); f.time(10000);
  const flushing = f.archive.tick();
  f.archive.observe(signal(5));
  assert.equal(f.archive.active.size, 1);
  await f.archive.tick(); // no second concurrent HTTP request
  assert.deepEqual(message, original);
  finish(); await flushing;
});

test('Unix microsecond timestamps are used directly and disabled config is inert', async () => {
  const f = fixture();
  f.time(500);
  f.archive.observe(signal(4, { timeUs: epoch * 1000 }));
  f.time(10000); await f.archive.tick();
  assert.equal(f.sent[0].buckets[0].bucket_start, new Date(epoch).toISOString());
  assert.doesNotThrow(() => createArchive({}).observe(null));
});

test('HTTP transport matches route, authentication and JSON contract; timeout is bounded', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, token: req.headers['x-ingest-token'], body: JSON.parse(data) });
      if (req.url === '/hang') return;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, accepted: 1, inserted: 0, duplicates: 1 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { node_id: 'electric-sky', buckets: [{ bucket_start: new Date(epoch).toISOString() }] };
  await postBatch(new URL(`${base}/ingest/signal-buckets`), 'test-token', body, 1000);
  assert.deepEqual(requests[0], { path: '/ingest/signal-buckets', token: 'test-token', body });
  await assert.rejects(postBatch(new URL(`${base}/hang`), 'test-token', body, 30), /timeout/);
});
