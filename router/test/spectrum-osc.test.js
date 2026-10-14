'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamBuffer } = require('../StreamBuffer');
const { lowPassDecimate, fillMissingLinear } = require('../ResidentAnalyzer');
const { ResidentStreamRegistry } = require('../ResidentStreamRegistry');
const { computeCwt, summarizeCwt } = require('../cwt');
const { SpectrumOsc, spectrumConfig, MAX_PACKET_BYTES } = require('../spectrum-osc');
const { VoiceOsc } = require('../voice-osc');
const { parseOSCPacket } = require('../osc-codec');

function frame({ count = 48, ...overrides } = {}) {
  return {
    type: 'resident_voices', device: 'osc/indoor-sky/temperature',
    timestampUs: 1791900000123456, ready: true, reason: null, coverage: 1, voices: [],
    spectrum: { epoch: 'source-a', frame: 1,
      scales: Array.from({ length: count }, (_, i) => [20 ** (-i / (count - 1)), 0.125 + i, -0.1 * (i % 10), 0.25 + i / 100]) },
    ...overrides,
  };
}
const decode = packets => packets.flatMap(parseOSCPacket);
const advance = (message, sequence) => ({ ...message, spectrum: { ...message.spectrum, frame: sequence } });

// Reference consumer: accept a frame only after every scale arrives. Chunks may
// arrive reordered or duplicated; never combine different epoch/frame keys.
function reassemble(packets) {
  const frames = new Map();
  for (const { address, args } of decode(packets)) {
    const [version, epoch, sequence, timestamp, ready, reason, total, offset, count] = args;
    const key = JSON.stringify([address, epoch, sequence]);
    const metadata = JSON.stringify([version, timestamp, ready, reason, total]);
    if (!frames.has(key)) frames.set(key, { metadata, scales: new Map(), total });
    const result = frames.get(key);
    assert.equal(version, 3);
    assert.equal(result.metadata, metadata);
    assert.equal(args.length, 9 + count * 6);
    for (let i = 0; i < count; i++) result.scales.set(offset + i, args.slice(9 + i * 6, 15 + i * 6));
  }
  return [...frames.values()].filter(result => result.scales.size === result.total)
    .map(result => [...result.scales].sort(([a], [b]) => a - b).map(([, scale]) => scale));
}

test('default spectrum fits two bounded packets with explicit types, stable scale order and exact timestamp', () => {
  const publisher = new SpectrumOsc({ enabled: true });
  const source = frame();
  const packets = publisher.update(source);
  assert.equal(packets.length, 2);
  assert.deepEqual(packets.map(packet => packet.length), [1188, 528]);
  assert.ok(packets[0].length <= MAX_PACKET_BYTES);
  assert.ok(packets[0].includes(Buffer.from(',isddisiii' + 'fffifi'.repeat(35))));
  const [{ address, args }] = decode(packets);
  assert.equal(address, '/osc/indoor-sky/temperature/cwt/spectrum');
  assert.deepEqual([args[0], ...args.slice(2, 9)], [3, 1, source.timestampUs, 1, '', 48, 0, 35]);
  assert.match(args[1], /^[a-f\d-]{36}$/);
  assert.deepEqual(reassemble(packets)[0], source.spectrum.scales.map(([frequency, magnitude, phase, bg]) => [Math.fround(frequency), Math.fround(magnitude), Math.fround(phase), 1, Math.fround(bg), 1]));
});

test('larger spectra chunk below the datagram budget and reassemble without mixing frames', () => {
  let now = 0;
  const publisher = new SpectrumOsc({ enabled: true, now: () => now });
  const source = frame({ count: 256 });
  source.spectrum.scales.forEach((scale, i) => { if (i % 3 === 0) scale[2] = null; });
  const first = publisher.update(source);
  assert.ok(first.length > 1);
  assert.ok(first.every(packet => packet.length <= MAX_PACKET_BYTES));
  now = 1000;
  const second = publisher.update(advance(source, 2));
  const mixed = [first[0], ...second.slice().reverse(), ...first.slice(1).reverse(), first[0]];
  const expected = source.spectrum.scales.map(([frequency, magnitude, phase, bg]) => [
    Math.fround(frequency), Math.fround(magnitude), phase === null ? 0 : Math.fround(phase), phase === null ? 0 : 1, Math.fround(bg), 1,
  ]);
  assert.deepEqual(reassemble(mixed), [expected, expected]);
  assert.deepEqual(reassemble(first.slice(1)), []);
  const changedTimestamp = decode(second)[0].args[3];
  assert.equal(changedTimestamp, source.timestampUs);
});

