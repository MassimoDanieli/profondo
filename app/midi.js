// MIDI: learn, CC / note mappings, Program Change -> presets, MIDI clock -> BPM.
import { LS } from './store.js';

export class Midi {
  constructor(handlers) {
    this.h = handlers; // { onTarget(target, value01, raw, mapping), onProgram(n), onClockBpm(bpm), onActivity(msg), onLearned(map) }
    this.access = null; this.maps = LS.get('midi.maps', []);
    this.settings = LS.get('midi.settings', { channel: 0, pc: true, clock: false, inputs: {} });
    this.learnTarget = null; this.clockTimes = [];
    this.lastVals = new Map();
  }
  get supported() { return !!navigator.requestMIDIAccess; }
  async enable() {
    if (!this.supported) throw new Error('Web MIDI non supportato da questo browser (usa Chrome, Edge o Firefox).');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => { this.bind(); this.h.onDevices?.(this.inputs()); };
    this.bind();
    return this.inputs();
  }
  inputs() { return this.access ? [...this.access.inputs.values()].map((i) => ({ id: i.id, name: i.name, state: i.state, on: this.settings.inputs[i.id] !== false })) : []; }
  setInputEnabled(id, on) { this.settings.inputs[id] = on; this.save(); this.bind(); }
  bind() {
    if (!this.access) return;
    for (const i of this.access.inputs.values()) i.onmidimessage = this.settings.inputs[i.id] === false ? null : (e) => this.onMessage(e.data);
  }
  save() { LS.set('midi.maps', this.maps); LS.set('midi.settings', this.settings); }

  startLearn(target) { this.learnTarget = target; }
  stopLearn() { this.learnTarget = null; }
  removeMap(i) { this.maps.splice(i, 1); this.save(); }
  clearMapsFor(target) { this.maps = this.maps.filter((m) => m.target !== target); this.save(); }

  onMessage(d) {
    const st = d[0];
    if (st === 0xf8) return this.clockTick();
    if (st === 0xfa || st === 0xfc) { this.clockTimes = []; return; }
    if (st >= 0xf0) return;
    const type = st & 0xf0, ch = (st & 0x0f) + 1;
    if (this.settings.channel && ch !== this.settings.channel) return;
    let src = null, val = 0;
    if (type === 0xb0) { src = { kind: 'cc', ch, num: d[1] }; val = d[2]; }
    else if (type === 0x90 && d[2] > 0) { src = { kind: 'note', ch, num: d[1] }; val = 127; }
    else if (type === 0x80 || (type === 0x90 && d[2] === 0)) { src = { kind: 'note', ch, num: d[1] }; val = 0; }
    else if (type === 0xc0) {
      this.h.onActivity?.(`PC ${d[1] + 1} · ch ${ch}`);
      if (this.learnTarget && this.learnTarget.startsWith('preset:')) return; // PC is automatic
      if (this.settings.pc) this.h.onProgram?.(d[1]);
      return;
    }
    if (!src) return;
    this.h.onActivity?.(`${src.kind.toUpperCase()} ${src.num} = ${val} · ch ${ch}`);

    if (this.learnTarget && val > 0) {
      const target = this.learnTarget; this.learnTarget = null;
      this.maps = this.maps.filter((m) => !(m.kind === src.kind && m.num === src.num && m.ch === src.ch));
      const map = { ...src, target, mode: 'press' };
      this.maps.push(map); this.save();
      this.h.onLearned?.(map);
      return;
    }
    const key = `${src.kind}:${src.ch}:${src.num}`;
    const prev = this.lastVals.get(key) ?? 0; this.lastVals.set(key, val);
    for (const m of this.maps) {
      if (m.kind !== src.kind || m.num !== src.num || m.ch !== src.ch) continue;
      this.h.onTarget?.(m.target, val / 127, { val, prev }, m);
    }
  }

  clockTick() {
    const t = performance.now();
    this.clockTimes.push(t);
    if (this.clockTimes.length > 97) this.clockTimes.shift();
    if (this.clockTimes.length >= 25 && this.settings.clock) {
      const span = this.clockTimes[this.clockTimes.length - 1] - this.clockTimes[0];
      const beats = (this.clockTimes.length - 1) / 24;
      const bpm = Math.round(60000 / (span / beats) * 10) / 10;
      if (Math.abs(bpm - (this._lastBpm || 0)) >= 0.5) { this._lastBpm = bpm; this.h.onClockBpm?.(bpm); }
    }
  }
  describe(m) { return `${m.kind === 'cc' ? 'CC' : 'Note'} ${m.num} · ch ${m.ch}`; }
}
