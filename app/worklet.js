// Profondo — front-end AudioWorklet: pedalboard (any order: gate, comp, drive, octaver, env filter, chorus, NAM pedals) → NAM amp
import { DSP, Sm } from './pedal-dsp.js';
// Output 0: amp path (mono). Output 1: clean DI = signal after the leading gate/comp pedals (for the clean blend).
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
    this.bufA = new Float32Array(BLOCK_MAX); this.bufB = new Float32Array(BLOCK_MAX); this.bufC = new Float32Array(BLOCK_MAX); }
  // input calibration: scale what the model sees so the user's interface matches the capture's dBu reference
  feed(entry, x, out, n) {
    const c = entry.calib ?? 1;
    if (c === 1) { entry.inst.process(x, out, n); return; }
    const b = this.bufC; for (let i = 0; i < n; i++) b[i] = x[i] * c;
    entry.inst.process(b, out, n);
  }
  set(entry) {
    if (entry === this.cur) return;
    this.prev = this.cur; this.prevGain = this.gain.v; this.cur = entry; this.fade = 0;
    this.gain.v = this.gain.t = entry ? entry.norm : 1; // new model starts at its own normalized level
  }
  get active() { return !!(this.cur || (this.prev && this.fade < 1)); }
  run(x, out, n, sr) {
    const fadeLen = 0.02 * sr;
    if (this.cur) this.feed(this.cur, x, this.bufA, n); else this.bufA.set(x.subarray(0, n));
    this.gain.t = this.cur ? this.cur.norm : 1;
    if (this.fade < 1) {
      if (this.prev) this.feed(this.prev, x, this.bufB, n); else this.bufB.set(x.subarray(0, n));
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

// One pedal on the board: on/off crossfade around its DSP (or around a NAM slot for NAM pedals)
class PedalHost {
  constructor(proc, uid, type) {
    this.proc = proc; this.uid = uid; this.type = type; this.variant = ''; this.p = {};
    this.dsp = DSP[type] ? new DSP[type](proc.sr) : null;
    this.w = new Sm(0); this.inG = new Sm(1); this.outG = new Sm(1);
    this.tmp = new Float32Array(BLOCK_MAX); this.tin = new Float32Array(BLOCK_MAX);
  }
  get slotKey() { return 'nam:' + this.uid; }
  set(m) {
    if (m.on !== undefined) this.w.t = m.on ? 1 : 0;
    if (m.variant !== undefined) this.variant = m.variant;
    if (m.p) Object.assign(this.p, m.p);
    if (this.dsp) this.dsp.set(this.variant, this.p);
    else { this.inG.t = dbToLin(this.p.input ?? 0); this.outG.t = dbToLin(this.p.level ?? 0); }
  }
  run(x, n) {
    if (this.w.t === 0 && this.w.v < 1e-4) { this.w.v = 0; return; }
    const t = this.tmp;
    if (!this.dsp) {
      const slot = this.proc.slots[this.slotKey];
      if (!slot || !slot.active) { for (let i = 0; i < n; i++) this.w.next(0.003); return; }
      const a = this.tin;
      for (let i = 0; i < n; i++) a[i] = x[i] * this.inG.next();
      slot.run(a, t, n, this.proc.sr);
      for (let i = 0; i < n; i++) t[i] *= this.outG.next();
    } else { t.set(x.subarray(0, n)); this.dsp.process(t, n); }
    for (let i = 0; i < n; i++) { const w = this.w.next(0.003); x[i] = x[i] * (1 - w) + t[i] * w; }
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
    this.slots = { amp: new Slot() };
    this.board = []; this.boardMap = new Map();
    this.p = { 'in.gain': 0, 'amp.on': 1, 'amp.input': 0, 'amp.output': 0, 'normalize': 1, 'bypass': 0, 'calib.on': 0, 'calib.dbu': 12 };
    this.g = { in: new Smooth(1), ampIn: new Smooth(1), ampOut: new Smooth(1), wAmp: new Smooth(1) };
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
    g.ampIn.t = dbToLin(p['amp.input']); g.ampOut.t = dbToLin(p['amp.output']);
    g.wAmp.t = p['amp.on'] ? 1 : 0;
    if (this.cache) for (const e of this.cache.values()) this.updateNorm(e);
  }
  slot(key) { return this.slots[key] || (this.slots[key] = new Slot()); }
  setBoard(list) {
    const map = new Map();
    for (const it of list) {
      let h = this.boardMap.get(it.uid);
      if (!h || h.type !== it.type) h = new PedalHost(this, it.uid, it.type);
      h.set(it); map.set(it.uid, h);
    }
    for (const [uid, h] of this.boardMap) if (!map.has(uid) && !h.dsp) { const sl = this.slots['nam:' + uid]; if (sl) sl.set(null); }
    this.boardMap = map; this.board = list.map((it) => map.get(it.uid));
    // the clean DI is taken after the leading dynamics (gate / comp) pedals
    let k = 0; while (k < this.board.length && (this.board[k].type === 'gate' || this.board[k].type === 'comp')) k++;
    this.diIndex = k;
  }

  updateNorm(entry) {
    if (!entry) return;
    const L = entry.info.loudness;
    entry.norm = (this.p.normalize && L < 900) ? dbToLin(-18 - L) : 1;
    const IL = entry.info.inputLevel; // dBu that hit 0 dBFS when the capture was made
    entry.calib = (this.p['calib.on'] && IL < 900) ? dbToLin(this.p['calib.dbu'] - IL) : 1;
  }

  onMsg(m) {
    try {
      if (m.type === 'wasm') { this.module = new WebAssembly.Module(m.bytes); for (let i = 0; i < 6; i++) this.pool.push(new NamInstance(this.module)); this.port.postMessage({ type: 'ready' }); }
      else if (m.type === 'params') { Object.assign(this.p, m.p); this.applyAll(); }
      else if (m.type === 'board') this.setBoard(m.list);
      else if (m.type === 'pedal') { const h = this.boardMap.get(m.uid); if (h) h.set(m); }
      else if (m.type === 'adopt') { // snapshot built by the loader worker; key is per slot so pedal and amp never share state
        const key = m.slot + ':' + m.id;
        let entry = this.cache.get(key); const t0 = Date.now();
        if (!entry) {
          if (!this.module) throw new Error('engine not ready');
          if (this.cache.size >= 16) { // evict the oldest unused model and recycle its instance
            const used = new Set(); for (const sl of Object.values(this.slots)) { used.add(sl.cur); used.add(sl.prev); }
            for (const [k, v] of this.cache) { if (!used.has(v) && v.inst.ready) { this.cache.delete(k); this.pool.push(v.inst); break; } }
          }
          const inst = (this.pool.pop() || new NamInstance(this.module)).begin(m.snapshot);
          entry = { inst, info: m.info, norm: 1, id: m.id, key };
          this.cache.set(key, entry);
          this.adopting.push({ entry, slot: m.slot, activate: m.activate, req: m.req, id: m.id, t0, instMs: Date.now() - t0 });
          this.updateNorm(entry);
          return; // finished (and reported) in process(), a slice per render quantum
        }
        this.updateNorm(entry);
        if (m.activate) this.slot(m.slot).set(entry);
        this.port.postMessage({ type: 'loaded', slot: m.slot, id: m.id, info: entry.info, req: m.req, adoptMs: Date.now() - t0 });
      }
      else if (m.type === 'select') { // already adopted for this slot?
        const entry = this.cache.get(m.slot + ':' + m.id);
        if (entry && entry.inst.ready) { this.updateNorm(entry); this.slot(m.slot).set(entry); this.port.postMessage({ type: 'loaded', slot: m.slot, id: m.id, info: entry.info, req: m.req }); }
        else this.port.postMessage({ type: 'miss', slot: m.slot, id: m.id, req: m.req });
      }
      else if (m.type === 'debug') {
        const insts = Object.values(this.slots).map((sl) => sl.cur).filter(Boolean).map((e) => e.inst);
        const a = this.slots.amp.cur;
        this.port.postMessage({ type: 'debug', req: m.req, shared: new Set(insts).size !== insts.length, ampNorm: a ? a.norm : null, ampGain: this.slots.amp.gain.v, cache: [...this.cache.keys()], board: this.board.map((h) => h.type + ':' + h.uid), di: this.diIndex });
      }
      else if (m.type === 'unload') { this.slot(m.slot).set(null); this.port.postMessage({ type: 'unloaded', slot: m.slot }); }
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
        if (a.activate) this.slot(a.slot).set(a.entry);
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

    for (let i = 0; i < n; i++) { const v = x[i] * g.in.step(); x[i] = v; const a = Math.abs(v); if (a > inPk) inPk = a; }

    if (!p.bypass) {
      // pedalboard; the clean DI is tapped after the leading gate / comp pedals
      const board = this.board, di = this.diIndex || 0;
      for (let k = 0; k < board.length; k++) {
        if (k === di && out1) out1.set(x.subarray(0, n));
        board[k].run(x, n);
      }
      if (di >= board.length && out1) out1.set(x.subarray(0, n));

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
      out0.set(x.subarray(0, n)); if (out1) out1.set(x.subarray(0, n));
    }

    this.meter.inPk = Math.max(this.meter.inPk, inPk);
    this.meter.ms += Date.now() - t0; this.meter.budget += n / this.sr * 1000;
    if (this.meter.budget > 500) { this.meter.cpu = this.meter.ms / this.meter.budget; this.meter.ms = 0; this.meter.budget = 0; }
    if (currentTime - this.lastReport > 0.06) {
      this.lastReport = currentTime;
      const gr = {}; for (const h of this.board) if (h.dsp && h.dsp.gr !== undefined) gr[h.uid] = h.w.t ? h.dsp.gr : 0;
      this.port.postMessage({ type: 'meter', inPk: this.meter.inPk, outPk: this.meter.outPk, gr, cpu: this.meter.cpu });
      this.meter.inPk = 0; this.meter.outPk = 0;
    }
    return true;
  }
}

registerProcessor('profondo-front', ProfondoFront);
