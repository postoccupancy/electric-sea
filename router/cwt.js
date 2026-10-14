'use strict';

const DEFAULT_W0 = 6;

function nextPow2(value) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError('value must be a positive integer');
  return 2 ** Math.ceil(Math.log2(value));
}

function fftInPlace(re, im) {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new RangeError('FFT arrays must have equal power-of-two lengths');
  }

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    const half = length >> 1;

    for (let offset = 0; offset < n; offset += length) {
      let twiddleRe = 1;
      let twiddleIm = 0;
      for (let k = 0; k < half; k++) {
        const even = offset + k;
        const odd = even + half;
        const oddRe = re[odd] * twiddleRe - im[odd] * twiddleIm;
        const oddIm = re[odd] * twiddleIm + im[odd] * twiddleRe;
        const evenRe = re[even];
        const evenIm = im[even];

        re[even] = evenRe + oddRe;
        im[even] = evenIm + oddIm;
        re[odd] = evenRe - oddRe;
        im[odd] = evenIm - oddIm;

        const nextRe = twiddleRe * stepRe - twiddleIm * stepIm;
        twiddleIm = twiddleRe * stepIm + twiddleIm * stepRe;
        twiddleRe = nextRe;
      }
    }
  }
}

function ifftInPlace(re, im) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < re.length; i++) {
    re[i] /= re.length;
    im[i] = -im[i] / im.length;
  }
}

function logSpace(min, max, count) {
  if (!(min > 0) || !(max > min) || !Number.isInteger(count) || count < 2) {
    throw new RangeError('logSpace requires 0 < min < max and count >= 2');
  }
  const ratio = max / min;
  return Array.from({ length: count }, (_, index) => min * ratio ** (index / (count - 1)));
}

function estimateAr1(values) {
  const n = values.length;
  let mean = 0;
  for (const value of values) mean += value;
  mean /= n;

  let c0 = 0;
  let c1 = 0;
  let c2 = 0;
  for (let i = 0; i < n; i++) c0 += (values[i] - mean) ** 2;
  if (c0 <= Number.EPSILON) return { mean, variance: 0, alpha: 0 };
  for (let i = 0; i < n - 1; i++) c1 += (values[i] - mean) * (values[i + 1] - mean);
  for (let i = 0; i < n - 2; i++) c2 += (values[i] - mean) * (values[i + 2] - mean);

  const r1 = c1 / c0;
  const r2 = c2 / c0;
  const alpha = Math.max(0, Math.min(0.99, (r1 + Math.sqrt(Math.max(0, r2))) / 2));
  return { mean, variance: c0 / n, alpha };
}

function morletFrequencyResponse(omega, scaleSamples, w0) {
  if (omega <= 0) return 0;
  const x = scaleSamples * omega - w0;
  return Math.PI ** -0.25 * Math.exp(-0.5 * x * x);
}

