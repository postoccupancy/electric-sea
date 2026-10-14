'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCwt, estimateAr1, summarizeCwt } = require('../cwt');

function seededNoise(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000 - 0.5;
  };
}

function sineSeries({ sampleRate, durationSeconds, frequencyHz, noiseAmount = 0, seed = 1 }) {
  const random = seededNoise(seed);
  const count = Math.floor(sampleRate * durationSeconds);
  return Float64Array.from({ length: count }, (_, index) =>
    Math.sin(2 * Math.PI * frequencyHz * index / sampleRate) + noiseAmount * random()
  );
}

function strongestScale(summary) {
  return summary.reduce((best, scale) => scale.excessRatio > best.excessRatio ? scale : best);
}

test('CWT locates a known scalar oscillation', () => {
  const sampleRate = 10;
  const frequencyHz = 0.4;
  const values = sineSeries({
    sampleRate,
    durationSeconds: 60,
    frequencyHz,
    noiseAmount: 0.2,
    seed: 17,
  });

  const result = computeCwt(values, {
    sampleRate,
    minPeriodSeconds: 0.5,
    maxPeriodSeconds: 10,
    numScales: 48,
  });
  const peak = strongestScale(summarizeCwt(result));

  assert.ok(Math.abs(peak.frequencyHz - frequencyHz) < 0.06,
    `expected ${frequencyHz} Hz, found ${peak.frequencyHz} Hz`);
  assert.ok(peak.excessRatio > 1);
  assert.ok(peak.completedCycles > 20);
});

test('CWT distinguishes two separated oscillations', () => {
  const sampleRate = 10;
  const durationSeconds = 80;
  const count = sampleRate * durationSeconds;
  const random = seededNoise(42);
  const values = Float64Array.from({ length: count }, (_, index) => {
    const time = index / sampleRate;
    return Math.sin(2 * Math.PI * 0.25 * time)
      + 0.7 * Math.sin(2 * Math.PI * 0.8 * time)
      + 0.1 * random();
  });

  const summary = summarizeCwt(computeCwt(values, {
    sampleRate,
    minPeriodSeconds: 0.5,
    maxPeriodSeconds: 8,
    numScales: 64,
  }));

  const localPeaks = summary
    .filter((scale, index) => index > 0 && index < summary.length - 1
      && scale.excessRatio > summary[index - 1].excessRatio
      && scale.excessRatio > summary[index + 1].excessRatio)
    .sort((a, b) => b.excessRatio - a.excessRatio)
    .slice(0, 4);

  assert.ok(localPeaks.some(scale => Math.abs(scale.frequencyHz - 0.25) < 0.05));
  assert.ok(localPeaks.some(scale => Math.abs(scale.frequencyHz - 0.8) < 0.1));
});

test('AR(1) estimate is low for white noise and high for persistent noise', () => {
  const random = seededNoise(9);
  const white = Float64Array.from({ length: 2000 }, () => random());
  const persistent = new Float64Array(2000);
  for (let i = 1; i < persistent.length; i++) {
    persistent[i] = 0.95 * persistent[i - 1] + random() * 0.1;
  }

  const whiteAr1 = estimateAr1(white).alpha;
  const persistentAr1 = estimateAr1(persistent).alpha;

  assert.ok(whiteAr1 < 0.2, `white alpha was ${whiteAr1}`);
  assert.ok(persistentAr1 > 0.8, `persistent alpha was ${persistentAr1}`);
});

test('summary exposes power, background, phase, and completed cycles', () => {
  const values = sineSeries({ sampleRate: 10, durationSeconds: 20, frequencyHz: 1 });
  const result = computeCwt(values, {
    sampleRate: 10,
    minPeriodSeconds: 0.5,
    maxPeriodSeconds: 4,
    numScales: 12,
  });
  const summary = summarizeCwt(result, { recentFraction: 0.5 });

  assert.equal(summary.length, 12);
  for (const scale of summary) {
    assert.ok(Number.isFinite(scale.meanPower));
    assert.ok(Number.isFinite(scale.recentPower));
    assert.ok(Number.isFinite(scale.backgroundPower));
    assert.ok(Number.isFinite(scale.excessRatio));
    assert.ok(Number.isFinite(scale.phase));
    assert.ok(Number.isFinite(scale.completedCycles));
  }
});

test('CWT rejects missing values rather than silently contaminating analysis', () => {
  const values = Float64Array.from({ length: 100 }, (_, index) => Math.sin(index / 10));
  values[50] = Number.NaN;

  assert.throws(() => computeCwt(values, { sampleRate: 10 }), /finite numbers/);
});

test('AR(1) estimate matches hand-counted ramp lags and backgrounds match a covariance-series reference', () => {
  // For [0..7], mean=7/2, c0=42, c1=105/4, c2=23/2.
  const values = Array.from({ length: 8 }, (_, i) => i);
  const expectedAlpha = 0.5741340592361418; // (5/8 + sqrt(23/84))/2
  const estimate = estimateAr1(values);
  assert.equal(estimate.mean, 3.5);
  assert.equal(estimate.variance, 5.25);
  assert.ok(Math.abs(estimate.alpha - expectedAlpha) < 1e-15);
  const result = computeCwt(values, { sampleRate: 5, minPeriodSeconds: 1, maxPeriodSeconds: 20, numScales: 48 });
  assert.equal(result.backgroundPower.length, 48);
  // Independent AR spectrum evaluation: Fourier series of autocovariance
  // rho[k]=alpha^|k|, not the production rational spectral-factor formula.
  for (let i = 0; i < 48; i++) {
    const frequency = result.frequenciesHz[i] / 5;
    let spectralFactor = 1;
    for (let lag = 1; lag <= 200; lag++) {
      spectralFactor += 2 * expectedAlpha ** lag * Math.cos(2 * Math.PI * frequency * lag);
    }
    const scaleSamples = result.periodsSeconds[i] * 5 * 6 / (2 * Math.PI);
    const expected = 5.25 * spectralFactor / scaleSamples; // N=Nfft=8
    assert.ok(Number.isFinite(result.backgroundPower[i]) && result.backgroundPower[i] > 0);
    assert.ok(Math.abs(result.backgroundPower[i] - expected) < 1e-12);
  }
  assert.deepEqual(estimateAr1([7]), { mean: 7, variance: 0, alpha: 0 });
  const constant = computeCwt(Array(8).fill(7), { sampleRate: 5, numScales: 48 });
  assert.equal(constant.variance, 0);
  assert.equal(constant.alpha, 0);
  assert.ok([...constant.backgroundPower].every(value => value === 0));
});
