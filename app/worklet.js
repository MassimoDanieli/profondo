// Profondo — front-end AudioWorklet: gate → compressor → drive → NAM pedal → NAM amp
// Output 0: amp path (mono). Output 1: clean DI after the compressor (for the clean blend).
// NAM inference runs in WebAssembly (NeuralAmpModelerCore compiled to wasm32), one instance per model.

const dbToLin = (db) => Math.pow(10, db / 20);
const BLOCK_MAX = 128;

// ---------- WASM host (no WASI file system; a C++ throw records a message then traps) ----------
function wasiStubs(getMem) {
  const h = new Proxy({}, {
    get: (_, name) => {
      if (name === 'proc_exit') return (c) => { throw new Error('proc_exit ' + c); };
      if (name === 'environ_sizes_get') return (a, b) => { const v = new DataView(getMem().buffer); v.setUint32(a, 0, true); v.setUint32(b, 0, true); return 0; };
      if (name === 'environ_get') return () => 0;
      if (name === 'fd_prestat_get') return () => 8;
      if (name === 'fd_write') return (fd, iov, n, out) => { const v = new DataView(getMem().buffer); let t = 0; for (let i = 0; i < n; i++) t += v.getUint32(iov + i * 8 + 4, true); v.setUint32(out, t, true); return 0; };
      return () => 52;
    }
  });
  return { wasi_snapshot_preview1: h };
}

// A NAM instance adopted from a memory snapshot built and prewarmed by the loader worker.
// Instantiating applies the module's data segments; the snapshot then overwrites the whole
// memory, so the heap, the model and its prewarmed state are exactly the worker's.
// (The only mutable wasm global is the stack pointer, which is back at its initial value
// between calls, so it needs no transfer.) _initialize is NOT called again.
class NamInstance {
  // Instances are created ahead of time (pool, at engine start) and reused: adopting a model only
  // overwrites the instance memory with the worker's snapshot, a slice per render quantum.
  constructor(module) {
    let mem;
    this.inst = new WebAssembly.Instance(module, wasiStubs(() => mem));
    mem = this.inst.exports.memory;
    this.mem = mem; this.x = this.inst.exports; this.snap = null;
    this.inPtr = this.x.nam_in() >> 2; this.outPtr = this.x.nam_out() >> 2;
  }
  begin(snapshot) {
    const need = snapshot.byteLength - this.mem.buffer.byteLength;
    if (need > 0) this.mem.grow(Math.ceil(need / 65536));
    this.snap = new Uint8Array(snapshot); this.copied = 0;
    return this;
  }
  get ready() { return this.snap === null; }
  copyStep(maxBytes) {
    if (!this.snap) return true;
    const end = Math.min(this.snap.length, this.copied + maxBytes);
    new Uint8Array(this.mem.buffer, this.copied, end - this.copied).set(this.snap.subarray(this.copied, end));
    this.copied = end;
    if (end >= this.snap.length) { this.snap = null; return true; }
    return false;
  }
  process(input, output, n) {
    const f = new Float32Array(this.mem.buffer);
    f.set(input.subarray(0, n), this.inPtr);
    this.x.nam_process(n);
    output.set(f.subarray(this.outPtr, this.outPtr + n));
  }
}

// ---------- small DSP helpers ----------
class OnePole { // y += a (x - y)
  constructor() { this.y = 0; this.a = 1; }
  setLP(fc, sr) { this.a = 1 - Math.exp(-2 * Math.PI * fc / sr); }
  lp(x) { this.y += this.a * (x - this.y); return this.y; }
  hp(x) { this.y += this.a * (x - this.y); return x - this.y; }
}
class Smooth { constructor(v) { this.v = v; this.t = v; } step(k = 0.002) { this.v += (this.t - this.v) * k; return this.v; } }

// A model slot: equal-gain crossfade when the model changes, normalization gain always applied
// (smoothed, so toggling Normalize or swapping models never jumps).
class Slot {
  constructor() { this.cur = null; this.prev = null; this.fade = 1; this.gain = new Smooth(1); this.prevGain = 1;
    this.bufA = new Float32Array(BLOCK_MAX); this.bufB = new Float32Array(BLOCK_MAX); }
  set(entry) {
    if (entry === this.cur) return;
    this.prev = this.cur; this.prevGain = this.gain.v; this.cur = entry; this.fade = 0;
    this.gain.v = this.gain.t = entry ? entry.norm : 1; // new model starts at its own normalized level
  }
  get active() { return !!(this.cur || (this.prev && this.fade < 1)); }
  run(x, out, n, sr) {
    const fadeLen = 0.02 * sr;
    if (this.cur) this.cur.inst.process(x, this.bufA, n); else this.bufA.set(x.subarray(0, n));
    this.gain.t = this.cur ? this.cur.norm : 1;
    if (this.fade < 1) {
      if (this.prev) this.prev.inst.process(x, this.bufB, n); else this.bufB.set(x.subarray(0, n));
      for (let i = 0; i < n; i++) {
        const g = Math.min(1, this.fade + i / fadeLen);
        out[i] = this.bufA[i] * this.gain.step() * g + this.bufB[i] * this.prevGain * (1 - g);
      }
      this.fade = Math.min(1, this.fade + n / fadeLen);
      if (this.fade >= 1) this.prev = null;
    } else {
      for (let i = 0; i < n; i++) out[i] = this.bufA[i] * this.gain.step();
    }
  }
}