test('disabled output, strict config, duplicate suppression and per-stream rate limiting', () => {
  assert.deepEqual(spectrumConfig({}), { enabled: false, minIntervalMs: 1000 });
  assert.deepEqual(spectrumConfig({ CWT_SPECTRUM_OSC_ENABLED: '1', CWT_SPECTRUM_OSC_INTERVAL_MS: '5000' }),
    { enabled: true, minIntervalMs: 5000 });
  for (const value of ['NaN', '0', '-1', '999']) assert.throws(() => spectrumConfig({ CWT_SPECTRUM_OSC_INTERVAL_MS: value }));
  assert.throws(() => spectrumConfig({ CWT_SPECTRUM_OSC_ENABLED: 'yes' }));
  assert.deepEqual(new SpectrumOsc().update(frame()), []);
  let now = 0;
  const publisher = new SpectrumOsc({ enabled: true, minIntervalMs: 5000, now: () => now });
  const source = frame();
  assert.equal(publisher.update(source).length, 2);
  now = 1000;
  assert.deepEqual(publisher.update(advance(source, 2)), []);
  now = 6000;
  assert.deepEqual(publisher.update(advance(source, 2)), [], 'no delayed resend of cached results');
  assert.equal(publisher.update(advance(source, 3)).length, 2);
  assert.equal(publisher.update({ ...source, device: 'osc/indoor-sky/rms' }).length, 2);
});

test('one, several, zero-magnitude and all unavailable phases preserve complete magnitudes', () => {
  for (const missing of [[1], [0, 3, 47], Array.from({ length: 48 }, (_, i) => i)]) {
    const source = frame();
    for (const i of missing) source.spectrum.scales[i][2] = null;
    source.spectrum.scales[missing[0]][1] = 0;
    const packets = new SpectrumOsc({ enabled: true }).update(source);
    const [{ args }] = decode(packets);
    assert.deepEqual(args.slice(4, 9), [1, '', 48, 0, 35]);
    const scales = reassemble(packets)[0];
    assert.equal(scales.length, 48);
    for (let i = 0; i < 48; i++) {
      const [frequency, magnitude, phase, bg] = source.spectrum.scales[i];
      assert.deepEqual(scales[i], [Math.fround(frequency), Math.fround(magnitude),
        missing.includes(i) ? 0 : Math.fround(phase), missing.includes(i) ? 0 : 1, Math.fround(bg), 1]);
    }
  }
});

test('unavailable numeric phases have explicit flags and finite placeholders; real zero phase stays valid', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, 1e100, -4, 4]) {
    const source = frame();
    source.spectrum.scales[0][2] = value;
    source.spectrum.scales[1][2] = 0;
    const packets = new SpectrumOsc({ enabled: true }).update(source);
    const [{ args }] = decode(packets);
    assert.equal(args[4], 1);
    assert.equal(args[5], '');
    assert.deepEqual(reassemble(packets)[0][0], [1, 0.125, 0, 0, 0.25, 1]);
    assert.equal(reassemble(packets)[0][1][3], 1);
    assert.ok(args.filter(value => typeof value === 'number').every(Number.isFinite));
  }
});

test('invalid frequency, magnitude, structure and timestamp still invalidate frames', () => {
  const invalids = [
    [], [[0, 1, null]], [[-1, 1, null]], [[1, -1, null]],
    [[1, 1, null], [2, 1, null]], [[1, 1, null], [1, 1, null]],
    [[1, 1, '0']], [[1, 1, {}]], [[1, 1, false]], [[1, 1]], [[1, 1, null, 0, 0]], [[1, 1, null, "background"]],
    [null], [1], 'scales', null,
  ];
  for (const value of [undefined, null, NaN, Infinity, -Infinity, 1e100, '1', false]) {
    invalids.push([[value, 1, null]], [[1, value, null]]);
  }
  invalids.push([[1e-100, 1, null]]);
  for (const scales of invalids) {
    const source = frame(); source.spectrum.scales = scales;
    const [{ args }] = decode(new SpectrumOsc({ enabled: true }).update(source));
    assert.equal(args[0], 3);
    assert.equal(args[4], 0);
    assert.ok(args[5]);
    assert.deepEqual(args.slice(6), [0, 0, 0]);
    assert.ok(args.filter(value => typeof value === 'number').every(Number.isFinite));
  }
  assert.equal(decode(new SpectrumOsc({ enabled: true }).update(frame({ timestampUs: NaN })))[0].args[3], -1);
});

