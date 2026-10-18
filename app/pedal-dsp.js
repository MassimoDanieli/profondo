// Profondo — pedal DSP (runs inside the AudioWorklet). Mono, per-sample, allocation-free in process().

const dB = (v) => Math.pow(10, v / 20);
const coef = (ms, sr) => 1 - Math.exp(-1 / (Math.max(0.02, ms) * 0.001 * sr));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

class OnePole {
  constructor() { this.y = 0; this.a = 1; }
  set(fc, sr) { this.a = 1 - Math.exp(-2 * Math.PI * Math.min(fc, sr * 0.45) / sr); return this; }
  lp(x) { this.y += this.a * (x - this.y); return this.y; }
  hp(x) { this.y += this.a * (x - this.y); return x - this.y; }
}
class Sm { constructor(v) { this.v = v; this.t = v; } next(k = 0.0015) { return (this.v += (this.t - this.v) * k); } }

// gain reduction (dB) for a level over threshold with a soft knee
function grFor(envDb, thr, ratio, knee) {
  const over = envDb - thr, s = 1 - 1 / ratio;
  if (2 * over < -knee) return 0;
  if (2 * Math.abs(over) <= knee) return s * (over + knee / 2) * (over + knee / 2) / (2 * knee);
  return s * over;
}

export class Gate {
  constructor(sr) { this.sr = sr; this.env = 0; this.g = 1; this.open = false; this.hold = 0; this.thr = dB(-65); this.rel = coef(120, sr); }
  set(v, p) { this.thr = dB(p.thresh); this.rel = coef(p.release, this.sr); }
  process(x, n) {
    const sr = this.sr;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      this.env += (a > this.env ? 0.05 : 0.0008) * (a - this.env);
      if (this.env > this.thr) { this.open = true; this.hold = 0.04 * sr; }
      else if (this.env < this.thr * 0.6) { if (this.hold > 0) this.hold--; else this.open = false; }
      this.g += (this.open ? 0.02 : this.rel) * ((this.open ? 1 : 0) - this.g);
      x[i] *= this.g;
    }
  }
}

export class Comp {
  constructor(sr) {
    this.sr = sr; this.v = 'opto'; this.env = 0; this.envB = 0; this.slow = 0; this.prevOut = 0; this.gr = 0;
    this.split = new OnePole(); this.lvl = new Sm(1); this.mix = new Sm(1);
    this.set('opto', { amount: 4, attack: 10, release: 180, level: 0, blend: 100, xover: 150 });
  }
  set(v, p) {
    this.v = v || 'opto'; const a = p.amount, sr = this.sr;
    this.atk = coef(p.attack, sr); this.rel = coef(p.release, sr);
    if (this.v === 'vca') { this.thr = -a * 4; this.ratio = 2 + a * 0.6; this.knee = 3; }
    else if (this.v === 'opto') { this.thr = -a * 4.2; this.ratio = 2 + a * 0.35; this.knee = 12; this.atk = coef(p.attack * 1.5 + 5, sr); }
    else if (this.v === 'fet') { this.thr = -a * 3.6; this.ratio = 4 + a * 1.6; this.knee = 2; this.atk = coef(p.attack * 0.08, sr); }
    else { this.thr = -a * 4.5; this.ratio = 3 + a * 0.5; this.knee = 8; this.thrB = -a * 2.5; this.ratioB = 2 + a * 0.2; this.split.set(p.xover || 150, sr); }
    this.makeup = dB(-this.thr * (1 - 1 / this.ratio) * 0.5);
    this.lvl.t = dB(p.level); this.mix.t = p.blend / 100;
    this.relSlow = coef(p.release * 6 + 400, sr);
  }
  process(x, n) {
    let grMax = 0;
    const v = this.v;
    for (let i = 0; i < n; i++) {
      const s = x[i];
      let y;
      if (v === 'vca') {
        const d = Math.abs(s);
        this.env += (d > this.env ? this.atk : this.rel) * (d - this.env);
        const gr = grFor(20 * Math.log10(this.env + 1e-9), this.thr, this.ratio, this.knee);
        if (gr > grMax) grMax = gr;
        y = s * dB(-gr) * this.makeup;
      } else if (v === 'opto') {
        // RMS detector, program-dependent two-stage release (fast at first, slow after long compression)
        const d = s * s;
        const rel = this.rel * (1 - this.slow) + this.relSlow * this.slow;
        this.env += (d > this.env ? this.atk : rel) * (d - this.env);
        const gr = grFor(10 * Math.log10(this.env + 1e-12), this.thr, this.ratio, this.knee);
        this.slow += ((gr > 3 ? 1 : 0) - this.slow) * 0.00004;
        if (gr > grMax) grMax = gr;
        y = s * dB(-gr) * this.makeup;
      } else if (v === 'fet') {
        // feedback detector + a little output grit
        const d = Math.abs(this.prevOut);
        this.env += (d > this.env ? this.atk : this.rel) * (d - this.env);
        const gr = grFor(20 * Math.log10(this.env + 1e-9), this.thr, this.ratio, this.knee);
        if (gr > grMax) grMax = gr;
        const c = s * dB(-gr);
        this.prevOut = c;
        const m = c * this.makeup;
        y = Math.tanh(m * 1.4) / 1.4;
      } else {
        // multiband: lows (smooth, heavier) and highs (lighter, faster) compressed separately
        const lo = this.split.lp(s), hi = s - lo;
        const dl = lo * lo;
        this.env += (dl > this.env ? this.atk * 0.5 : this.rel) * (dl - this.env);
        const g1 = grFor(10 * Math.log10(this.env + 1e-12), this.thr, this.ratio, this.knee);
        const dh = Math.abs(hi);
        this.envB += (dh > this.envB ? this.atk : this.rel) * (dh - this.envB);
        const g2 = grFor(20 * Math.log10(this.envB + 1e-9), this.thrB, this.ratioB, 4);
        const gr = Math.max(g1, g2); if (gr > grMax) grMax = gr;
        y = (lo * dB(-g1) + hi * dB(-g2)) * this.makeup;
      }
      const m = this.mix.next();
      x[i] = y * this.lvl.next() * m + s * (1 - m);
    }
    this.gr = grMax;
  }
}

