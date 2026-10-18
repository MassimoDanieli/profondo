// Bass tuner: normalized autocorrelation (YIN-style difference function), 25–450 Hz.
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function detectPitch(buf, sr) {
  const n = buf.length;
  let rms = 0; for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n); if (rms < 0.004) return null;
  const minLag = Math.floor(sr / 450), maxLag = Math.min(Math.floor(sr / 25), Math.floor(n / 2));
  const W = n - maxLag;
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0; for (let i = 0; i < W; i += 2) { const x = buf[i] - buf[i + lag]; s += x * x; } d[lag] = s;
  }
  let run = 0; const cm = new Float32Array(maxLag + 1); cm[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) { run += d[lag]; cm[lag] = d[lag] * lag / (run || 1); }
  let best = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) { if (cm[lag] < 0.15 && cm[lag] <= cm[lag - 1] && cm[lag] <= cm[lag + 1]) { best = lag; break; } }
  if (best < 0) { let m = Infinity; for (let lag = minLag; lag <= maxLag; lag++) if (cm[lag] < m) { m = cm[lag]; best = lag; } if (m > 0.35) return null; }
  const a = cm[best - 1] ?? cm[best], b = cm[best], c = cm[best + 1] ?? cm[best];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  const freq = sr / (best + (isFinite(shift) ? shift : 0));
  return freq;
}

export function noteOf(freq, a4 = 440) {
  const m = 12 * Math.log2(freq / a4) + 69;
  const r = Math.round(m);
  return { name: NOTES[(r % 12 + 12) % 12], octave: Math.floor(r / 12) - 1, cents: Math.round((m - r) * 100), freq };
}