function computeCwt(values, {
  sampleRate,
  minPeriodSeconds = 0.5,
  maxPeriodSeconds = 20,
  numScales = 32,
  w0 = DEFAULT_W0,
} = {}) {
  if (!values || values.length < 8) throw new RangeError('at least 8 samples are required');
  if (!(sampleRate > 0)) throw new RangeError('sampleRate must be greater than zero');
  if (!(minPeriodSeconds > 0) || !(maxPeriodSeconds > minPeriodSeconds)) {
    throw new RangeError('period range must satisfy 0 < min < max');
  }

  const input = Float64Array.from(values);
  for (const value of input) {
    if (!Number.isFinite(value)) throw new TypeError('values must contain only finite numbers');
  }

  const n = input.length;
  const nfft = nextPow2(n);
  const { mean, variance, alpha } = estimateAr1(input);
  const signalRe = new Float64Array(nfft);
  const signalIm = new Float64Array(nfft);
  for (let i = 0; i < n; i++) signalRe[i] = input[i] - mean;
  fftInPlace(signalRe, signalIm);

  const angularFrequency = new Float64Array(nfft);
  for (let k = 0; k < nfft; k++) {
    const cyclesPerSample = k <= nfft / 2 ? k / nfft : (k - nfft) / nfft;
    angularFrequency[k] = 2 * Math.PI * cyclesPerSample;
  }

  const periodsSeconds = logSpace(minPeriodSeconds, maxPeriodSeconds, numScales);
  const power = [];
  const phase = [];
  const backgroundPower = new Float64Array(numScales);

  for (let scaleIndex = 0; scaleIndex < numScales; scaleIndex++) {
    const periodSeconds = periodsSeconds[scaleIndex];
    const periodSamples = periodSeconds * sampleRate;
    const scaleSamples = periodSamples * w0 / (2 * Math.PI);
    const convRe = new Float64Array(nfft);
    const convIm = new Float64Array(nfft);

    for (let k = 0; k < nfft; k++) {
      const response = morletFrequencyResponse(angularFrequency[k], scaleSamples, w0)
        * Math.sqrt(2 * Math.PI * scaleSamples);
      convRe[k] = signalRe[k] * response;
      convIm[k] = signalIm[k] * response;
    }
    ifftInPlace(convRe, convIm);

    const scalePower = new Float64Array(n);
    const scalePhase = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      scalePower[t] = (convRe[t] ** 2 + convIm[t] ** 2) / Math.max(scaleSamples, Number.EPSILON);
      scalePhase[t] = Math.atan2(convIm[t], convRe[t]);
    }
    power.push(scalePower);
    phase.push(scalePhase);

    const frequencyCyclesPerSample = 1 / periodSamples;
    const ar1Factor = alpha < 0.01
      ? 1
      : (1 - alpha ** 2)
        / (1 + alpha ** 2 - 2 * alpha * Math.cos(2 * Math.PI * frequencyCyclesPerSample));
    backgroundPower[scaleIndex] = variance * n / (nfft * Math.max(scaleSamples, Number.EPSILON)) * ar1Factor;
  }

  return {
    sampleRate,
    sampleCount: n,
    durationSeconds: (n - 1) / sampleRate,
    periodsSeconds,
    frequenciesHz: periodsSeconds.map(period => 1 / period),
    power,
    phase,
    backgroundPower,
    mean,
    variance,
    alpha,
  };
}

function summarizeCwt(result, { recentFraction = 0.25 } = {}) {
  if (!(recentFraction > 0 && recentFraction <= 1)) {
    throw new RangeError('recentFraction must be greater than zero and at most one');
  }

  const recentStart = Math.max(0, Math.floor(result.sampleCount * (1 - recentFraction)));
  return result.periodsSeconds.map((periodSeconds, scaleIndex) => {
    const scalePower = result.power[scaleIndex];
    const scalePhase = result.phase[scaleIndex];
    let totalPower = 0;
    let recentPower = 0;
    let phaseX = 0;
    let phaseY = 0;

    for (let t = 0; t < scalePower.length; t++) {
      totalPower += scalePower[t];
      if (t >= recentStart) {
        recentPower += scalePower[t];
        phaseX += Math.cos(scalePhase[t]) * scalePower[t];
        phaseY += Math.sin(scalePhase[t]) * scalePower[t];
      }
    }

    const recentCount = scalePower.length - recentStart;
    const meanPower = totalPower / scalePower.length;
    const meanRecentPower = recentPower / recentCount;
    const backgroundPower = result.backgroundPower[scaleIndex];

    return {
      periodSeconds,
      frequencyHz: 1 / periodSeconds,
      meanPower,
      recentPower: meanRecentPower,
      backgroundPower,
      excessRatio: backgroundPower > Number.EPSILON ? meanRecentPower / backgroundPower : 0,
      phase: Math.atan2(phaseY, phaseX),
      // atan2(0, 0) is numeric but is not a defined circular mean.
      phaseDefined: recentPower > 0 && Math.hypot(phaseX, phaseY) > Number.EPSILON * recentPower,
      completedCycles: result.durationSeconds / periodSeconds,
    };
  });
}

module.exports = {
  computeCwt,
  estimateAr1,
  fftInPlace,
  ifftInPlace,
  logSpace,
  nextPow2,
  summarizeCwt,
};