class ProfondoFront extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.module = null;
    this.cache = new Map(); // 'slot:id' -> {inst, info, norm}
    this.adopting = []; this.pool = [];
    this.maxStepMs = 0;
    this.slots = { pedal: new Slot(), amp: new Slot() };
    this.p = {
      'in.gain': 0, 'gate.on': 0, 'gate.thresh': -65, 'gate.release': 120,
      'comp.on': 0, 'comp.sustain': 4, 'comp.attack': 10, 'comp.level': 0, 'comp.blend': 100,
      'drive.on': 0, 'drive.gain': 4, 'drive.tone': 5, 'drive.level': 0, 'drive.blend': 50,
      'pedal.on': 0, 'pedal.input': 0, 'pedal.level': 0,
      'amp.on': 1, 'amp.input': 0, 'amp.output': 0, 'normalize': 1, 'bypass': 0,
    };
    this.g = { in: new Smooth(1), pedIn: new Smooth(1), pedOut: new Smooth(1), ampIn: new Smooth(1), ampOut: new Smooth(1),
      compLvl: new Smooth(1), drvLvl: new Smooth(1), drvMix: new Smooth(0.5), compMix: new Smooth(1),
      wGate: new Smooth(0), wComp: new Smooth(0), wDrive: new Smooth(0), wPedal: new Smooth(0), wAmp: new Smooth(1) };
    this.gateEnv = 0; this.gateGain = 1; this.gateOpen = false; this.gateHold = 0;
    this.compEnv = 0; this.compGR = 0;
    this.drvHP = new OnePole(); this.drvTone = new OnePole(); this.drvHP.setLP(140, this.sr); this.drvDC = new OnePole(); this.drvDC.setLP(10, this.sr);
    this.tubeLP = new OnePole(); this.tubeLP.setLP(5500, this.sr); this.tubeDC = new OnePole(); this.tubeDC.setLP(15, this.sr);
    this.b1 = new Float32Array(BLOCK_MAX); this.b2 = new Float32Array(BLOCK_MAX); this.b3 = new Float32Array(BLOCK_MAX);
    this.meter = { inPk: 0, outPk: 0, cpu: 0, ms: 0, budget: 0 };
    this.lastReport = 0;
    this.applyAll();
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  applyAll() {
    const p = this.p, g = this.g;
    g.in.t = dbToLin(p['in.gain']);
    g.pedIn.t = dbToLin(p['pedal.input']); g.pedOut.t = dbToLin(p['pedal.level']);
    g.ampIn.t = dbToLin(p['amp.input']); g.ampOut.t = dbToLin(p['amp.output']);
    g.compLvl.t = dbToLin(p['comp.level']); g.compMix.t = p['comp.blend'] / 100;
    g.drvLvl.t = dbToLin(p['drive.level']); g.drvMix.t = p['drive.blend'] / 100;
    g.wGate.t = p['gate.on'] ? 1 : 0; g.wComp.t = p['comp.on'] ? 1 : 0; g.wDrive.t = p['drive.on'] ? 1 : 0;
    g.wPedal.t = p['pedal.on'] ? 1 : 0; g.wAmp.t = p['amp.on'] ? 1 : 0;
    this.drvTone.setLP(500 * Math.pow(16, p['drive.tone'] / 10), this.sr);
    this.drvPre = dbToLin(p['drive.gain'] * 4); // up to +40 dB
    // compressor: sustain 0..10 -> threshold 0..-40 dB, ratio 2..8
    this.compThr = -p['comp.sustain'] * 4; this.compRatio = 2 + p['comp.sustain'] * 0.6;
    this.compAtk = 1 - Math.exp(-1 / (p['comp.attack'] * 0.001 * this.sr));
    this.compRel = 1 - Math.exp(-1 / (0.18 * this.sr));
    this.compMakeup = dbToLin(-this.compThr * (1 - 1 / this.compRatio) * 0.5);
    this.gateThr = dbToLin(p['gate.thresh']);
    this.gateRel = 1 - Math.exp(-1 / (p['gate.release'] * 0.001 * this.sr));
    if (this.cache) for (const e of this.cache.values()) this.updateNorm(e);
  }

  updateNorm(entry) {
    if (!entry) return;
    const L = entry.info.loudness;
    entry.norm = (this.p.normalize && L < 900) ? dbToLin(-18 - L) : 1;
  }

  onMsg(m) {
    try {
      if (m.type === 'wasm') { this.module = new WebAssembly.Module(m.bytes); for (let i = 0; i < 6; i++) this.pool.push(new NamInstance(this.module)); this.port.postMessage({ type: 'ready' }); }
      else if (m.type === 'params') { Object.assign(this.p, m.p); this.applyAll(); }
      else if (m.type === 'adopt') { // snapshot built by the loader worker; key is per slot so pedal and amp never share state
        const key = m.slot + ':' + m.id;
        let entry = this.cache.get(key); const t0 = Date.now();
        if (!entry) {
          if (!this.module) throw new Error('engine not ready');
          if (this.cache.size >= 12) { // evict the oldest unused model and recycle its instance
            for (const [k, v] of this.cache) { if (v !== this.slots.amp.cur && v !== this.slots.pedal.cur && v !== this.slots.amp.prev && v !== this.slots.pedal.prev && v.inst.ready) { this.cache.delete(k); this.pool.push(v.inst); break; } }
          }
          const inst = (this.pool.pop() || new NamInstance(this.module)).begin(m.snapshot);
          entry = { inst, info: m.info, norm: 1, id: m.id, key };
          this.cache.set(key, entry);
          this.adopting.push({ entry, slot: m.slot, activate: m.activate, req: m.req, id: m.id, t0, instMs: Date.now() - t0 });
          this.updateNorm(entry);
          return; // finished (and reported) in process(), a slice per render quantum
        }
        this.updateNorm(entry);
        if (m.activate) this.slots[m.slot].set(entry);
        this.port.postMessage({ type: 'loaded', slot: m.slot, id: m.id, info: entry.info, req: m.req, adoptMs: Date.now() - t0 });
      }
      else if (m.type === 'select') { // already adopted for this slot?
        const entry = this.cache.get(m.slot + ':' + m.id);
        if (entry && entry.inst.ready) { this.updateNorm(entry); this.slots[m.slot].set(entry); this.port.postMessage({ type: 'loaded', slot: m.slot, id: m.id, info: entry.info, req: m.req }); }
        else this.port.postMessage({ type: 'miss', slot: m.slot, id: m.id, req: m.req });
      }
      else if (m.type === 'debug') {
        const a = this.slots.amp.cur, pd = this.slots.pedal.cur;
        this.port.postMessage({ type: 'debug', req: m.req, shared: !!(a && pd && a.inst === pd.inst), ampNorm: a ? a.norm : null, ampGain: this.slots.amp.gain.v, cache: [...this.cache.keys()] });
      }
      else if (m.type === 'unload') { this.slots[m.slot].set(null); this.port.postMessage({ type: 'unloaded', slot: m.slot }); }
    } catch (err) {
      this.port.postMessage({ type: 'error', slot: m.slot, id: m.id, req: m.req, message: String(err.message || err) });
    }
  }

  process(inputs, outputs) {
    const t0 = Date.now();
    if (this.adopting.length) {
      const a = this.adopting[0];
      const s0 = Date.now();
      if (a.entry.inst.copyStep(128 * 1024)) {
        this.adopting.shift();
        if (a.activate) this.slots[a.slot].set(a.entry);
        this.port.postMessage({ type: 'loaded', slot: a.slot, id: a.id, info: a.entry.info, req: a.req, adoptMs: Date.now() - a.t0, instMs: a.instMs, maxStepMs: Math.max(this.maxStepMs, Date.now() - s0) });
        this.maxStepMs = 0;
      } else this.maxStepMs = Math.max(this.maxStepMs, Date.now() - s0);
    }
    const inp = inputs[0] && inputs[0][0];
    const out0 = outputs[0][0], out1 = outputs[1] && outputs[1][0];
    const n = out0.length;
    const x = this.b1;
    if (inp) x.set(inp); else x.fill(0);
    const g = this.g, p = this.p;
    let inPk = 0;

    // input gain, gate, compressor (sample loop)
    for (let i = 0; i < n; i++) {
      let s = x[i] * g.in.step();
      const a = Math.abs(s); if (a > inPk) inPk = a;
      // gate
      const wg = g.wGate.step();
      this.gateEnv += (a > this.gateEnv ? 0.05 : 0.0008) * (a - this.gateEnv);
      if (this.gateEnv > this.gateThr) { this.gateOpen = true; this.gateHold = 0.04 * this.sr; }
      else if (this.gateEnv < this.gateThr * 0.6) { if (this.gateHold > 0) this.gateHold--; else this.gateOpen = false; }
      this.gateGain += (this.gateOpen ? 0.02 : this.gateRel) * ((this.gateOpen ? 1 : 0) - this.gateGain);
      s = s * (1 - wg + wg * this.gateGain);
      // compressor (feed-forward, peak-ish detector)
      const wc = g.wComp.step();
      const lvl = Math.abs(s);
      this.compEnv += (lvl > this.compEnv ? this.compAtk : this.compRel) * (lvl - this.compEnv);
      const envDb = 20 * Math.log10(this.compEnv + 1e-9);
      const over = envDb - this.compThr;
      const grDb = over > 0 ? over * (1 - 1 / this.compRatio) : 0;
      this.compGR = grDb;
      const cg = dbToLin(-grDb) * this.compMakeup * g.compLvl.step();
      const cm = g.compMix.step();
      const compd = s * cg * cm + s * (1 - cm);
      s = s * (1 - wc) + compd * wc;
      x[i] = s;
    }
    if (out1) out1.set(x.subarray(0, n)); // clean DI

    // drive (bass-friendly: blend keeps the low end clean)
    for (let i = 0; i < n; i++) {
      const wd = g.wDrive.step();
      const s = x[i];
      if (wd > 1e-4) {
        let d = this.drvHP.hp(s) * this.drvPre;
        d = d > 0 ? Math.tanh(d) : Math.tanh(d * 0.8) / 0.8 * 0.9; // mild asymmetry
        d = this.drvDC.hp(d);
        d = this.drvTone.lp(d) * 0.5 * g.drvLvl.step();
        const mix = g.drvMix.step();
        const wet = d * mix + s * (1 - mix);
        x[i] = s * (1 - wd) + wet * wd;
      } else { g.drvLvl.step(); g.drvMix.step(); }
    }

    if (!p.bypass) {
      // NAM pedal
      const ped = this.slots.pedal;
      if ((p['pedal.on'] || g.wPedal.v > 1e-4) && ped.active) {
        const pi = this.b2, po = this.b3;
        for (let i = 0; i < n; i++) pi[i] = x[i] * g.pedIn.step();
        ped.run(pi, po, n, this.sr);
        for (let i = 0; i < n; i++) { const w = g.wPedal.step(); x[i] = x[i] * (1 - w) + po[i] * g.pedOut.step() * w; }
      } else g.wPedal.v = g.wPedal.t;

      // NAM amp (or the built-in tube when no model is loaded)
      const amp = this.slots.amp;
      const ai = this.b2, ao = this.b3;
      for (let i = 0; i < n; i++) ai[i] = x[i] * g.ampIn.step();
      if (amp.active) amp.run(ai, ao, n, this.sr);
      else {
        for (let i = 0; i < n; i++) {
          let s = ai[i] * 2.2;
          s = Math.tanh(s + 0.12) - 0.1194; // biased soft clip: warm even harmonics
          s = this.tubeDC.hp(s);
          ao[i] = this.tubeLP.lp(s) * 0.8;
        }
      }
      let outPk = 0;
      for (let i = 0; i < n; i++) {
        const w = g.wAmp.step();
        const y = x[i] * (1 - w) + ao[i] * g.ampOut.step() * w;
        out0[i] = y; const a = Math.abs(y); if (a > outPk) outPk = a;
      }
      this.meter.outPk = Math.max(this.meter.outPk, outPk);
    } else {
      out0.set(x.subarray(0, n));
    }

    this.meter.inPk = Math.max(this.meter.inPk, inPk);
    this.meter.ms += Date.now() - t0; this.meter.budget += n / this.sr * 1000;
    if (this.meter.budget > 500) { this.meter.cpu = this.meter.ms / this.meter.budget; this.meter.ms = 0; this.meter.budget = 0; }
    if (currentTime - this.lastReport > 0.06) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: 'meter', inPk: this.meter.inPk, outPk: this.meter.outPk, gr: this.compGR, gate: this.gateOpen && p['gate.on'], cpu: this.meter.cpu });
      this.meter.inPk = 0; this.meter.outPk = 0;
    }
    return true;
  }
}

registerProcessor('profondo-front', ProfondoFront);