test('phase availability changes keep the epoch and obey the existing publication interval', () => {
  let now = 0;
  const publisher = new SpectrumOsc({ enabled: true, minIntervalMs: 5000, now: () => now });
  const source = frame();
  const initial = decode(publisher.update(source))[0].args;
  const missing = advance(source, 2);
  missing.spectrum.scales = source.spectrum.scales.map(([f, m]) => [f, m, null]);
  now = 1000;
  assert.deepEqual(publisher.update(missing), [], 'phase loss is not magnitude invalidation');
  now = 5000;
  const packets = publisher.update(advance(missing, 3));
  const next = decode(packets)[0].args;
  assert.equal(next[1], initial[1]);
  assert.equal(next[2], initial[2] + 1);
  assert.equal(next[3], initial[3]);
  assert.equal(next[4], 1);
  assert.ok(reassemble(packets)[0].every(scale => scale[3] === 0));
});

test('readiness transitions bypass throttling; source and router resets get distinct epochs', () => {
  const publisher = new SpectrumOsc({ enabled: true, minIntervalMs: 5000, now: () => 0 });
  const source = frame();
  const initial = decode(publisher.update(source))[0].args;
  const down = decode(publisher.update({ ...source, ready: false, reason: 'analyzer-disconnected' }))[0].args;
  assert.equal(down[1], initial[1]);
  assert.equal(down[2], initial[2] + 1);
  assert.equal(down[3], initial[3]);
  assert.equal(down[4], 0);
  assert.deepEqual(publisher.update({ ...advance(source, 2), ready: false, reason: 'analyzer-disconnected' }), []);
  const recovered = decode(publisher.update(advance(source, 3)))[0].args;
  assert.equal(recovered[4], 1);
  const reset = decode(publisher.update({ ...source, spectrum: { ...source.spectrum, epoch: 'source-b' } }))[0].args;
  assert.notEqual(reset[1], initial[1]);
  assert.equal(reset[2], 1);
  const routerReset = decode(new SpectrumOsc({ enabled: true }).update(source))[0].args;
  assert.notEqual(routerReset[1], initial[1]);
});

test('synthetic oscillations publish the existing per-scale CWT reduction, not tracker output', () => {
  const registry = new ResidentStreamRegistry();
  const stream = 'osc/test/temperature';
  const samples = Array.from({ length: 2401 }, (_, i) => {
    const time = i / 40;
    return [i, 1_000_000 + time * 1e6, Math.sin(2 * Math.PI * 0.2 * time) + 0.7 * Math.sin(2 * Math.PI * 0.7 * time)];
  });
  registry.ingestBatch(stream, samples);
  const message = registry.analyzeNext();
  const buffer = new StreamBuffer(); buffer.pushBatch(samples);
  const input = buffer.resample({ sampleRate: 20, durationSeconds: 60, endTimestampUs: buffer.lastTimestampUs });
  const decimated = lowPassDecimate(input.values, input.valid, 4);
  const cwt = computeCwt(fillMissingLinear(decimated.values), { sampleRate: 5, minPeriodSeconds: 1, maxPeriodSeconds: 20, numScales: 48 });
  const scales = summarizeCwt(cwt, { recentFraction: 0.25 });
  assert.equal(message.ready, true);
  assert.equal(message.timestampUs, buffer.lastTimestampUs);
  assert.equal(message.spectrum.scales.length, 48);
  assert.deepEqual(message.spectrum.scales, scales.map(scale => [scale.frequencyHz, Math.sqrt(scale.recentPower), scale.phase, scale.backgroundPower]));
  // Independently reduce the exact same coefficients to check magnitude/phase pairing.
  for (let i = 0; i < 48; i++) {
    const start = Math.floor(cwt.sampleCount * 0.75);
    let power = 0, x = 0, y = 0;
    for (let t = start; t < cwt.sampleCount; t++) {
      const p = cwt.power[i][t]; power += p;
      x += p * Math.cos(cwt.phase[i][t]); y += p * Math.sin(cwt.phase[i][t]);
    }
    assert.equal(message.spectrum.scales[i][1], Math.sqrt(power / (cwt.sampleCount - start)));
    assert.equal(message.spectrum.scales[i][2], Math.atan2(y, x));
  }
  const peaks = scales.filter((scale, i) => i > 0 && i < 47
    && scale.recentPower > scales[i - 1].recentPower && scale.recentPower > scales[i + 1].recentPower);
  for (const expected of [0.2, 0.7]) assert.ok(peaks.some(scale => Math.abs(scale.frequencyHz - expected) < 0.07));
  const packets = new SpectrumOsc({ enabled: true }).update(message);
  assert.deepEqual(reassemble(packets)[0], message.spectrum.scales.map(([frequency, magnitude, phase, bg]) => [Math.fround(frequency), Math.fround(magnitude), Math.fround(phase), 1, Math.fround(bg), 1]));
  assert.equal(registry.analyzeNext(), message, 'cached analysis keeps same frame identity');
  registry.remove(stream, 'idle');
  const idle = registry.analyzeNext();
  assert.equal(idle.spectrum.epoch, message.spectrum.epoch);
  assert.ok(idle.spectrum.frame > message.spectrum.frame);
  registry.ingestBatch(stream, samples);
  assert.notEqual(registry.analyzeNext().spectrum.epoch, message.spectrum.epoch);
});