export class Drive {
  constructor(sr) {
    this.sr = sr; this.hp = new OnePole(); this.dc = new OnePole().set(10, sr); this.lp = new OnePole(); this.lp2 = new OnePole(); this.hpT = new OnePole(); this.pres = new OnePole().set(2800, sr);
    this.env = 0; this.lvl = new Sm(1); this.mix = new Sm(0.5); this.set('tube', { gain: 4, tone: 5, level: 0, blend: 50 });
  }
  set(v, p) {
    this.v = v || 'tube'; const sr = this.sr, g = p.gain, t = p.tone;
    if (this.v === 'tube') { this.hp.set(140, sr); this.pre = dB(g * 4); this.lp.set(500 * Math.pow(16, t / 10), sr); this.out = 0.5; }
    else if (this.v === 'dist') { this.hp.set(250, sr); this.pre = dB(g * 4.6 + 6); this.lp.set(900 * Math.pow(9, t / 10), sr); this.lp2.set(6500, sr); this.out = 0.45; }
    else if (this.v === 'fuzz') { this.hp.set(90, sr); this.pre = dB(g * 5 + 10); this.lp.set(650, sr); this.hpT.set(1000, sr); this.tilt = t / 10; this.out = 0.42; }
    else { this.hp.set(200, sr); this.pre = dB(g * 4.5 + 8); this.lp.set(600 * Math.pow(12, t / 10), sr); this.out = 0.5; }
    this.lvl.t = dB(p.level); this.mix.t = p.blend / 100;
  }
  process(x, n) {
    const v = this.v;
    for (let i = 0; i < n; i++) {
      const s = x[i];
      let d = this.hp.hp(s) * this.pre, y;
      if (v === 'tube') {
        d = d > 0 ? Math.tanh(d) : Math.tanh(d * 0.8) / 0.8 * 0.9;
        y = this.lp.lp(this.dc.hp(d));
      } else if (v === 'dist') {
        d = clamp(d, -1.5, 1.5); d = d - (d * d * d) / 6.75; // smooth hard clip
        const f = this.lp2.lp(this.lp.lp(d));
        y = f + (d - this.pres.lp(d)) * 0.3; // a bit of top-end "attitude"
      } else if (v === 'fuzz') {
        this.env += (Math.abs(s) > this.env ? 0.01 : 0.0004) * (Math.abs(s) - this.env);
        const gate = clamp((this.env - 0.0015) * 400, 0, 1); // sputters as notes decay
        d = d > 0 ? Math.min(d, 1) : Math.max(d * 1.3, -0.75);
        d = this.dc.hp(d) * gate;
        const lo = this.lp.lp(d), hi = this.hpT.hp(d);
        y = lo * (1 - this.tilt) + hi * this.tilt * 1.4;
      } else {
        d = Math.abs(d); // full-wave rectifier: octave up
        d = Math.tanh(this.dc.hp(d) * 2.2);
        y = this.lp.lp(d);
      }
      const m = this.mix.next();
      x[i] = y * this.out * this.lvl.next() * m + s * (1 - m);
    }
  }
}

