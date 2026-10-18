// Profondo — Web Audio graph
import { makeCabIR, makeRoomIR, normalizeIR } from './irs.js';

const dB = (v) => Math.pow(10, v / 20);
const DIVS = { '1/2': 2, '1/4.': 1.5, '1/4': 1, '1/4T': 2 / 3, '1/8.': 0.75, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25 };
export const DIV_NAMES = Object.keys(DIVS);

export class Engine {
  constructor() {
    this.ctx = null; this.front = null; this.p = {};
    this.listeners = {}; this.pending = new Map(); this.reqId = 1;
    this.inputChannel = 0; this.stream = null; this.irCache = new Map();
  }
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, d) { (this.listeners[ev] || []).forEach((f) => f(d)); }

  async init(wasmUrl = 'nam.wasm', sampleRate = 48000) {
    const ctx = this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('worklet.js');
    const front = this.front = new AudioWorkletNode(ctx, 'profondo-front', {
      numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [1, 1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    front.port.onmessage = (e) => this.onWorklet(e.data);
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    // The worklet compiles its own copy (a WebAssembly.Module is not reliably delivered to AudioWorkletGlobalScope).
    const ready = new Promise((res, rej) => { this._ready = res; setTimeout(() => rej(new Error('NAM engine did not start (WebAssembly)')), 15000); });
    front.port.postMessage({ type: 'wasm', bytes: bytes.slice(0) });
    // Models are built and prewarmed in a Worker, off the audio thread.
    this.loader = new Worker('nam-loader-worker.js');
    this.loaderPending = new Map();
    const loaderReady = new Promise((res) => { this._loaderReady = res; });
    this.loader.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') return this._loaderReady();
      const pr = this.loaderPending.get(m.req); if (!pr) return;
      this.loaderPending.delete(m.req);
      m.type === 'error' ? pr.reject(new Error(m.message)) : pr.resolve(m);
    };
    this.loader.postMessage({ type: 'init', bytes }, [bytes]);
    await Promise.all([ready, loaderReady]);
    this.build();
    return this;
  }

  onWorklet(m) {
    if (m.type === 'ready') return this._ready && this._ready();
    if (m.type === 'meter') return this.emit('meter', m);
    const pr = m.req && this.pending.get(m.req);
    if (pr) { this.pending.delete(m.req); m.type === 'error' ? pr.reject(new Error(m.message)) : pr.resolve(m); }
  }
  _req(msg, transfer) {
    const req = this.reqId++;
    return new Promise((resolve, reject) => { this.pending.set(req, { resolve, reject }); this.front.port.postMessage({ ...msg, req }, transfer || []); });
  }
  // Build in the worker, then hand the prewarmed snapshot to the worklet. activate=false only caches it.
  async loadModel(slot, id, bytes, activate = true) {
    const req = this.reqId++;
    const copy = bytes.slice(0);
    const built = await new Promise((resolve, reject) => { this.loaderPending.set(req, { resolve, reject }); this.loader.postMessage({ type: 'load', req, bytes: copy, sampleRate: this.ctx.sampleRate }, [copy]); });
    return this._req({ type: 'adopt', slot, id, activate, info: built.info, snapshot: built.snapshot }, [built.snapshot]);
  }
  selectModel(slot, id) { return this._req({ type: 'select', slot, id }); }
  unloadModel(slot) { this.front.port.postMessage({ type: 'unload', slot }); }

  build() {
    const c = this.ctx; const n = (t, o = {}) => Object.assign(c[t](), o);
    const bq = (type, f, q = 0.707, g = 0) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b; };

    this.inGain = n('createGain');
    this.splitter = c.createChannelSplitter(2);
    this.tunerAnalyser = n('createAnalyser', { fftSize: 8192 });
    this.inGain.connect(this.front); this.inGain.connect(this.tunerAnalyser);

    // EQ (bass voiced)
    this.eq = { bass: bq('lowshelf', 80), lowmid: bq('peaking', 250, 0.9), mid: bq('peaking', 600, 0.8), treble: bq('highshelf', 2500), presence: bq('peaking', 5500, 0.9) };
    this.front.connect(this.eq.bass, 0);
    this.eq.bass.connect(this.eq.lowmid); this.eq.lowmid.connect(this.eq.mid); this.eq.mid.connect(this.eq.treble); this.eq.treble.connect(this.eq.presence);

    // Cab (convolver with bypass)
    this.cabConv = n('createConvolver', { normalize: false });
    this.cabWet = n('createGain'); this.cabDry = n('createGain'); this.cabOut = n('createGain');
    this.eq.presence.connect(this.cabConv); this.cabConv.connect(this.cabWet); this.cabWet.connect(this.cabOut);
    this.eq.presence.connect(this.cabDry); this.cabDry.connect(this.cabOut);

    // Clean blend with optional crossover (lows stay clean)
    this.ampHP = bq('highpass', 10, 0.707); this.ampBlend = n('createGain');
    this.cabOut.connect(this.ampHP); this.ampHP.connect(this.ampBlend);
    this.cleanLP = bq('lowpass', 20000, 0.707); this.cleanBlend = n('createGain');
    // clean path: alignment delay + polarity, so the DI lines up with the (delayed) amp + cab path
    this.cleanDelay = c.createDelay(0.05); this.cleanDelay.delayTime.value = 0;
    this.cleanPol = n('createGain');
    this.front.connect(this.cleanDelay, 1); this.cleanDelay.connect(this.cleanPol); this.cleanPol.connect(this.cleanLP); this.cleanLP.connect(this.cleanBlend);
    // taps for automatic alignment (raw clean DI vs amp+cab output)
    this.alignClean = n('createAnalyser', { fftSize: 8192 }); this.alignAmp = n('createAnalyser', { fftSize: 8192 });
    this.front.connect(this.alignClean, 1); this.cabOut.connect(this.alignAmp);

    this.bypassGain = n('createGain'); this.bypassGain.gain.value = 0;
    this.inGain.connect(this.bypassGain);

    this.bus = n('createGain', { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.ampBlend.connect(this.bus); this.cleanBlend.connect(this.bus); this.bypassGain.connect(this.bus);

    // Tape delay (stereo, ping-pong capable)
    const D = this.delay = {};
    D.send = n('createGain'); D.inSplit = c.createChannelSplitter(2); D.mono = n('createGain', { channelCount: 1, channelCountMode: 'explicit' });
    D.dl = c.createDelay(4); D.dr = c.createDelay(4);
    D.fbL = n('createGain'); D.fbR = n('createGain'); D.xL = n('createGain'); D.xR = n('createGain');
    D.hiL = bq('lowpass', 3500); D.hiR = bq('lowpass', 3500); D.loL = bq('highpass', 120); D.loR = bq('highpass', 120);
    D.inL = n('createGain'); D.inR = n('createGain');
    D.panL = c.createStereoPanner(); D.panR = c.createStereoPanner();
    D.wet = n('createGain');
    D.wow = c.createOscillator(); D.wowDepth = n('createGain'); D.wow.frequency.value = 0.55; D.wow.connect(D.wowDepth); D.wowDepth.connect(D.dl.delayTime); D.wowDepth.connect(D.dr.delayTime); D.wow.start();
    this.bus.connect(D.send); D.send.connect(D.mono);
    D.mono.connect(D.inL); D.mono.connect(D.inR); D.inL.connect(D.dl); D.inR.connect(D.dr);
    // loop: delay -> hi roll -> low cut -> (self fb | cross fb)
    D.dl.connect(D.hiL); D.hiL.connect(D.loL); D.dr.connect(D.hiR); D.hiR.connect(D.loR);
    D.loL.connect(D.fbL); D.fbL.connect(D.dl); D.loR.connect(D.fbR); D.fbR.connect(D.dr);
    D.loL.connect(D.xL); D.xL.connect(D.dr); D.loR.connect(D.xR); D.xR.connect(D.dl);
    D.loL.connect(D.panL); D.loR.connect(D.panR); D.panL.connect(D.wet); D.panR.connect(D.wet);

    // Reverb
    const R = this.rev = {};
    R.send = n('createGain'); R.pre = c.createDelay(0.5); R.conv = n('createConvolver', { normalize: false });
    R.lo = bq('highpass', 150); R.hi = bq('lowpass', 6000); R.wet = n('createGain');
    this.bus.connect(R.send); R.send.connect(R.pre); R.pre.connect(R.lo); R.lo.connect(R.hi); R.hi.connect(R.conv); R.conv.connect(R.wet);
    D.wet.connect(R.send); // delay feeds the reverb too

    // Master + safety limiter
    this.master = n('createGain', { channelCount: 2, channelCountMode: 'explicit' });
    this.bus.connect(this.master); D.wet.connect(this.master); R.wet.connect(this.master);
    this.limiter = c.createDynamicsCompressor();
    Object.assign(this.limiter, {}); this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.1;
    this.outAnalyser = n('createAnalyser', { fftSize: 1024 });
    this.master.connect(this.limiter); this.limiter.connect(this.outAnalyser); this.limiter.connect(c.destination);
  }

  // ---------- parameters ----------
  set(id, v) { this.p[id] = v; this.apply([id]); }
  setMany(obj) { Object.assign(this.p, obj); this.apply(Object.keys(obj)); }
  apply(ids) {
    const p = this.p, c = this.ctx, t = c.currentTime, T = 0.02;
    const ramp = (param, v) => param.setTargetAtTime(v, t, T);
    const front = {};
    for (const id of ids) if (/^(in\.|gate\.|comp\.|drive\.|pedal\.|amp\.|normalize|bypass)/.test(id) && id !== 'in.channel') front[id] = typeof p[id] === 'boolean' ? (p[id] ? 1 : 0) : p[id];
    if (Object.keys(front).length) this.front.port.postMessage({ type: 'params', p: front });

    const eqOn = p['eq.on'] !== false && !p.bypass;
    ramp(this.eq.bass.gain, eqOn ? p['eq.bass'] ?? 0 : 0);
    ramp(this.eq.lowmid.gain, eqOn ? p['eq.lowmid'] ?? 0 : 0);
    ramp(this.eq.mid.gain, eqOn ? p['eq.mid'] ?? 0 : 0);
    ramp(this.eq.mid.frequency, p['eq.midfreq'] ?? 600);
    ramp(this.eq.treble.gain, eqOn ? p['eq.treble'] ?? 0 : 0);
    ramp(this.eq.presence.gain, eqOn ? p['eq.presence'] ?? 0 : 0);

    const cabOn = p['cab.on'] !== false && !p.bypass;
    const cl = dB(p['cab.level'] ?? 0);
    ramp(this.cabWet.gain, cabOn ? cl : 0); ramp(this.cabDry.gain, cabOn ? 0 : 1);

    const blend = (p['blend.amount'] ?? 0) / 100, xo = p['blend.xover'] ?? 0;
    const bp = !!p.bypass;
    // X-over off: equal-power mix of clean DI and amp (full band).
    // X-over on: the amp keeps everything above the crossover; below it, the clean DI is mixed in by Blend.
    const xOn = xo >= 30;
    ramp(this.ampHP.frequency, xOn && blend > 0 ? xo : 10); ramp(this.cleanLP.frequency, xOn ? xo : 20000);
    this.cleanLP.Q.value = xOn ? 0.5 : 0.707; this.ampHP.Q.value = xOn ? 0.5 : 0.707;
    ramp(this.ampBlend.gain, bp ? 0 : xOn ? 1 : Math.cos(blend * Math.PI / 2));
    ramp(this.cleanBlend.gain, bp ? 0 : xOn ? blend : Math.sin(blend * Math.PI / 2));
    ramp(this.bypassGain.gain, bp ? 1 : 0);
    this.cleanDelay.delayTime.setTargetAtTime((p['blend.align'] ?? 0) / 1000, t, 0.01);
    ramp(this.cleanPol.gain, p['blend.phase'] ? -1 : 1);

    // delay
    const D = this.delay;
    const dOn = !!p['delay.on'] && !bp;
    const time = this.delayTime() / 1000;
    ramp(D.dl.delayTime, time); ramp(D.dr.delayTime, p['delay.pingpong'] ? time : time * (1 + (p['delay.width'] ?? 0) / 400));
    const fb = (p['delay.feedback'] ?? 30) / 100;
    const pp = !!p['delay.pingpong'];
    ramp(D.fbL.gain, pp ? 0 : fb); ramp(D.fbR.gain, pp ? 0 : fb); ramp(D.xL.gain, pp ? fb : 0); ramp(D.xR.gain, pp ? fb : 0);
    ramp(D.inR.gain, pp ? 0 : 1);
    const w = (p['delay.width'] ?? 40) / 100;
    ramp(D.panL.pan, -w); ramp(D.panR.pan, w);
    ramp(D.hiL.frequency, p['delay.hiroll'] ?? 3500); ramp(D.hiR.frequency, p['delay.hiroll'] ?? 3500);
    ramp(D.loL.frequency, p['delay.locut'] ?? 120); ramp(D.loR.frequency, p['delay.locut'] ?? 120);
    ramp(D.wowDepth.gain, (p['delay.wow'] ?? 2) * 0.0004);
    ramp(D.send.gain, dOn ? 1 : 0); // trails: switching off stops the send, echoes ring out
    ramp(D.wet.gain, dB(p['delay.level'] ?? -18));

    const R = this.rev;
    const rOn = !!p['rev.on'] && !bp;
    ramp(R.send.gain, rOn ? 1 : 0);
    ramp(R.wet.gain, dB(p['rev.level'] ?? -20));
    ramp(R.pre.delayTime, (p['rev.predelay'] ?? 20) / 1000);
    ramp(R.hi.frequency, p['rev.hiroll'] ?? 6000); ramp(R.lo.frequency, p['rev.locut'] ?? 150);

    ramp(this.master.gain, dB(p['master.vol'] ?? 0));
  }
  // Measure the delay (and polarity) of the amp + cab path relative to the clean DI by
  // cross-correlating their low frequencies while the player plays. Returns {ms, invert, confidence}.
  async measureAlignment(durationMs = 1500, onProgress) {
    const sr = this.ctx.sampleRate, L = this.alignClean.fftSize, maxLag = Math.floor(0.02 * sr);
    const a = new Float32Array(L), b = new Float32Array(L), corr = new Float64Array(maxLag + 1);
    let eA = 0, eB = 0, frames = 0;
    const lp = (x) => { // 2x one-pole low-pass ~400 Hz: the crossover region is what matters
      const k = 1 - Math.exp(-2 * Math.PI * 400 / sr); let y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) { y1 += k * (x[i] - y1); y2 += k * (y1 - y2); x[i] = y2; }
      let m = 0; for (let i = 0; i < x.length; i++) m += x[i]; m /= x.length; for (let i = 0; i < x.length; i++) x[i] -= m;
    };
    const t0 = performance.now(); let last = -1;
    while (performance.now() - t0 < durationMs) {
      await new Promise((r) => setTimeout(r, Math.max(20, (L / sr) * 1000 * 0.9)));
      const stamp = this.ctx.currentTime; if (stamp === last) continue; last = stamp;
      this.alignClean.getFloatTimeDomainData(a); this.alignAmp.getFloatTimeDomainData(b);
      lp(a); lp(b);
      let ea = 0, eb = 0; for (let i = 0; i < L; i++) { ea += a[i] * a[i]; eb += b[i] * b[i]; }
      if (ea < 1e-4 || eb < 1e-6) continue; // not playing
      const W = L - maxLag;
      for (let lag = 0; lag <= maxLag; lag++) { let s = 0; for (let i = 0; i < W; i++) s += a[i] * b[i + lag]; corr[lag] += s / Math.sqrt(ea * eb); }
      eA += ea; eB += eb; frames++;
      onProgress?.(Math.min(1, (performance.now() - t0) / durationMs));
    }
    if (frames < 2) return null;
    let best = 0, bv = 0; for (let lag = 0; lag <= maxLag; lag++) if (Math.abs(corr[lag]) > Math.abs(bv)) { bv = corr[lag]; best = lag; }
    return { ms: Math.round(best / sr * 1000 * 100) / 100, invert: bv < 0, confidence: Math.min(1, Math.abs(bv) / frames) };
  }
  delayTime() {
    const p = this.p;
    if (p['delay.sync']) return Math.min(3900, 60000 / (p.bpm || 120) * (DIVS[p['delay.div']] ?? 1));
    return p['delay.time'] ?? 380;
  }

  // ---------- IRs ----------
  async setCabBuiltin(id) { const b = this.irCache.get(id) || await makeCabIR(id, this.ctx.sampleRate); this.irCache.set(id, b); this.cabConv.buffer = b; }
  setRoomBuiltin(id) { const b = this.irCache.get(id) || makeRoomIR(this.ctx, id); this.irCache.set(id, b); this.rev.conv.buffer = b; }
  async decodeIR(bytes, maxSec) {
    const buf = await this.ctx.decodeAudioData(bytes.slice(0));
    const len = Math.min(buf.length, Math.floor(maxSec * buf.sampleRate));
    const out = this.ctx.createBuffer(Math.min(2, buf.numberOfChannels), len, buf.sampleRate);
    for (let ch = 0; ch < out.numberOfChannels; ch++) out.getChannelData(ch).set(buf.getChannelData(ch).subarray(0, len));
    return normalizeIR(out);
  }
  async setCabFile(id, bytes) { const b = this.irCache.get(id) || await this.decodeIR(bytes, 0.25); this.irCache.set(id, b); this.cabConv.buffer = b; return b; }
  async setRoomFile(id, bytes) { const b = this.irCache.get(id) || await this.decodeIR(bytes, 10); this.irCache.set(id, b); this.rev.conv.buffer = b; return b; }

  // ---------- I/O ----------
  async startInput(deviceId, channel = 0) {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.srcNode) this.srcNode.disconnect();
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: { ideal: 0 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.srcNode = this.ctx.createMediaStreamSource(this.stream);
    this.srcNode.connect(this.splitter);
    this.setInputChannel(channel);
    await this.ctx.resume();
    const tr = this.stream.getAudioTracks()[0];
    return tr ? tr.getSettings() : {};
  }
  setInputChannel(ch) {
    this.inputChannel = ch;
    try { this.splitter.disconnect(); } catch {}
    const chans = this.srcNode ? (this.stream.getAudioTracks()[0]?.getSettings().channelCount || 2) : 2;
    this.splitter.connect(this.inGain, Math.min(ch, Math.max(0, chans - 1)));
  }
  async setOutput(deviceId) { if (this.ctx.setSinkId) await this.ctx.setSinkId(deviceId || ''); }
  latencyMs() { const c = this.ctx; const s = this.stream?.getAudioTracks()[0]?.getSettings(); return Math.round(((c.baseLatency || 0) + (c.outputLatency || 0) + (s?.latency || 0)) * 1000 * 10) / 10; }
}