test('constant input publishes all zero magnitudes with explicit unavailable phases', () => {
  const registry = new ResidentStreamRegistry();
  registry.ingestBatch('osc/test/value', Array.from({ length: 1201 }, (_, i) => [i, i * 50000, 20]));
  const message = registry.analyzeNext();
  assert.equal(message.ready, true, 'voice analysis readiness stays unchanged');
  assert.ok(message.spectrum.scales.every(([, magnitude, phase]) => magnitude === 0 && phase === null));
  const packets = new SpectrumOsc({ enabled: true }).update(message);
  const [{ args }] = decode(packets);
  assert.deepEqual(args.slice(4, 9), [1, '', 48, 0, 35]);
  assert.ok(reassemble(packets)[0].every(([, magnitude, phase, valid, bg, bgValid]) => magnitude === 0 && phase === 0 && valid === 0 && bg === 0 && bgValid === 0));
});

test('spectrum metadata and publishing do not change existing voice packets', () => {
  const source = frame({ voices: [{ id: 7, frequencyHz: 0.125, strength: 3, phase: 0.25,
    confidence: 0.8, active: true, lastTimestampUs: 1791900000123456 }] });
  const { spectrum, ...legacy } = source;
  const before = new VoiceOsc().update(legacy);
  new SpectrumOsc({ enabled: true }).update(source);
  const after = new VoiceOsc().update(source);
  assert.deepEqual(after, before);
  assert.equal(decode(after)[0].address, '/osc/indoor-sky/temperature/cwt/voice/7');
  assert.equal(decode(after)[1].address, '/osc/indoor-sky/temperature/cwt/voices');
  assert.deepEqual(new SpectrumOsc({ enabled: true }).update(legacy), []);
});

test('background validity is independent of magnitude/phase and survives float32 boundaries', () => {
  for (const background of [null, undefined, 0, -1, NaN, Infinity, -Infinity, 1e100, 1e-100]) {
    const source = frame();
    source.spectrum.scales[0][3] = background;
    source.spectrum.scales[1] = [source.spectrum.scales[1][0], 0, null, background];
    const packets = new SpectrumOsc({ enabled: true }).update(source);
    assert.ok(decode(packets).every(({ args }) => args[4] === 1));
    const scales = reassemble(packets)[0];
    assert.equal(scales[0][1], 0.125);
    assert.deepEqual(scales[0].slice(4), [0, 0]);
    assert.deepEqual(scales[1].slice(1), [0, 0, 0, 0, 0]);
    assert.ok(scales.flat().every(Number.isFinite));
  }
  const source = frame(); source.spectrum.scales[0][3] = 1e-40;
  const scales = reassemble(new SpectrumOsc({ enabled: true }).update(source))[0];
  assert.deepEqual(scales[0].slice(4), [Math.fround(1e-40), 1]);
  // During a rolling upgrade, old sidecar triples supply no background.
  source.spectrum.scales = source.spectrum.scales.map(scale => scale.slice(0, 3));
  assert.ok(reassemble(new SpectrumOsc({ enabled: true }).update(source))[0].every(scale => scale[5] === 0));
});