export class Octave {
  constructor(sr) {
    this.sr = sr; this.in1 = new OnePole().set(260, sr); this.in2 = new OnePole().set(180, sr);
    this.o1 = new OnePole(); this.o2 = new OnePole(); this.o3 = new OnePole(); this.o4 = new OnePole();
    this.env = 0; this.pos = false; this.q1 = 1; this.q2 = 1;
    this.s1 = new Sm(0.7); this.s2 = new Sm(0); this.dry = new Sm(0.8);
    this.set('', { sub1: 70, sub2: 0, dry: 80, tone: 4 });
  }
  set(v, p) {
    const fc = 90 * Math.pow(9, p.tone / 10);
    this.o1.set(fc, this.sr); this.o2.set(fc, this.sr); this.o3.set(fc * 0.7, this.sr); this.o4.set(fc * 0.7, this.sr);
    this.s1.t = p.sub1 / 100; this.s2.t = p.sub2 / 100; this.dry.t = p.dry / 100;
  }
  process(x, n) {
    for (let i = 0; i < n; i++) {
      const s = x[i];
      const f = this.in2.lp(this.in1.lp(s));
      const a = Math.abs(s);
      this.env += (a > this.env ? 0.02 : 0.0006) * (a - this.env);
      const h = this.env * 0.12 + 1e-4; // hysteresis follows the level
      if (!this.pos && f > h) { this.pos = true; this.q1 = -this.q1; if (this.q1 > 0) this.q2 = -this.q2; }
      else if (this.pos && f < -h) this.pos = false;
      const g = clamp((this.env - 0.002) * 300, 0, 1) * this.env * 2.2;
      const sub1 = this.o2.lp(this.o1.lp(this.q1 * g)), sub2 = this.o4.lp(this.o3.lp(this.q2 * g));
      x[i] = s * this.dry.next() + sub1 * this.s1.next() + sub2 * this.s2.next();
    }
  }
}

export class EnvFilter {
  constructor(sr) { this.sr = sr; this.env = 0; this.ic1 = 0; this.ic2 = 0; this.cnt = 0; this.g = 0.1; this.mix = new Sm(0.8); this.set('lp', { sens: 5, range: 6, reso: 5, mix: 80 }); }
  set(v, p) {
    this.v = v || 'lp';
    this.sens = dB(p.sens * 4 + 6);
    this.fmin = 120; this.fmax = Math.min(this.sr * 0.42, 300 * Math.pow(2, p.range * 0.55));
    this.k = 1 / (0.7 + p.reso * 1.2);
    this.mix.t = p.mix / 100;
    this.atk = coef(2, this.sr); this.rel = coef(140, this.sr);
  }
  process(x, n) {
    const sr = this.sr, k = this.k;
    for (let i = 0; i < n; i++) {
      const s = x[i], a = Math.abs(s);
      this.env += (a > this.env ? this.atk : this.rel) * (a - this.env);
      if ((this.cnt++ & 7) === 0) {
        const e = Math.sqrt(clamp(this.env * this.sens, 0, 1));
        const f = this.v === 'down' ? this.fmax * Math.pow(this.fmin / this.fmax, e) : this.fmin * Math.pow(this.fmax / this.fmin, e);
        this.g = Math.tan(Math.PI * f / sr);
      }
      // TPT state-variable filter
      const g = this.g, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      const v3 = s - this.ic2, v1 = a1 * this.ic1 + a2 * v3, v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
      this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
      const y = this.v === 'bp' ? v1 * (1 + 1 / k) * 0.5 : v2;
      const m = this.mix.next();
      x[i] = y * m + s * (1 - m);
    }
  }
}

export class Chorus {
  constructor(sr) {
    this.sr = sr; this.N = 4096; this.buf = new Float32Array(this.N); this.w = 0; this.ph = 0;
    this.split = new OnePole(); this.mix = new Sm(0.5); this.depth = new Sm(0.001);
    this.set('', { rate: 0.8, depth: 5, mix: 50, xover: 120 });
  }
  set(v, p) { this.inc = p.rate / this.sr; this.depth.t = p.depth * 0.00035 * this.sr; this.mix.t = p.mix / 100; this.split.set(p.xover, this.sr); this.base = 0.007 * this.sr; }
  tap(d) { let r = this.w - d; while (r < 0) r += this.N; const i = r | 0, f = r - i; const a = this.buf[i], b = this.buf[(i + 1) % this.N]; return a + (b - a) * f; }
  process(x, n) {
    for (let i = 0; i < n; i++) {
      const s = x[i], lo = this.split.lp(s), hi = s - lo;
      this.buf[this.w] = hi;
      this.ph += this.inc; if (this.ph >= 1) this.ph -= 1;
      const dep = this.depth.next();
      const l1 = Math.sin(2 * Math.PI * this.ph), l2 = Math.sin(2 * Math.PI * (this.ph + 0.5));
      const wet = 0.5 * (this.tap(this.base + dep * (1 + l1)) + this.tap(this.base + dep * (1 + l2)));
      this.w = (this.w + 1) % this.N;
      const m = this.mix.next();
      x[i] = lo + hi * (1 - m * 0.5) + wet * m;
    }
  }
}

export const DSP = { gate: Gate, comp: Comp, drive: Drive, octave: Octave, envf: EnvFilter, chorus: Chorus };
export { Sm, dB };