test('background availability changes do not bypass the existing publication limit', () => {
  let now = 0;
  const publisher = new SpectrumOsc({ enabled: true, minIntervalMs: 5000, now: () => now });
  const source = frame();
  const first = decode(publisher.update(source))[0].args;
  const missing = advance(source, 2);
  missing.spectrum.scales = source.spectrum.scales.map(([f, m, p]) => [f, m, p, null]);
  now = 1000;
  assert.deepEqual(publisher.update(missing), []);
  now = 5000;
  const packets = publisher.update(advance(missing, 3));
  const next = decode(packets)[0].args;
  assert.equal(next[1], first[1]);
  assert.equal(next[2], first[2] + 1);
  assert.equal(next[4], 1);
  assert.ok(reassemble(packets)[0].every(scale => scale[5] === 0));
});

test('background-normalized RMS matches an independent analytic tone plus controlled Nyquist noise', () => {
  // x[n] = cos(pi*n/2) + 0.25*(-1)^n, n=0..15, exactly representable.
  // Its only DFT bins are X[4]=X[12]=8, X[8]=4. No FFT implementation
  // is used to derive this oracle. Mean=0, variance=9/16; lag sums give
  // r1=-11/144, r2=-49/72, so the clamped AR coefficient is zero.
  // At period 4 samples, Morlet gain gives recent mean power sqrt(pi)/2
  // + sqrt(pi)*exp(-36)/8, B=3*pi/64, and A=sqrt(32/(3*sqrt(pi)))
  // to double precision. The last four samples contain a complete cycle.
  const expectedPower = 0.8862269254527579;
  const expectedBackground = 0.14726215563702155;
  const expectedAmplitude = 2.453165755612409;
  const values = Array.from({ length: 16 }, (_, i) => [1.25, -0.25, -0.75, -0.25][i % 4]);
  const options = { sampleRate: 1, minPeriodSeconds: 4, maxPeriodSeconds: 16, numScales: 3 };
  const cwt = computeCwt(values, options);
  assert.equal(cwt.alpha, 0);
  assert.equal(cwt.variance, 9 / 16);
  const meanPower = [...cwt.power[0]].slice(12).reduce((sum, p) => sum + p, 0) / 4;
  assert.ok(Math.abs(meanPower - expectedPower) < 1e-12);
  assert.ok(Math.abs(cwt.backgroundPower[0] - expectedBackground) < 1e-12);
  assert.ok(Math.abs(Math.sqrt(meanPower / expectedBackground) - expectedAmplitude) < 1e-12);
  const registry = new ResidentStreamRegistry({ analyzerOptions: {
    windowSeconds: 15, analysisSampleRate: 1, oversampleFactor: 1,
    minPeriodSeconds: 4, maxPeriodSeconds: 16, numScales: 3,
  } });
  registry.ingestBatch('osc/test/value', values.map((value, i) => [i, i * 1e6, value]));
  const message = registry.analyzeNext();
  const scales = reassemble(new SpectrumOsc({ enabled: true }).update(message))[0];
  const [frequency, magnitude, , , background, valid] = scales[0];
  assert.equal(frequency, 0.25);
  assert.equal(valid, 1);
  assert.equal(background, Math.fround(expectedBackground));
  assert.ok(Math.abs(magnitude / Math.sqrt(background) - expectedAmplitude) < 2e-7);
  assert.ok(Math.abs(magnitude / Math.sqrt(background) - Math.sqrt(meanPower / expectedBackground)) < 2e-7);
});

test('short and near-degenerate analysis windows never fabricate background denominators', () => {
  for (let count = 0; count < 8; count++) {
    assert.throws(() => computeCwt(new Float64Array(count), { sampleRate: 5 }), /at least 8/);
  }
  const short = new ResidentStreamRegistry({ analyzerOptions: { windowSeconds: 1 } });
  short.ingestBatch('osc/test/value', Array.from({ length: 21 }, (_, i) => [i, i * 50000, i]));
  const waiting = short.analyzeNext();
  assert.equal(waiting.ready, false);
  assert.equal(waiting.reason, 'window');
  assert.equal(decode(new SpectrumOsc({ enabled: true }).update(waiting))[0].args[4], 0);

  const registry = new ResidentStreamRegistry({ analyzerOptions: {
    windowSeconds: 15, analysisSampleRate: 1, oversampleFactor: 1,
  } });
  registry.ingestBatch('osc/test/value', Array.from({ length: 16 }, (_, i) => [i, i * 1e6, (i % 2 ? -1 : 1) * 1e-10]));
  const message = registry.analyzeNext();
  assert.equal(message.ready, true);
  const scales = reassemble(new SpectrumOsc({ enabled: true }).update(message))[0];
  assert.ok(scales.some(scale => scale[1] > 0));
  assert.ok(scales.every(scale => scale[4] === 0 && scale[5] === 0));
});
