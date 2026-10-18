// Profondo — UI, state, presets, MIDI wiring
import { Engine, DIV_NAMES } from './engine.js';
import { CAB_PRESETS, ROOM_PRESETS } from './irs.js';
import { Library, LS, hashBytes } from './store.js';
import { Midi } from './midi.js';
import { detectPitch, noteOf } from './tuner.js';
import { PEDALS, PEDAL_ORDER, MAX_PEDALS, NAM_CATS, namCategory, newUid, variantsOf, paramsFor, pedalDefaults, LEGACY_BOARD, LEGACY_KEYS } from './pedals.js';

const VERSION = 'v0.4.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------------- parameter registry ----------------
// id: [label, min, max, default, unit, log]
const P = {
  'amp.input': ['GAIN', -24, 24, 0, 'dB'], 'amp.output': ['AMP OUT', -24, 12, 0, 'dB'],
  'eq.bass': ['BASS', -12, 12, 0, 'dB'], 'eq.lowmid': ['LOW MID', -12, 12, 0, 'dB'], 'eq.mid': ['MID', -12, 12, 0, 'dB'], 'eq.midfreq': ['MID FREQ', 200, 3000, 600, 'Hz', 1],
  'eq.treble': ['TREBLE', -12, 12, 0, 'dB'], 'eq.presence': ['PRESENCE', -12, 12, 0, 'dB'],
  'blend.amount': ['BLEND', 0, 100, 0, '%'], 'blend.xover': ['X-OVER', 0, 400, 0, 'xo'], 'blend.align': ['ALIGN', 0, 20, 0, 'msf'],
  'cab.level': ['LEVEL', -24, 12, 0, 'dB'], 'master.vol': ['OUTPUT', -40, 12, 0, 'dB'],
  'delay.time': ['TIME', 20, 1500, 380, 'ms', 1], 'delay.feedback': ['FEEDBACK', 0, 95, 30, '%'], 'delay.level': ['LEVEL', -40, 0, -18, 'dB'],
  'delay.hiroll': ['HIGH ROLL', 800, 12000, 3500, 'Hz', 1], 'delay.locut': ['LOW CUT', 20, 600, 120, 'Hz', 1], 'delay.wow': ['WOW', 0, 10, 2, ''], 'delay.width': ['WIDTH', 0, 100, 40, '%'],
  'rev.level': ['LEVEL', -40, 0, -20, 'dB'], 'rev.predelay': ['PRE-DELAY', 0, 150, 20, 'ms'], 'rev.hiroll': ['HIGH ROLL', 1000, 16000, 6000, 'Hz', 1], 'rev.locut': ['LOW CUT', 20, 800, 150, 'Hz', 1],
  'in.gain': ['INPUT', -24, 24, 0, 'dB'], 'bpm': ['BPM', 40, 240, 120, ''],
};
const BOOL = { 'amp.on': true, 'eq.on': true, 'cab.on': true, 'delay.on': false, 'rev.on': false,
  'delay.pingpong': false, 'delay.sync': false, 'blend.phase': false, normalize: true, bypass: false };
const ENUM = { 'delay.div': '1/4' };
const POST_BLOCKS = [['amp.on', 'AMP'], ['eq.on', 'EQ'], ['cab.on', 'CAB'], ['delay.on', 'DELAY'], ['rev.on', 'REVERB']];
const SHORT = { gate: 'GATE', comp: 'COMP', drive: 'DRIVE', octave: 'OCT', envf: 'ENV', chorus: 'CHORUS', nam: 'NAM' };
// chain buttons / keys 1–9: the board's pedals, then the fixed blocks
const chainBlocks = () => [...state.board.map((b) => [`pb.${b.uid}.on`, SHORT[b.type] || b.type.toUpperCase()]), ...POST_BLOCKS];
const NOT_IN_PRESET = new Set(['bypass', 'normalize', 'in.gain']);

function defaults() {
  const d = {};
  for (const [k, v] of Object.entries(P)) d[k] = v[3];
  Object.assign(d, BOOL, ENUM);
  return d;
}
// parameter definition for a static id or a pedal id 'pb.<uid>.<key>'
function pdef(id) {
  if (P[id]) return P[id];
  if (!id.startsWith('pb.')) return null;
  const [, uid, key] = id.split('.'); const b = state.board.find((x) => x.uid === uid);
  return b ? PEDALS[b.type].params[key] || null : null;
}
const isBool = (id) => id in BOOL || /^pb\.[^.]+\.on$/.test(id);

// ---------------- factory presets ----------------
const FACTORY = [
  { name: 'Clean DI', params: { 'amp.on': false, 'comp.on': true, 'comp.sustain': 3, 'eq.bass': 2, 'eq.lowmid': -1, 'cab.on': false, 'blend.amount': 0 } },
  { name: 'Warm Tube 8x10', params: { 'comp.on': true, 'amp.input': 4, 'eq.bass': 3, 'eq.mid': 2, 'eq.midfreq': 800, 'eq.treble': -2 } },
  { name: 'Growl Blend', params: { 'comp.on': true, 'drive.on': true, 'drive.gain': 7, 'drive.blend': 55, 'drive.tone': 6, 'eq.mid': 3, 'eq.midfreq': 1000, 'blend.amount': 60, 'blend.xover': 150 }, cab: 'syn-410' },
  { name: 'Dub Room', params: { 'eq.bass': 5, 'eq.treble': -6, 'eq.presence': -4, 'rev.on': true, 'rev.level': -16, 'delay.on': true, 'delay.sync': true, 'delay.div': '1/4.', 'delay.feedback': 45, 'delay.level': -16, 'delay.hiroll': 2000 }, cab: 'syn-115', room: 'rev-dub' },
  { name: 'Funk Envelope', board: [{ type: 'comp', variant: 'opto', on: true, p: { amount: 5 } }, { type: 'envf', variant: 'lp', on: true, p: { sens: 6, range: 6, reso: 6, mix: 85 } }, { type: 'drive', variant: 'tube', on: false }], params: { 'amp.input': 2, 'eq.lowmid': -2, 'eq.treble': 2 }, cab: 'syn-410' },
  { name: 'Sub Octave Dub', board: [{ type: 'comp', variant: 'opto', on: true, p: { amount: 4 } }, { type: 'octave', on: true, p: { sub1: 75, sub2: 20, dry: 70, tone: 3 } }], params: { 'eq.treble': -4, 'eq.presence': -3, 'rev.on': true, 'rev.level': -18 }, cab: 'syn-115', room: 'rev-dub' },
  { name: 'Octave Fuzz Blend', board: [{ type: 'comp', variant: 'vca', on: true, p: { amount: 5 } }, { type: 'drive', variant: 'octfuzz', on: true, p: { gain: 7, tone: 6, blend: 45 } }], params: { 'blend.amount': 60, 'blend.xover': 150, 'eq.mid': 2, 'eq.midfreq': 900 }, cab: 'syn-410' },
  { name: 'Fretless Chorus', board: [{ type: 'comp', variant: 'opto', on: true, p: { amount: 5 } }, { type: 'chorus', on: true, p: { rate: 0.6, depth: 5, mix: 50, xover: 150 } }], params: { 'rev.on': true, 'rev.level': -16, 'eq.presence': 2 }, room: 'rev-plate' },
  { name: 'Ping-Pong Ambient', params: { 'comp.on': true, 'comp.sustain': 6, 'delay.on': true, 'delay.pingpong': true, 'delay.feedback': 55, 'delay.level': -12, 'delay.time': 450, 'rev.on': true, 'rev.level': -12, 'eq.bass': -2 }, room: 'rev-hall' },
];

// ---------------- state ----------------
const state = {
  p: defaults(),
  models: { amp: null, pedal: null, cab: { id: 'syn-810', name: CAB_PRESETS['syn-810'].name, builtin: true }, room: { id: 'rev-studio', name: ROOM_PRESETS['rev-studio'].name, builtin: true } },
  bank: LS.get('bank', null) || FACTORY.map(factoryPreset),
  board: [],
  cur: LS.get('cur', 0), dirty: false, learn: false, tunerOpen: false,
};
let engine = null, started = false;
function factoryPreset(f) { const pr = { name: f.name, params: f.params, board: f.board, amp: null, cab: f.cab || 'syn-810', room: f.room || 'rev-studio' }; if (f.board) { const n = normalizePreset(pr); pr.board = n.board; pr.params = n.params; pr.pedals = {}; } return pr; }
// v0.1 shipped "Clean DI" with the amp left on: fix stored copies that never set it
for (const pr of state.bank) if (pr.name === 'Clean DI' && pr.params && !('amp.on' in pr.params)) pr.params['amp.on'] = false;
const knobs = new Map();
const midi = new Midi({
  onTarget, onProgram: (n) => { if (n < state.bank.length) recall(n); }, onClockBpm: (bpm) => setParam('bpm', bpm),
  onActivity: (s) => { const a = $('#midiAct'); if (a) a.textContent = s; flashMidi(); },
  onLearned: (m) => { $$('.learning').forEach((e) => e.classList.remove('learning')); toast(`Mapped ${midi.describe(m)} → ${targetLabel(m.target)}`); markMapped(); if ($('#midiMaps')) renderMidiMaps(); },
  onDevices: () => { if ($('#midiInputs')) renderMidiInputs(); },
});

// ---------------- formatting ----------------
function fmt(id, v) {
  const u = pdef(id)[4];
  if (u === 'dB') return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  if (u === '%') return Math.round(v) + ' %';
  if (u === 'ms') return Math.round(v) + ' ms';
  if (u === 'msf') return v.toFixed(2) + ' ms';
  if (u === 'Hz') return v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : v < 10 ? v.toFixed(2) + ' Hz' : Math.round(v) + ' Hz';
  if (u === 'xo') return v < 30 ? 'OFF' : Math.round(v) + ' Hz';
  return v.toFixed(1);
}
const toNorm = (id, v) => { const [, mn, mx, , , lg] = pdef(id); return lg ? Math.log(v / mn) / Math.log(mx / mn) : (v - mn) / (mx - mn); };
const fromNorm = (id, t) => { const [, mn, mx, , , lg] = pdef(id); t = Math.max(0, Math.min(1, t)); return lg ? mn * Math.pow(mx / mn, t) : mn + t * (mx - mn); };

// ---------------- knobs ----------------
function buildKnob(el) {
  const id = el.dataset.p; const def = pdef(id);
  if (!def) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '-50 -50 100 100');
  const amp = !!el.closest('.amp');
  let ticks = '';
  for (let i = 0; i <= 10; i++) { const a = (-135 + i * 27) * Math.PI / 180; const r1 = 40, r2 = i % 5 ? 44 : 47; ticks += `<line x1="${Math.sin(a) * r1}" y1="${-Math.cos(a) * r1}" x2="${Math.sin(a) * r2}" y2="${-Math.cos(a) * r2}" stroke="${amp ? '#3b2d10' : '#bdb6a6'}" stroke-width="2" stroke-linecap="round"/>`; }
  svg.innerHTML = `${ticks}<defs><radialGradient id="kg" cx="40%" cy="30%"><stop offset="0" stop-color="#5a5a60"/><stop offset=".6" stop-color="#2a2a2e"/><stop offset="1" stop-color="#141416"/></radialGradient></defs>
    <circle r="35" fill="#0006" cy="3"/><g class="dial"><circle r="34" fill="url(#kg)" stroke="#000" stroke-width="1.5"/><circle r="27" fill="none" stroke="#ffffff10" stroke-width="1"/>
    <line class="ptr" x1="0" y1="-12" x2="0" y2="-31" stroke="#f2ece0" stroke-width="3.5" stroke-linecap="round"/></g>`;
  el.innerHTML = '';
  el.appendChild(svg);
  const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = def[0];
  const val = document.createElement('div'); val.className = 'val';
  el.append(lbl, val);
  const dial = svg.querySelector('.dial');
  knobs.set(id, { el, dial, val });
  el.title = `${def[0]} — drag, wheel, double-click to reset`;

  let startY = 0, startT = 0, dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (state.learn) return;
    dragging = true; startY = e.clientY; startT = toNorm(id, state.p[id]); el.setPointerCapture(e.pointerId); e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const k = e.shiftKey ? 0.0012 : 0.005;
    setParam(id, roundFor(id, fromNorm(id, startT + (startY - e.clientY) * k)));
  });
  const end = () => { dragging = false; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => { e.preventDefault(); setParam(id, roundFor(id, fromNorm(id, toNorm(id, state.p[id]) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02)))); }, { passive: false });
  el.addEventListener('dblclick', () => setParam(id, def[3]));
}
function roundFor(id, v) { const u = pdef(id)[4]; if (u === 'Hz' && v < 10) return Math.round(v * 20) / 20; if (u === 'dB') return Math.round(v * 10) / 10; if (u === '' ) return Math.round(v * 10) / 10; if (u === 'msf') return Math.round(v * 50) / 50; if (u === 'Hz' && v < 1000) return Math.round(v); if (u === 'Hz') return Math.round(v / 10) * 10; return Math.round(v); }
function renderKnob(id) { const k = knobs.get(id); if (!k) return; const v = state.p[id]; k.dial.setAttribute('transform', `rotate(${-135 + 270 * toNorm(id, v)})`); k.val.textContent = fmt(id, v); }

// ---------------- generic param set / render ----------------
function setParam(id, v, opts = {}) {
  if (state.p[id] === v) return;
  state.p[id] = v;
  if (id.startsWith('pb.')) { const [, uid, key] = id.split('.'); engine?.setPedal(uid, key === 'on' ? { on: !!v } : { p: { [key]: v } }); }
  else if (engine) engine.set(id, v);
  render(id);
  if (!NOT_IN_PRESET.has(id) && !opts.noDirty) markDirty();
  saveSession();
}
function render(id) {
  if (pdef(id)) renderKnob(id);
  const v = state.p[id];
  $$(`[data-led="${id}"]`).forEach((e) => e.classList.toggle('on', !!v));
  if (/^pb\.[^.]+\.on$/.test(id)) $$(`.pedal[data-uid="${id.split('.')[1]}"]`).forEach((e) => e.classList.toggle('off', !v));
  const block = { 'amp.on': 'amp', 'delay.on': 'delay', 'rev.on': 'rev' }[id];
  if (block) $$(`[data-block="${block}"]`).forEach((e) => e.classList.toggle('off', !v));
  if (id === 'bypass') { $('#btnBypass .led').classList.toggle('on', !!v); }
  if (id === 'delay.sync') { $$('#delayMode button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'sync') === !!v)); updateDelayTimeKnob(); }
  if (id === 'delay.pingpong') $$('#delayPP button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === !!v));
  if (id === 'delay.div') $('#delayDiv').value = v;
  if (id === 'bpm') { $('#bpmVal').textContent = Math.round(v); updateDelayTimeKnob(); }
  if (id === 'delay.div') updateDelayTimeKnob();
  $$(`.chain [data-t="${id}"] .led`).forEach((e) => e.classList.toggle('on', !!v));
}
function updateDelayTimeKnob() {
  const k = knobs.get('delay.time'); if (!k) return;
  if (state.p['delay.sync']) { const ms = Math.round(60000 / state.p.bpm * ({ '1/2': 2, '1/4.': 1.5, '1/4': 1, '1/4T': 2 / 3, '1/8.': 0.75, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25 }[state.p['delay.div']] || 1)); k.val.textContent = `${state.p['delay.div']} · ${ms}ms`; k.el.style.opacity = .55; }
  else { k.el.style.opacity = 1; renderKnob('delay.time'); }
}
function renderAll() { for (const id of Object.keys(state.p)) render(id); renderModels(); renderPresetName(); }

// ---------------- actions ----------------
let taps = [];
function doAction(a) {
  if (a === 'a:prev') recall((state.cur - 1 + state.bank.length) % state.bank.length);
  else if (a === 'a:next') recall((state.cur + 1) % state.bank.length);
  else if (a === 'a:bypass') setParam('bypass', !state.p.bypass);
  else if (a === 'a:tuner') toggleTuner();
  else if (a === 'a:tap') {
    const t = performance.now();
    taps = taps.filter((x) => t - x < 2500); taps.push(t);
    const b = $('#btnTap'); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 90);
    if (taps.length >= 2) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      const bpm = Math.max(40, Math.min(240, Math.round(60000 / iv * 10) / 10));
      setParam('bpm', bpm);
      if (!state.p['delay.sync']) setParam('delay.time', Math.max(20, Math.min(1500, Math.round(iv))));
    }
  }
  else if (a === 'a:align') autoAlign();
  else if (/^a:(amp|cab|room|nam:[\w]+)-(prev|next)$/.test(a)) { const [, sl, d] = a.match(/^a:(amp|cab|room|nam:[\w]+)-(prev|next)$/); stepModel(sl, d === 'next' ? 1 : -1); }
  else if (a.startsWith('a:preset:')) { const n = +a.split(':')[2]; if (n < state.bank.length) recall(n); }
}

async function autoAlign() {
  if (!engine) return toast('Start audio first');
  if (!state.p['amp.on'] && !state.models.amp) return toast('Turn the amp on first');
  const btn = $('#btnAlign'); btn.disabled = true; btn.textContent = 'PLAY…';
  toast('Auto-align: play a few low notes for 2 seconds');
  try {
    const r = await engine.measureAlignment(2000, (f) => { btn.textContent = Math.round(f * 100) + '%'; });
    if (!r) toast('No signal: play some notes and try again');
    else if (r.confidence < 0.2) toast(`Unclear result (confidence ${Math.round(r.confidence * 100)}%) — try with a cleaner amp setting`);
    else { setParam('blend.align', Math.min(20, r.ms)); setParam('blend.phase', r.invert); toast(`Aligned: clean delayed ${r.ms.toFixed(2)} ms${r.invert ? ', polarity inverted' : ''} (confidence ${Math.round(r.confidence * 100)}%)`); }
  } finally { btn.disabled = false; btn.textContent = 'AUTO'; }
}

// ---------------- MIDI targets ----------------
function onTarget(target, v01, raw, map) {
  if (target.startsWith('a:')) { if (raw.val > 0) doAction(target); return; }
  const id = target.slice(2);
  if (!(id in state.p)) return; // e.g. a pedal not on the current board
  if (isBool(id)) {
    if (map.mode === 'latch') setParam(id, raw.val >= 64);
    else if (raw.val > 0) setParam(id, !state.p[id]);
  } else if (pdef(id)) setParam(id, roundFor(id, fromNorm(id, v01)));
}
function targetLabel(t) {
  if (t.startsWith('a:')) return { 'a:amp-prev': 'Amp model ◂', 'a:amp-next': 'Amp model ▸', 'a:pedal-prev': 'Pedal model ◂', 'a:pedal-next': 'Pedal model ▸', 'a:cab-prev': 'Cab IR ◂', 'a:cab-next': 'Cab IR ▸', 'a:room-prev': 'Room IR ◂', 'a:room-next': 'Room IR ▸', 'a:align': 'Auto-align', 'a:prev': 'Preset ◀', 'a:next': 'Preset ▶', 'a:tap': 'Tap tempo', 'a:bypass': 'Bypass', 'a:tuner': 'Tuner' }[t] || t;
  if (/^a:nam:/.test(t)) return `NAM pedal model ${t.endsWith('next') ? '▸' : '◂'}`;
  const id = t.slice(2);
  if (id.startsWith('pb.')) { const [, uid, key] = id.split('.'); const b = state.board.find((x) => x.uid === uid); if (!b) return 'pedal (not on this preset)'; const L = PEDALS[b.type].label; return key === 'on' ? `${L} on/off` : `${L} ${PEDALS[b.type].params[key]?.[0] || key}`; }
  if (P[id]) { const blk = id.split('.')[0].toUpperCase(); return `${blk} ${P[id][0]}`; }
  const b = POST_BLOCKS.find((x) => x[0] === id); return b ? `${b[1]} on/off` : id;
}
function markMapped() {
  const set = new Set(midi.maps.map((m) => m.target));
  $$('.knob').forEach((e) => e.classList.toggle('mapped', set.has('p:' + e.dataset.p)));
  $$('[data-t]').forEach((e) => e.classList.toggle('mapped', set.has('p:' + e.dataset.t)));
  $$('[data-a]').forEach((e) => e.classList.toggle('mapped', set.has(e.dataset.a)));
}
let midiFlashT = 0;
function flashMidi() { const l = $('#midiLed'); l.classList.add('on', 'blue'); clearTimeout(midiFlashT); midiFlashT = setTimeout(() => { if (!midi.access) l.classList.remove('on'); else l.classList.add('on'); }, 80); }

async function toggleLearn() {
  if (!midi.access) { try { await midi.enable(); $('#midiLed').classList.add('on', 'blue'); } catch (e) { toast(e.message); return; } }
  state.learn = !state.learn;
  document.body.classList.toggle('learn', state.learn);
  $('#learnLed').classList.toggle('on', state.learn); $('#learnLed').classList.add('blue');
  midi.stopLearn(); $$('.learning').forEach((e) => e.classList.remove('learning'));
  toast(state.learn ? 'MIDI LEARN: click a knob, switch or button, then move your controller. Right-click clears.' : 'Learn off');
}
function learnTargetOf(el) {
  const k = el.closest('.knob'); if (k) return { el: k, t: 'p:' + k.dataset.p };
  const t = el.closest('[data-t]'); if (t) return { el: t, t: 'p:' + t.dataset.t };
  const a = el.closest('[data-a]'); if (a) return { el: a, t: a.dataset.a };
  return null;
}

// ---------------- models ----------------
function namDescription(json, fileName) {
  const md = json.metadata || {};
  const name = md.name || [md.gear_make, md.gear_model].filter(Boolean).join(' ') || fileName.replace(/\.nam$/i, '');
  let arch = json.architecture;
  if (arch === 'SlimmableContainer') arch = 'A2';
  return { name, arch, rate: json.sample_rate || 48000, loud: md.loudness, by: md.modeled_by, type: md.gear_type, tone: md.tone_type, make: md.gear_make, model: md.gear_model };
}
const NAM_RE = /\.nam$/i, IR_RE = /\.(wav|aiff?|flac)$/i;
const isNamSlot = (slot) => slot === 'amp' || /^nam:/.test(slot || '');
const folderOf = (p) => { const i = (p || '').lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let persistAsked = false;

// Import one or many files (from a picker, a folder or a drop) into the library.
// Every supported file is stored (.nam as models, .wav/.aif/.flac as IRs); the first one that fits the
// target slot is activated. entries: [{ file, path }] where path is the folder-relative path when known.
async function importFiles(entries, slot) {
  const want = !slot || isNamSlot(slot) ? 'nam' : 'ir';
  const list = entries.filter((e) => NAM_RE.test(e.file.name) || IR_RE.test(e.file.name))
    .sort((x, y) => natural.compare(x.path || x.file.name, y.path || y.file.name));
  if (!list.length) return toast(!slot ? 'No .nam / IR files found' : want === 'nam' ? 'No .nam files found' : 'No .wav / .aif / .flac files found');
  if (!persistAsked && navigator.storage?.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
  let added = 0, dup = 0, bad = 0, first = null; const many = list.length > 1;
  for (let i = 0; i < list.length; i++) {
    const { file, path } = list[i];
    if (many) toast(`Importing ${i + 1} / ${list.length} · ${file.name}`);
    try {
      const bytes = await file.arrayBuffer();
      const isNam = NAM_RE.test(file.name);
      const id = (isNam ? 'nam-' : 'ir-') + await hashBytes(bytes);
      const folder = folderOf(path || file.webkitRelativePath || '');
      let item;
      if (isNam) {
        let json; try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { bad++; continue; }
        if (!json || !json.architecture) { bad++; continue; }
        const d = namDescription(json, file.name);
        item = { id, kind: 'nam', name: d.name, file: file.name, folder, desc: d, added: Date.now() + i };
      } else item = { id, kind: 'ir', name: file.name.replace(IR_RE, ''), file: file.name, folder, added: Date.now() + i };
      if (await Library.has(id)) dup++;
      else if (await Library.put({ ...item, bytes })) added++;
      else { toast('Browser storage is full: delete something in Manage library'); break; }
      if (!first && item.kind === want) first = { item, bytes };
    } catch { bad++; }
  }
  if (first && slot) {
    if (want === 'nam') await useModel(slot, first.item.id, first.bytes, first.item.desc);
    else await useIR(slot, { id: first.item.id, name: first.item.name, builtin: false }, first.bytes);
  }
  if (many || bad) {
    const parts = [`${added} added`]; if (dup) parts.push(`${dup} already in library`); if (bad) parts.push(`${bad} not valid`);
    toast(`Library: ${parts.join(' · ')}${first && slot && many ? ` — now using “${first.item.name}”, use ◂ ▸ or ▾ to choose` : ''}`);
  } else if (!first && slot) toast(want === 'nam' ? 'Please use a .nam file here' : 'Please use a .wav impulse response here');
}
const addFile = (file, slot) => importFiles([{ file, path: file.webkitRelativePath || '' }], slot);

// Collect files from a drop, descending into folders.
async function droppedEntries(dt) {
  const out = [];
  const items = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length) return [...dt.files].map((file) => ({ file, path: '' }));
  const readAll = (dir) => new Promise((res) => { const r = dir.createReader(), acc = []; const next = () => r.readEntries((b) => { if (!b.length) res(acc); else { acc.push(...b); next(); } }, () => res(acc)); next(); });
  const walk = async (entry, prefix) => {
    if (entry.isFile) { const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null); if (file) out.push({ file, path: prefix + file.name }); }
    else if (entry.isDirectory) for (const e of await readAll(entry)) await walk(e, prefix + entry.name + '/');
  };
  for (const e of items) await walk(e, '');
  return out;
}

// Step through the library (same folder as the current model) — handy for auditioning a pack.
async function stepModel(slot, dir) {
  const kind = isNamSlot(slot) ? 'nam' : 'ir';
  let lib = (await Library.list()).filter((x) => x.kind === kind);
  const cat = slot.startsWith('nam:') ? state.board.find((b) => 'nam:' + b.uid === slot)?.cat : null;
  if (cat && cat !== 'any') { const f = lib.filter((x) => namCategory(x) === cat); if (f.length) lib = f; }
  if (!lib.length) return toast('Library is empty: load or drop some files first');
  const cur = state.models[slot]?.id, curItem = lib.find((x) => x.id === cur);
  const pool = (curItem ? lib.filter((x) => (x.folder || '') === (curItem.folder || '')) : lib).sort((x, y) => natural.compare(x.name, y.name));
  let i = pool.findIndex((x) => x.id === cur);
  i = i < 0 ? (dir > 0 ? 0 : pool.length - 1) : (i + dir + pool.length) % pool.length;
  const it = pool[i];
  if (kind === 'nam') await useModel(slot, it.id); else await useIR(slot, { id: it.id, name: it.name, builtin: false });
  toast(`${i + 1} / ${pool.length} · ${it.name}${it.folder ? '  — ' + it.folder : ''}`);
}

async function useModel(slot, id, bytes, desc) {
  if (!engine) { toast('Start audio first'); return; }
  setLcdInfo(slot, 'loading…');
  try {
    let res;
    if (!bytes) { res = await engine.selectModel(slot, id); }
    if (!res || res.type === 'miss') {
      const item = await Library.get(id);
      if (!item) throw new Error('model not in library — load it again');
      bytes = item.bytes; desc = desc || item.desc;
      res = await engine.loadModel(slot, id, bytes);
    }
    if (!desc) desc = (await Library.get(id))?.desc || { name: id };
    state.models[slot] = { id, name: desc.name, desc, info: res.info };
    const er = res.info?.expectedRate, cr = engine.ctx.sampleRate;
    if (er > 0 && Math.abs(er - cr) > 1) toast(`⚠ ${desc.name} was trained at ${er / 1000} kHz, the engine runs at ${cr / 1000} kHz: its tone will be slightly off. Audio settings → Engine rate.`);
    if (slot.startsWith('nam:') && !state.p[`pb.${slot.slice(4)}.on`]) setParam(`pb.${slot.slice(4)}.on`, true);
    markDirty(); renderModels(); saveSession();
  } catch (e) {
    toast('Model error: ' + e.message); state.models[slot] = null; renderModels();
  }
}
function unloadModel(slot) { state.models[slot] = null; engine?.unloadModel(slot); markDirty(); renderModels(); saveSession(); }
async function useIR(slot, m, bytes) {
  if (!engine) { state.models[slot] = m; renderModels(); return; }
  try {
    if (m.builtin) { slot === 'cab' ? await engine.setCabBuiltin(m.id) : engine.setRoomBuiltin(m.id); }
    else {
      if (!bytes) { const item = await Library.get(m.id); if (!item) throw new Error('IR not in library'); bytes = item.bytes; }
      const buf = slot === 'cab' ? await engine.setCabFile(m.id, bytes) : await engine.setRoomFile(m.id, bytes);
      m.info = `${Math.round(buf.sampleRate / 100) / 10} kHz · ${Math.round(buf.duration * 1000)} ms · ${buf.numberOfChannels === 2 ? 'stereo' : 'mono'}`;
    }
    state.models[slot] = m; markDirty(); renderModels(); saveSession();
  } catch (e) { toast('IR error: ' + e.message); }
}
function setLcdInfo(slot, s) { const el = slot === 'amp' ? $('#ampInfo') : $(`.pedal[data-uid="${slot.slice(4)}"] .nam-info`); if (el) el.textContent = s; }
function modelInfoText(m) {
  const d = m.desc || {}, i = m.info || {};
  const parts = [];
  const rate = i.expectedRate > 0 ? i.expectedRate : d.rate;
  const er = engine?.ctx.sampleRate || 48000;
  if (rate) parts.push(`${rate / 1000} kHz${Math.abs(rate - er) > 1 ? ` ⚠ engine ${er / 1000} kHz` : ''}`);
  if (d.arch) parts.push(d.arch);
  if (i.loudness < 900) parts.push(`${i.loudness.toFixed(1)} dB${state.p.normalize ? ' → norm' : ''}`);
  if (d.by) parts.push('by ' + d.by);
  parts.push('loaded');
  return parts.join(' · ');
}
function renderModels() {
  const a = state.models.amp, c = state.models.cab, r = state.models.room;
  $('#ampName').textContent = a ? a.name : 'Built-in Tube (no model)';
  $('#ampInfo').textContent = a ? modelInfoText(a) : 'drop .nam files or a folder here · tone3000.com';
  for (const b of state.board) if (b.type === 'nam') {
    const m = state.models['nam:' + b.uid], card = $(`.pedal[data-uid="${b.uid}"]`); if (!card) continue;
    card.querySelector('.nam-name').textContent = m ? m.name : '— empty —';
    card.querySelector('.nam-info').textContent = m ? modelInfoText(m) : 'drop .nam captures or a folder';
  }
  $('#cabName').textContent = c ? c.name : 'none';
  $('#cabInfo').textContent = c ? (c.builtin ? 'built-in synthesized IR · drop a .wav here' : (c.info || 'IR file')) : '';
  $('#roomName').textContent = r ? r.name : 'none';
}

// ---------------- dropdowns ----------------
async function openMenu(slot, anchor) {
  const dd = $('#dropdown');
  const lib = await Library.list();
  const cur = state.models[slot]?.id;
  const isNam = isNamSlot(slot);
  let own = lib.filter((x) => x.kind === (isNam ? 'nam' : 'ir'));
  const ped = slot.startsWith('nam:') ? state.board.find((b) => 'nam:' + b.uid === slot) : null;
  const catF = ped && ped.cat && ped.cat !== 'any' && !openMenu.showAll ? ped.cat : null;
  const total = own.length;
  if (catF) own = own.filter((x) => namCategory(x) === catF);
  const head = [], tail = [];
  if (!isNam) { const builtins = slot === 'cab' ? CAB_PRESETS : ROOM_PRESETS; head.push({ sec: 'BUILT-IN' }); for (const [id, b] of Object.entries(builtins)) head.push({ label: b.name, cur: id === cur, fn: () => useIR(slot, { id, name: b.name, builtin: true }) }); }
  tail.push({ sec: 'ACTIONS' });
  tail.push({ label: isNam ? 'Load files… (multiple)' : 'Load IR files… (multiple)', fn: () => pickFile(slot) });
  tail.push({ label: 'Import a whole folder…', fn: () => pickFile(slot, true) });
  if (ped && ped.cat && ped.cat !== 'any') tail.unshift({ label: catF ? `Show all ${total} captures (filter: ${NAM_CATS[ped.cat]})` : `Show only ${NAM_CATS[ped.cat]} captures`, fn: () => { openMenu.showAll = !openMenu.showAll; setTimeout(() => openMenu(slot, anchor), 0); } }, { sec: 'FILTER' });
  if (isNam) tail.push({ label: slot === 'amp' ? 'Use built-in tube (no model)' : 'Remove pedal model', fn: () => unloadModel(slot) });
  tail.push({ label: isNam ? 'Browse TONE3000 ↗' : 'Browse IRs on TONE3000 ↗', fn: () => window.open(isNam ? 'https://www.tone3000.com/search?gear=amp&sort=trending' : 'https://www.tone3000.com/search?gear=ir', '_blank', 'noopener') });
  tail.push({ label: 'Manage library…', fn: openLibrary });
  const pick = (x) => isNam ? useModel(slot, x.id) : useIR(slot, { id: x.id, name: x.name, builtin: false });

  dd.innerHTML = '';
  let search = null;
  if (own.length > 6) {
    search = document.createElement('input'); search.type = 'search'; search.className = 'dd-search';
    search.placeholder = `Search ${own.length} ${isNam ? 'models' : 'IRs'}…`; dd.appendChild(search);
  }
  const body = document.createElement('div'); body.className = 'dd-body'; dd.appendChild(body);
  const row = (it) => {
    const d = document.createElement('div');
    if (it.sec) { d.className = 'sec'; d.textContent = it.sec; return d; }
    d.innerHTML = '<span></span><small></small>'; d.firstChild.textContent = it.label; d.lastChild.textContent = it.small || '';
    if (it.cur) d.classList.add('cur'); d.onclick = () => { closeMenu(); it.fn(); }; return d;
  };
  const render = (q) => {
    body.innerHTML = '';
    const ql = (q || '').toLowerCase().trim();
    if (!ql) head.forEach((it) => body.appendChild(row(it)));
    const match = own.filter((x) => !ql || `${x.name} ${x.folder || ''} ${x.file || ''}`.toLowerCase().includes(ql));
    const groups = new Map();
    for (const x of match) { const f = x.folder || ''; if (!groups.has(f)) groups.set(f, []); groups.get(f).push(x); }
    const names = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : natural.compare(a, b)));
    if (!own.length) body.appendChild(row({ sec: catF ? `no ${NAM_CATS[catF]} captures — set categories in Manage library` : `LIBRARY — empty: load files or a folder` }));
    else if (!match.length) body.appendChild(row({ sec: 'no match' }));
    for (const f of names) {
      const items = groups.get(f).sort((x, y) => natural.compare(x.name, y.name));
      body.appendChild(row({ sec: `${f ? '📁 ' + f : 'LIBRARY'} · ${items.length}` }));
      const seen = {}; for (const x of items) seen[x.name] = (seen[x.name] || 0) + 1;
      for (const x of items) body.appendChild(row({ label: seen[x.name] > 1 && x.file ? `${x.name} (${x.file})` : x.name, small: isNam ? (x.desc?.arch || '') : '', cur: x.id === cur, fn: () => pick(x) }));
    }
    if (!ql) tail.forEach((it) => body.appendChild(row(it)));
  };
  render('');
  if (search) {
    search.oninput = () => render(search.value);
    search.onkeydown = (e) => { if (e.key === 'Enter') { const first = body.querySelector('div:not(.sec)'); first?.click(); } if (e.key === 'Escape') closeMenu(); e.stopPropagation(); };
  }
  const r = anchor.getBoundingClientRect();
  dd.classList.remove('hidden');
  dd.style.left = Math.max(8, Math.min(r.left, innerWidth - dd.offsetWidth - 8)) + 'px';
  dd.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - dd.offsetHeight - 8)) + 'px';
  dd.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  if (search) setTimeout(() => search.focus(), 0);
  setTimeout(() => document.addEventListener('pointerdown', menuOutside), 0);
}
function menuOutside(e) { if (!$('#dropdown').contains(e.target)) closeMenu(); }
function closeMenu() { $('#dropdown').classList.add('hidden'); document.removeEventListener('pointerdown', menuOutside); }
function pickFile(slot, folder = false, done) {
  const fi = $('#fileInput');
  fi.multiple = true;
  fi.webkitdirectory = folder; // a whole folder (subfolders included)
  fi.accept = folder ? '' : !slot ? '.nam,.wav,.aif,.aiff,.flac' : (isNamSlot(slot) ? '.nam' : '.wav,.aif,.aiff,.flac');
  fi.onchange = async () => { const files = [...fi.files]; fi.value = ''; fi.webkitdirectory = false; if (files.length) await importFiles(files.map((file) => ({ file, path: file.webkitRelativePath || '' })), slot); done?.(); };
  fi.click();
}


// ---------------- pedalboard ----------------
// state.board = [{ uid, type, variant, cat }]; values live in state.p as 'pb.<uid>.<key>' and 'pb.<uid>.on'
function normalizePreset(pr) {
  // returns { board, params, pedals } for any preset (v0.4 board presets, factory board presets, v0.3 legacy)
  const params = {}, pedals = { ...(pr.pedals || {}) };
  let board;
  if (Array.isArray(pr.board) && pr.board.length && pr.board[0].uid) {
    board = pr.board.map((b) => ({ ...b }));
    Object.assign(params, pr.params || {});
  } else if (Array.isArray(pr.board)) { // factory format: [{ type, variant, on, p }]
    board = pr.board.map((b) => ({ uid: newUid(), type: b.type, variant: b.variant || PEDALS[b.type].defaultVariant || '', cat: b.cat || 'any' }));
    pr.board.forEach((b, i) => { const u = board[i].uid; params[`pb.${u}.on`] = !!b.on; for (const [k, v] of Object.entries(b.p || {})) params[`pb.${u}.${k}`] = v; });
    Object.assign(params, pr.params || {});
  } else { // v0.3: fixed gate → comp → drive → NAM pedal
    board = LEGACY_BOARD.map((b) => ({ ...b }));
    for (const [k, v] of Object.entries(pr.params || {})) params[LEGACY_KEYS[k] || k] = v;
    if (pr.pedal) pedals.n1 = pr.pedal;
  }
  for (const b of board) { // fill missing pedal values with defaults
    if (b.variant === undefined) b.variant = PEDALS[b.type].defaultVariant || '';
    if (!(`pb.${b.uid}.on` in params)) params[`pb.${b.uid}.on`] = false;
    for (const [k, v] of Object.entries(pedalDefaults(b.type))) if (!(`pb.${b.uid}.${k}` in params)) params[`pb.${b.uid}.${k}`] = v;
  }
  return { board, params, pedals };
}
const engineBoard = () => state.board.map((b) => {
  const p = {}; for (const k of Object.keys(PEDALS[b.type].params)) p[k] = state.p[`pb.${b.uid}.${k}`];
  return { uid: b.uid, type: b.type, variant: b.variant, on: !!state.p[`pb.${b.uid}.on`], p };
});
function syncBoard() { engine?.setBoard(engineBoard()); renderBoard(); renderChain(); renderModels(); markMapped(); }

function renderBoard() {
  const el = $('#board'); if (!el) return;
  for (const id of [...knobs.keys()]) if (id.startsWith('pb.')) knobs.delete(id);
  el.innerHTML = '';
  state.board.forEach((b, i) => {
    const def = PEDALS[b.type], card = document.createElement('div');
    card.className = `pedal ${def.color}${def.nam ? ' nam drop' : ''}`;
    card.dataset.uid = b.uid; if (def.nam) card.dataset.drop = 'nam:' + b.uid;
    const vars = variantsOf(b.type);
    card.innerHTML = `<div class="ped-top"><button class="ped-btn" data-move="-1" title="Move left">‹</button><span class="ped-grip" draggable="true" title="Drag to reorder">⠿</span><button class="ped-btn" data-move="1" title="Move right">›</button><span class="ped-sp"></span><button class="ped-btn ped-x" title="Remove pedal">✕</button></div>
      <h3>${def.label}</h3>
      ${vars ? `<select class="ped-var" title="Pedal type">${Object.entries(vars).map(([k, v]) => `<option value="${k}"${k === b.variant ? ' selected' : ''}>${v}</option>`).join('')}</select>` : `<small>${def.sub || ''}</small>`}
      ${def.nam ? `<div class="pedal-lcd"><div class="lcd-head"><span class="nam-name">— empty —</span><div class="lcd-btns"><button class="mini" data-a="a:nam:${b.uid}-prev" title="Previous model">◂</button><button class="mini" data-a="a:nam:${b.uid}-next" title="Next model">▸</button><button class="mini" data-menu="nam:${b.uid}">▾</button><button class="mini" data-file="nam:${b.uid}">LOAD</button></div></div><div class="lcd-info nam-info">drop .nam captures or a folder</div></div>
        <select class="ped-cat" title="Which captures this pedal lists">${Object.entries(NAM_CATS).map(([k, v]) => `<option value="${k}"${k === (b.cat || 'any') ? ' selected' : ''}>${k === 'any' ? 'ALL CAPTURES' : v}</option>`).join('')}</select>` : ''}
      <div class="knobs">${paramsFor(b.type, b.variant).map(([k]) => `<div class="knob" data-p="pb.${b.uid}.${k}"></div>`).join('')}</div>
      ${def.gr ? `<div class="grbar" title="Gain reduction"><i></i></div>` : ''}
      <div class="foot"><i class="led" data-led="pb.${b.uid}.on"></i><button class="fsw" data-t="pb.${b.uid}.on" title="On / off (key ${i + 1})"></button></div>`;
    card.classList.toggle('off', !state.p[`pb.${b.uid}.on`]);
    el.appendChild(card);
    card.querySelectorAll('.knob').forEach(buildKnob);
    card.querySelectorAll('.knob').forEach((k) => renderKnob(k.dataset.p));
    render(`pb.${b.uid}.on`);
    card.querySelector('.ped-var')?.addEventListener('change', (e) => { b.variant = e.target.value; engine?.setPedal(b.uid, { variant: b.variant }); markDirty(); saveSession(); renderBoard(); });
    card.querySelector('.ped-cat')?.addEventListener('change', (e) => { b.cat = e.target.value; markDirty(); saveSession(); });
    card.querySelector('.ped-x').onclick = () => removePedal(b.uid);
    card.querySelectorAll('[data-move]').forEach((btn) => (btn.onclick = () => movePedal(b.uid, +btn.dataset.move)));
    const grip = card.querySelector('.ped-grip');
    grip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-profondo-pedal', b.uid); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    grip.addEventListener('dragend', () => card.classList.remove('dragging'));
    if (def.nam) wireDrop(card);
  });
  if (state.board.length < MAX_PEDALS) {
    const add = document.createElement('button'); add.className = 'pedal add'; add.id = 'addPedal'; add.title = 'Add a pedal';
    add.innerHTML = '<span>＋</span><small>ADD PEDAL</small>'; add.onclick = () => openAddPedal(add); el.appendChild(add);
  }
  markMapped();
}
function addPedal(type, at = state.board.length) {
  if (state.board.length >= MAX_PEDALS) return toast(`Up to ${MAX_PEDALS} pedals`);
  const uid = newUid(), b = { uid, type, variant: PEDALS[type].defaultVariant || '', cat: 'any' };
  state.board.splice(at, 0, b);
  state.p[`pb.${uid}.on`] = true;
  for (const [k, v] of Object.entries(pedalDefaults(type))) state.p[`pb.${uid}.${k}`] = v;
  markDirty(); syncBoard(); saveSession();
  if (type === 'nam') toast('NAM pedal added: load a capture with LOAD or ▾, or drop files on it');
  return uid;
}
function removePedal(uid) {
  const i = state.board.findIndex((b) => b.uid === uid); if (i < 0) return;
  const [b] = state.board.splice(i, 1);
  for (const k of Object.keys(state.p)) if (k.startsWith(`pb.${uid}.`)) delete state.p[k];
  if (b.type === 'nam') { delete state.models['nam:' + uid]; engine?.unloadModel('nam:' + uid); }
  markDirty(); syncBoard(); saveSession();
}
function movePedal(uid, d, to) {
  const i = state.board.findIndex((b) => b.uid === uid); if (i < 0) return;
  let j = to ?? i + d; j = Math.max(0, Math.min(state.board.length - 1, j)); if (j === i) return;
  const [b] = state.board.splice(i, 1); state.board.splice(j, 0, b);
  markDirty(); syncBoard(); saveSession();
}
function openAddPedal(anchor) {
  const dd = $('#dropdown'); dd.innerHTML = ''; const body = document.createElement('div'); body.className = 'dd-body'; dd.appendChild(body);
  const sec = document.createElement('div'); sec.className = 'sec'; sec.textContent = 'ADD A PEDAL'; body.appendChild(sec);
  const desc = { comp: 'Opto · VCA · FET · Multiband', drive: 'Tube OD · Bass distortion · Fuzz · Octave fuzz', octave: 'sub −1 / −2 octaves', envf: 'auto-wah: low-pass / band-pass, up / down', chorus: 'bass chorus, lows stay dry', nam: 'any NAM pedal / preamp capture', gate: 'noise gate' };
  for (const t of PEDAL_ORDER) {
    const d = document.createElement('div'); d.innerHTML = '<span></span><small></small>'; d.firstChild.textContent = PEDALS[t].label; d.lastChild.textContent = desc[t] || '';
    d.onclick = () => { closeMenu(); addPedal(t); }; body.appendChild(d);
  }
  const r = anchor.getBoundingClientRect(); dd.classList.remove('hidden');
  dd.style.left = Math.max(8, Math.min(r.left, innerWidth - dd.offsetWidth - 8)) + 'px';
  dd.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - dd.offsetHeight - 8)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', menuOutside), 0);
}
function renderChain() {
  const chain = $('#chain'); if (!chain) return; chain.innerHTML = '';
  chainBlocks().forEach(([id, label], i) => { const b = document.createElement('button'); b.dataset.t = id; b.innerHTML = `<i class="led"></i>${label}${i < 9 ? ` <kbd>${i + 1}</kbd>` : ''}`; chain.appendChild(b); render(id); });
}
function wireDrop(el) {
  el.addEventListener('dragover', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); e.stopPropagation(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', async (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover'); const files = await droppedEntries(e.dataTransfer); if (files.length) importFiles(files, el.dataset.drop); });
}
function wireBoardReorder() {
  const el = $('#board');
  const targetIndex = (e) => { // insertion index among the pedal cards under the pointer
    const cards = [...el.querySelectorAll('.pedal[data-uid]')];
    let best = cards.length, dist = Infinity;
    cards.forEach((c, i) => {
      const r = c.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(e.clientX - cx, (e.clientY - cy) * 2);
      if (d < dist) { dist = d; best = e.clientX < cx ? i : i + 1; }
    });
    return best;
  };
  el.addEventListener('dragover', (e) => { if (![...e.dataTransfer.types].includes('text/x-profondo-pedal')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  el.addEventListener('drop', (e) => {
    const uid = e.dataTransfer.getData('text/x-profondo-pedal'); if (!uid) return;
    e.preventDefault(); e.stopPropagation();
    const from = state.board.findIndex((b) => b.uid === uid); let to = targetIndex(e);
    if (to > from) to--;
    movePedal(uid, 0, to);
  });
}

// ---------------- presets ----------------
function snapshot(name) {
  const params = {};
  for (const [k, v] of Object.entries(state.p)) if (!NOT_IN_PRESET.has(k)) params[k] = v;
  const m = state.models, pedals = {}, pedalNames = {};
  for (const b of state.board) if (b.type === 'nam') { pedals[b.uid] = m['nam:' + b.uid]?.id || null; pedalNames[b.uid] = m['nam:' + b.uid]?.name; }
  return { name, v: 2, params, board: state.board.map((b) => ({ ...b })), pedals, amp: m.amp?.id || null, cab: m.cab?.id || 'syn-810', room: m.room?.id || 'rev-studio',
    names: { amp: m.amp?.name, cab: m.cab?.name, room: m.room?.name, pedals: pedalNames } };
}
async function recall(i) {
  const pr = state.bank[i]; if (!pr) return;
  state.cur = i; LS.set('cur', i);
  const keep = { bypass: state.p.bypass, normalize: state.p.normalize, 'in.gain': state.p['in.gain'] };
  const norm = normalizePreset(pr);
  const oldNam = state.board.filter((b) => b.type === 'nam').map((b) => b.uid);
  state.board = norm.board;
  state.p = { ...defaults(), ...norm.params, ...keep };
  for (const u of oldNam) if (!state.board.some((b) => b.uid === u)) { delete state.models['nam:' + u]; engine?.unloadModel('nam:' + u); }
  if (engine) engine.setMany(state.p);
  syncBoard(); renderAll();
  await applyPresetModels(pr, norm);
  state.dirty = false; renderPresetName(); saveSession();
}
async function applyPresetModels(pr, norm = normalizePreset(pr)) {
  const want = [['amp', pr.amp, pr.names?.amp]];
  for (const b of norm.board) if (b.type === 'nam') want.push(['nam:' + b.uid, norm.pedals[b.uid], pr.names?.pedals?.[b.uid] || (b.uid === 'n1' ? pr.names?.pedal : null)]);
  for (const [slot, id, nm] of want) {
    if (!id) { if (state.models[slot]) { state.models[slot] = null; engine?.unloadModel(slot); } continue; }
    if (state.models[slot]?.id === id) continue;
    const on = slot.startsWith('nam:') ? state.p[`pb.${slot.slice(4)}.on`] : null;
    if (engine) await useModel(slot, id); else state.models[slot] = { id, name: nm || id };
    if (on !== null && state.p[`pb.${slot.slice(4)}.on`] !== on) setParam(`pb.${slot.slice(4)}.on`, on, { noDirty: true }); // loading never changes the preset's on/off
  }
  for (const slot of ['cab', 'room']) {
    const id = pr[slot]; if (!id || state.models[slot]?.id === id) continue;
    const b = (slot === 'cab' ? CAB_PRESETS : ROOM_PRESETS)[id];
    await useIR(slot, b ? { id, name: b.name, builtin: true } : { id, name: pr.names?.[slot] || 'IR', builtin: false });
  }
  renderModels();
}
function markDirty() { if (!state.dirty) { state.dirty = true; renderPresetName(); } }
function renderPresetName() {
  const el = $('#presetName'); const pr = state.bank[state.cur];
  el.textContent = `${String(state.cur + 1).padStart(2, '0')} · ${pr ? pr.name : '—'}`;
  el.classList.toggle('dirty', state.dirty);
}
function saveBank() { LS.set('bank', state.bank); }
function savePreset() { const pr = state.bank[state.cur]; state.bank[state.cur] = snapshot(pr ? pr.name : 'Preset'); saveBank(); state.dirty = false; renderPresetName(); toast('Preset saved'); }
function savePresetAs() {
  const name = prompt('Preset name', state.bank[state.cur]?.name + ' 2'); if (!name) return;
  state.bank.push(snapshot(name)); state.cur = state.bank.length - 1; LS.set('cur', state.cur); saveBank(); state.dirty = false; renderPresetName(); toast(`Saved as ${String(state.cur + 1).padStart(2, '0')}`);
}
let sessT = 0;
function saveSession() { clearTimeout(sessT); sessT = setTimeout(() => LS.set('session', { ...snapshot('session'), dirty: state.dirty, globals: { normalize: state.p.normalize, 'in.gain': state.p['in.gain'] } }), 300); }

// ---------------- modals ----------------
function modal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); return $('#modalBody'); }
function closeModal() { $('#modal').classList.add('hidden'); }

function openPresets() {
  const b = modal(`<h2>PRESETS</h2>
    <p class="note">MIDI Program Change <i>n</i> recalls preset <i>n+1</i>. Models referenced by presets are pre-loaded so switching is instant.</p>
    <table id="presetTable"></table>
    <h3>BANK</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="pExport">EXPORT BANK</button><label style="margin:0"><input type="checkbox" id="pWithModels" checked> include model &amp; IR files</label>
      <button class="btn" id="pImport">IMPORT…</button><button class="btn" id="pFactory">ADD FACTORY PRESETS</button>
    </div>`);
  const render = () => {
    const t = $('#presetTable', b); t.innerHTML = '<tr><th>#</th><th>Name</th><th>Amp</th><th></th></tr>';
    state.bank.forEach((pr, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${String(i + 1).padStart(2, '0')}</td><td class="nm"></td><td class="am"></td><td style="white-space:nowrap"><button class="btn" data-x="load">LOAD</button> <button class="btn" data-x="up">↑</button> <button class="btn" data-x="ren">RENAME</button> <button class="btn" data-x="del">✕</button></td>`;
      tr.querySelector('.nm').textContent = pr.name + (i === state.cur ? '  ◀' : '');
      tr.querySelector('.am').textContent = pr.names?.amp || (pr.amp ? pr.amp : 'built-in');
      tr.onclick = (e) => {
        const x = e.target.dataset.x; if (!x) return;
        if (x === 'load') recall(i);
        if (x === 'up' && i > 0) { [state.bank[i - 1], state.bank[i]] = [state.bank[i], state.bank[i - 1]]; if (state.cur === i) state.cur--; else if (state.cur === i - 1) state.cur++; }
        if (x === 'ren') { const n = prompt('Name', pr.name); if (n) pr.name = n; }
        if (x === 'del' && state.bank.length > 1 && confirm(`Delete "${pr.name}"?`)) { state.bank.splice(i, 1); if (state.cur >= state.bank.length) state.cur = state.bank.length - 1; }
        saveBank(); LS.set('cur', state.cur); renderPresetName(); render();
      };
      t.appendChild(tr);
    });
  };
  render();
  $('#pFactory', b).onclick = () => { FACTORY.forEach((f) => state.bank.push(factoryPreset(f))); saveBank(); render(); };
  $('#pExport', b).onclick = async () => {
    const out = { app: 'profondo', version: 1, bank: state.bank, files: {} };
    if ($('#pWithModels', b).checked) {
      const ids = new Set(state.bank.flatMap((p) => [p.amp, p.pedal, p.cab, p.room, ...Object.values(p.pedals || {})]).filter((x) => x && /^(nam|ir)-/.test(x)));
      for (const id of ids) { const it = await Library.get(id); if (it) out.files[id] = { ...it, bytes: b64(it.bytes) }; }
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'profondo-bank.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#pImport', b).onclick = () => {
    const fi = $('#fileInput'); fi.accept = '.json';
    fi.onchange = async () => {
      const f = fi.files[0]; fi.value = ''; if (!f) return;
      try {
        const j = JSON.parse(await f.text()); if (j.app !== 'profondo') throw new Error('not a Profondo bank');
        for (const [id, it] of Object.entries(j.files || {})) await Library.put({ ...it, id, bytes: unb64(it.bytes) });
        const replace = confirm('Replace the current bank? (Cancel = append)');
        state.bank = replace ? j.bank : state.bank.concat(j.bank); saveBank(); render(); preloadBankModels(); toast(`Imported ${j.bank.length} presets`);
      } catch (e) { toast('Import failed: ' + e.message); }
    };
    fi.click();
  };
}
const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };

async function openLibrary() {
  const b = modal(`<h2>LIBRARY</h2><p class="note">Models and IRs are stored in this browser (IndexedDB). Nothing is uploaded anywhere. <span id="libUse"></span></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="btn" id="libFiles">ADD FILES…</button><button class="btn" id="libFolder">ADD FOLDER…</button></div>
    <input type="search" id="libQ" placeholder="Search…" style="width:100%;margin:6px 0 4px">
    <table id="libT"></table>`);
  $('#libFiles', b).onclick = () => pickFile(null, false, render);
  $('#libFolder', b).onclick = () => pickFile(null, true, render);
  const render = async () => {
    const q = ($('#libQ', b)?.value || '').toLowerCase().trim();
    const all = await Library.list(); const t = $('#libT', b); if (!t) return;
    const list = all.filter((x) => !q || `${x.name} ${x.folder || ''}`.toLowerCase().includes(q));
    const tot = all.reduce((s, x) => s + (x.size || 0), 0);
    $('#libUse', b).textContent = `${all.length} files · ${(tot / 1048576).toFixed(1)} MB.`;
    t.innerHTML = '';
    if (!list.length) { t.innerHTML = '<tr><td colspan="4">' + (all.length ? 'No match.' : 'Empty. Drop .nam / .wav files or whole folders on the rig.') + '</td></tr>'; return; }
    const groups = new Map(); for (const x of list) { const f = x.folder || ''; if (!groups.has(f)) groups.set(f, []); groups.get(f).push(x); }
    for (const f of [...groups.keys()].sort((a, c) => (a === '' ? -1 : c === '' ? 1 : natural.compare(a, c)))) {
      const items = groups.get(f).sort((x, y) => natural.compare(x.name, y.name));
      const hr = document.createElement('tr');
      hr.innerHTML = `<th colspan="3"></th><th style="text-align:right">${items.length > 1 ? '<button class="btn">DELETE FOLDER</button>' : ''}</th>`;
      hr.children[0].textContent = (f ? '📁 ' + f : 'Loose files') + ` · ${items.length}`;
      const fb = hr.querySelector('button'); if (fb) fb.onclick = async () => { if (confirm(`Delete ${items.length} files in "${f || 'Loose files'}"?`)) { for (const x of items) await Library.del(x.id); render(); } };
      t.appendChild(hr);
      for (const x of items) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${x.kind === 'nam' ? 'NAM ' + (x.desc?.arch || '') : 'IR'}</td><td></td><td>${((x.size || 0) / 1024).toFixed(0)} KB</td><td style="text-align:right;white-space:nowrap">${x.kind === 'nam' ? `<select class="lib-cat" title="Category used by NAM pedals">${Object.entries({ ...NAM_CATS, amp: 'AMP' }).filter(([k]) => k !== 'any').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select> ` : ''}<button class="btn">✕</button></td>`;
        tr.children[1].textContent = x.name;
        const cs = tr.querySelector('.lib-cat'); if (cs) { cs.value = namCategory(x); cs.onchange = () => Library.patch(x.id, { cat: cs.value }); }
        tr.querySelector('button').onclick = async () => { await Library.del(x.id); render(); };
        t.appendChild(tr);
      }
    }
  };
  $('#libQ', b).oninput = render;
  render();
}
async function openAudio() {
  const b = modal(`<h2>AUDIO SETTINGS</h2>
    <label>Input device <select id="aIn"></select></label>
    <label>Input channel <select id="aCh"><option value="0">1 (left)</option><option value="1">2 (right)</option></select></label>
    <label>Output device <select id="aOut"></select></label>
    <label>Input trim <input type="range" id="aTrim" min="-24" max="24" step="0.5" style="width:220px"> <span id="aTrimV"></span></label>
    <label>Engine rate <select id="aRate"><option value="48000">48 kHz (NAM standard)</option><option value="44100">44.1 kHz</option><option value="96000">96 kHz</option></select> <span class="note">reloads the page · must match the captures you use</span></label>
    <h3>STATUS</h3>
    <div class="activity" id="aStat"></div>
    <h3>TIPS</h3>
    <ul class="note">
      <li>Plug the bass into an audio interface (Hi-Z / instrument input). Built-in mic inputs work only for testing.</li>
      <li>Mac: set the interface to <b>48 kHz</b> in Audio MIDI Setup — NAM models are trained at 48 kHz. Chrome follows the system buffer size; small buffers = low latency.</li>
      <li>Windows: use Chrome/Edge; if latency is high, enable the interface's low-latency / exclusive mode (browsers don't use ASIO).</li>
      <li>Output device switching needs Chrome/Edge (setSinkId).</li>
    </ul>`);
  const devs = await navigator.mediaDevices.enumerateDevices();
  const cfg = LS.get('audio', {});
  const fill = (sel, kind, curId) => { sel.innerHTML = '<option value="">System default</option>'; devs.filter((d) => d.kind === kind).forEach((d) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || kind; if (d.deviceId === curId) o.selected = true; sel.appendChild(o); }); };
  fill($('#aIn', b), 'audioinput', cfg.input); fill($('#aOut', b), 'audiooutput', cfg.output);
  $('#aCh', b).value = String(cfg.channel || 0);
  if (!engine.ctx.setSinkId) $('#aOut', b).disabled = true;
  const trim = $('#aTrim', b); trim.value = state.p['in.gain']; $('#aTrimV', b).textContent = fmt('in.gain', state.p['in.gain']);
  trim.oninput = () => { setParam('in.gain', +trim.value); $('#aTrimV', b).textContent = fmt('in.gain', +trim.value); };
  const stat = () => { const s = engine.stream?.getAudioTracks()[0]?.getSettings() || {}; $('#aStat', b).textContent = `context ${engine.ctx.sampleRate} Hz · ${engine.ctx.state} · input ${s.channelCount || '?'} ch @ ${s.sampleRate || '?'} Hz · est. latency ${engine.latencyMs()} ms`; };
  stat();
  $('#aIn', b).onchange = async (e) => { cfg.input = e.target.value; LS.set('audio', cfg); try { await engine.startInput(cfg.input, cfg.channel || 0); } catch (err) { toast(err.message); } stat(); };
  $('#aCh', b).onchange = (e) => { cfg.channel = +e.target.value; LS.set('audio', cfg); engine.setInputChannel(cfg.channel); stat(); };
  $('#aRate', b).value = String(cfg.rate || 48000);
  $('#aRate', b).onchange = (e) => { cfg.rate = +e.target.value; LS.set('audio', cfg); saveSession(); setTimeout(() => location.reload(), 400); };
  $('#aOut', b).onchange = async (e) => { cfg.output = e.target.value; LS.set('audio', cfg); try { await engine.setOutput(cfg.output); } catch (err) { toast(err.message); } stat(); };
}

function openMidi() {
  const b = modal(`<h2>MIDI</h2>
    ${midi.supported ? '' : '<p style="color:#ff8a7a">This browser has no Web MIDI. Use Chrome, Edge or Firefox (Safari does not support it).</p>'}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn gold" id="mEnable">${midi.access ? 'MIDI ENABLED' : 'ENABLE MIDI'}</button>
    <button class="btn" id="mLearn">${state.learn ? 'STOP LEARN' : 'START LEARN'}</button>
    <label style="margin:0">Channel <select id="mCh"><option value="0">Omni</option>${Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label></div>
    <label><input type="checkbox" id="mPC"> Program Change → presets (PC 0 = preset 01)</label>
    <label><input type="checkbox" id="mClock"> Follow MIDI clock (sets BPM for the synced delay)</label>
    <h3>INPUTS</h3><div id="midiInputs" class="note">—</div>
    <h3>MONITOR</h3><div class="activity" id="midiAct">waiting for MIDI…</div>
    <h3>MAPPINGS</h3><table id="midiMaps"></table>
    <p class="note"><b>Learn</b>: press LEARN, click any knob, footswitch, chain button, TAP, ◀ ▶, TUNER or BYPASS, then move/press the controller. Knobs follow CC values (expression pedals); switches toggle on each press ("press") or follow the value ("latch", ≥64 = on).</p>
    <h3>NO MIDI CONTROLLER? COMPUTER KEYBOARD</h3>
    <p class="note"><kbd>1</kbd>–<kbd>9</kbd> chain buttons (your pedals in order, then amp, EQ, cab, delay, reverb) · <kbd>←</kbd> <kbd>→</kbd> presets · <kbd>T</kbd> tap · <kbd>U</kbd> tuner · <kbd>B</kbd> bypass · <kbd>L</kbd> learn.<br>
    Phone as a controller: TouchOSC or similar over network MIDI (Mac: Audio MIDI Setup → Network). Cheap footswitches like the M-VAVE Chocolate work over USB or BLE-MIDI.</p>`);
  $('#mCh', b).value = String(midi.settings.channel || 0);
  $('#mPC', b).checked = midi.settings.pc; $('#mClock', b).checked = midi.settings.clock;
  $('#mCh', b).onchange = (e) => { midi.settings.channel = +e.target.value; midi.save(); };
  $('#mPC', b).onchange = (e) => { midi.settings.pc = e.target.checked; midi.save(); };
  $('#mClock', b).onchange = (e) => { midi.settings.clock = e.target.checked; midi.save(); };
  $('#mEnable', b).onclick = async () => { try { await midi.enable(); $('#mEnable', b).textContent = 'MIDI ENABLED'; $('#midiLed').classList.add('on', 'blue'); renderMidiInputs(); } catch (e) { toast(e.message); } };
  $('#mLearn', b).onclick = () => { closeModal(); toggleLearn(); };
  renderMidiInputs(); renderMidiMaps();
}
function renderMidiInputs() {
  const el = $('#midiInputs'); if (!el) return;
  const ins = midi.inputs();
  if (!midi.access) { el.textContent = 'MIDI not enabled.'; return; }
  if (!ins.length) { el.textContent = 'No MIDI inputs found. Connect a controller (USB, Bluetooth or network MIDI).'; return; }
  el.innerHTML = '';
  for (const i of ins) { const l = document.createElement('label'); l.innerHTML = `<input type="checkbox" ${i.on ? 'checked' : ''}> <span></span> <small>(${i.state})</small>`; l.querySelector('span').textContent = i.name; l.querySelector('input').onchange = (e) => midi.setInputEnabled(i.id, e.target.checked); el.appendChild(l); }
}
function renderMidiMaps() {
  const t = $('#midiMaps'); if (!t) return;
  t.innerHTML = '<tr><th>Source</th><th>Target</th><th>Mode</th><th></th></tr>';
  midi.maps.forEach((m, i) => {
    const tr = document.createElement('tr');
    const isSwitch = m.target.startsWith('p:') && isBool(m.target.slice(2));
    tr.innerHTML = `<td>${midi.describe(m)}</td><td></td><td>${isSwitch ? `<select><option value="press">press</option><option value="latch">latch</option></select>` : m.target.startsWith('a:') ? 'trigger' : 'continuous'}</td><td><button class="btn">✕</button></td>`;
    tr.children[1].textContent = targetLabel(m.target);
    const sel = tr.querySelector('select'); if (sel) { sel.value = m.mode || 'press'; sel.onchange = () => { m.mode = sel.value; midi.save(); }; }
    tr.querySelector('button').onclick = () => { midi.removeMap(i); renderMidiMaps(); markMapped(); };
    t.appendChild(tr);
  });
  if (!midi.maps.length) t.innerHTML += '<tr><td colspan="4" class="note">No mappings yet.</td></tr>';
}

function openHelp() {
  const it = (navigator.language || '').toLowerCase().startsWith('it');
  const lang = (() => { try { return localStorage.getItem('profondo.lang'); } catch { return null; } })() || (it ? 'it' : 'en');
  modal(`<h2>PROFONDO ${VERSION}</h2>
  <p>A Neural Amp Modeler rig for bass that runs in the browser — macOS, Windows and Linux. The NAM engine is the official <b>NeuralAmpModelerCore</b> (A1 WaveNet, LSTM, A2 / slimmable) compiled to WebAssembly.</p>
  <p><a class="btn gold" href="guide.html?lang=${lang}" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none;padding:9px 14px">📖 GUIDA COMPLETA / FULL GUIDE ↗</a></p>
  <h3>SIGNAL CHAIN</h3>
  <p>Pedalboard (any order: comp, drive, octaver, envelope filter, chorus, gate, NAM pedals) → NAM amp → EQ → Cab IR → Clean blend (crossover, align, phase) → Tape delay → Reverb → Master + safety limiter.</p>
  <h3>KEYS</h3>
  <p><kbd>1</kbd>–<kbd>9</kbd> blocks · <kbd>←</kbd> <kbd>→</kbd> presets · <kbd>[</kbd> <kbd>]</kbd> amp models · <kbd>,</kbd> <kbd>.</kbd> cab IRs · <kbd>T</kbd> tap · <kbd>U</kbd> tuner · <kbd>B</kbd> bypass · <kbd>L</kbd> MIDI learn · <kbd>Esc</kbd> close</p>
  <p class="note">Code and issues: <a href="https://github.com/MassimoDanieli/profondo" target="_blank" rel="noopener" style="color:var(--gold)">github.com/MassimoDanieli/profondo</a></p>`);
}

// ---------------- tuner ----------------
let tunerRaf = 0;
function toggleTuner() {
  state.tunerOpen = !state.tunerOpen;
  $('#tuner').classList.toggle('hidden', !state.tunerOpen);
  $('#btnTuner .led').classList.toggle('on', state.tunerOpen);
  if (!engine) return;
  const mute = () => engine.master.gain.setTargetAtTime(state.tunerOpen && $('#tMute').checked ? 0 : Math.pow(10, state.p['master.vol'] / 20), engine.ctx.currentTime, 0.02);
  mute(); $('#tMute').onchange = mute;
  cancelAnimationFrame(tunerRaf);
  if (!state.tunerOpen) return;
  const buf = new Float32Array(engine.tunerAnalyser.fftSize);
  let last = 0, smooth = null;
  const loop = (t) => {
    tunerRaf = requestAnimationFrame(loop);
    if (t - last < 70) return; last = t;
    engine.tunerAnalyser.getFloatTimeDomainData(buf);
    const f = detectPitch(buf, engine.ctx.sampleRate);
    if (!f) return;
    smooth = smooth && Math.abs(Math.log2(f / smooth)) < 0.03 ? smooth * 0.6 + f * 0.4 : f;
    const n = noteOf(smooth, +$('#tA4').value || 440);
    $('#tNote').textContent = n.name; $('#tNote').classList.toggle('ok', Math.abs(n.cents) <= 3);
    $('#tFreq').textContent = `${n.name}${n.octave} · ${smooth.toFixed(2)} Hz`;
    $('#tCents').textContent = (n.cents > 0 ? '+' : '') + n.cents + ' cents';
    $('#tNeedle').style.left = (50 + n.cents) + '%';
  };
  tunerRaf = requestAnimationFrame(loop);
}

// ---------------- meters ----------------
const toPct = (lin) => Math.max(0, Math.min(100, (20 * Math.log10(lin + 1e-9) + 60) / 60 * 100));
function startMeters() {
  engine.on('meter', (m) => {
    $('#mIn').style.width = toPct(m.inPk) + '%';
    for (const [uid, gr] of Object.entries(m.gr || {})) { const bar = $(`.pedal[data-uid="${uid}"] .grbar i`); if (bar) bar.style.width = Math.min(100, gr * 5) + '%'; }
    $('#cpu').textContent = `DSP ${Math.round(m.cpu * 100)}%`;
    $('#cpu').style.color = m.cpu > 0.7 ? '#ff6a5a' : '';
  });
  const buf = new Float32Array(engine.outAnalyser.fftSize);
  const loop = () => { engine.outAnalyser.getFloatTimeDomainData(buf); let pk = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > pk) pk = a; } $('#mOut').style.width = toPct(pk) + '%'; requestAnimationFrame(loop); };
  loop();
}

// ---------------- toast ----------------
let toastT = 0;
function toast(s) { const t = $('#toast'); t.textContent = s; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }

// ---------------- start ----------------
async function preloadBankModels() {
  // each slot gets its own instance (pedal and amp never share model state)
  const want = new Set(state.bank.flatMap((p) => { const n = normalizePreset(p); return [p.amp && 'amp|' + p.amp, ...n.board.filter((b) => b.type === 'nam' && n.pedals[b.uid]).map((b) => `nam:${b.uid}|${n.pedals[b.uid]}`)]; }).filter(Boolean));
  for (const k of want) {
    const i = k.lastIndexOf('|'), slot = k.slice(0, i), id = k.slice(i + 1);
    if (state.models[slot]?.id === id) continue;
    const it = await Library.get(id); if (!it) continue;
    try { await engine.loadModel(slot, id, it.bytes, false); } catch {}
  }
}
async function start() {
  const msg = $('#startMsg');
  if (!window.isSecureContext) { msg.textContent = 'Audio input needs https:// or http://localhost. See README.'; return; }
  if (!window.AudioWorkletNode) { msg.textContent = 'This browser has no AudioWorklet. Use a recent Chrome, Edge, Firefox or Safari.'; return; }
  $('#btnStart').disabled = true; msg.textContent = 'Starting engine…';
  try {
    engine = await new Engine().init('nam.wasm', LS.get('audio', {}).rate || 48000);
    engine.setMany(state.p); engine.setBoard(engineBoard());
    await useIR('cab', state.models.cab); await useIR('room', state.models.room);
    const cfg = LS.get('audio', {});
    try { await engine.startInput(cfg.input, cfg.channel || 0); }
    catch (e) { if (cfg.input) { await engine.startInput(null, cfg.channel || 0); } else throw e; }
    if (cfg.output) engine.setOutput(cfg.output).catch(() => {});
    started = true;
    $('#audioLed').classList.add('on', 'green');
    $('#startOverlay').classList.add('hidden');
    startMeters();
    // restore models of the session
    const sess = LS.get('session', null);
    const src = sess || state.bank[state.cur];
    if (src) await applyPresetModels(src, { board: state.board, pedals: normalizePreset(src).pedals, params: {} });
    state.dirty = sess ? !!sess.dirty : false; renderPresetName();
    preloadBankModels();
    if (LS.get('midi.auto', false)) midi.enable().then(() => $('#midiLed').classList.add('on', 'blue')).catch(() => {});
  } catch (e) {
    console.error(e); $('#btnStart').disabled = false;
    msg.textContent = 'Could not start: ' + (e.message || e) + (e.name === 'NotAllowedError' ? ' — allow microphone/audio-input access for this site.' : '');
  }
}

// ---------------- wiring ----------------
function init() {
  $('#ver').textContent = VERSION;
  // restore session (params + IR choices)
  const sess = LS.get('session', null);
  // v0.3 MIDI mappings pointed at the fixed pedals: move them to the legacy board ids
  if (midi.maps.some((m) => LEGACY_KEYS[m.target.slice(2)] || m.target.startsWith('a:pedal-'))) {
    midi.maps = midi.maps.map((m) => ({ ...m, target: LEGACY_KEYS[m.target.slice(2)] ? 'p:' + LEGACY_KEYS[m.target.slice(2)] : m.target.replace(/^a:pedal-/, 'a:nam:n1-') })); midi.save();
  }
  if (sess) {
    const n = normalizePreset(sess); state.board = n.board;
    state.p = { ...defaults(), ...n.params, ...(sess.globals || {}) };
    const cb = CAB_PRESETS[sess.cab], rb = ROOM_PRESETS[sess.room];
    if (sess.cab) state.models.cab = cb ? { id: sess.cab, name: cb.name, builtin: true } : { id: sess.cab, name: sess.names?.cab || 'IR', builtin: false };
    if (sess.room) state.models.room = rb ? { id: sess.room, name: rb.name, builtin: true } : { id: sess.room, name: sess.names?.room || 'IR', builtin: false };
    if (sess.amp) state.models.amp = { id: sess.amp, name: sess.names?.amp || sess.amp };
    for (const b of state.board) if (b.type === 'nam' && n.pedals[b.uid]) state.models['nam:' + b.uid] = { id: n.pedals[b.uid], name: sess.names?.pedals?.[b.uid] || sess.names?.pedal || n.pedals[b.uid] };
  } else if (state.bank[state.cur]) {
    const pr = state.bank[state.cur]; const n = normalizePreset(pr); state.board = n.board; state.p = { ...defaults(), ...n.params };
    if (pr.cab && CAB_PRESETS[pr.cab]) state.models.cab = { id: pr.cab, name: CAB_PRESETS[pr.cab].name, builtin: true };
    if (pr.room && ROOM_PRESETS[pr.room]) state.models.room = { id: pr.room, name: ROOM_PRESETS[pr.room].name, builtin: true };
  }
  if (state.cur >= state.bank.length) state.cur = 0;
  if (!state.board.length && !sess) { const n = normalizePreset({ params: {} }); state.board = n.board; Object.assign(state.p, n.params); }

  $$('.knob').forEach(buildKnob);
  renderBoard(); renderChain(); wireBoardReorder();
  // delay subdivisions
  const dd = $('#delayDiv'); DIV_NAMES.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; dd.appendChild(o); });
  dd.onchange = () => setParam('delay.div', dd.value);
  $$('#delayMode button').forEach((b) => b.onclick = () => !state.learn && setParam('delay.sync', b.dataset.v === 'sync'));
  $$('#delayPP button').forEach((b) => b.onclick = () => !state.learn && setParam('delay.pingpong', b.dataset.v === '1'));

  // learn-mode click interception (capture phase)
  document.addEventListener('click', (e) => {
    if (!state.learn) return;
    if (e.target.closest('#btnLearn, .modal, #dropdown, .foot-btns')) return;
    const lt = learnTargetOf(e.target); if (!lt) return;
    e.preventDefault(); e.stopPropagation();
    $$('.learning').forEach((x) => x.classList.remove('learning'));
    lt.el.classList.add('learning'); midi.startLearn(lt.t);
    toast(`Learning: ${targetLabel(lt.t)} — move a controller`);
  }, true);
  document.addEventListener('contextmenu', (e) => {
    if (!state.learn) return; const lt = learnTargetOf(e.target); if (!lt) return;
    e.preventDefault(); midi.clearMapsFor(lt.t); markMapped(); toast(`Cleared mappings for ${targetLabel(lt.t)}`);
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]'); if (t && !state.learn) { const id = t.dataset.t; setParam(id, !state.p[id]); return; }
    const a = e.target.closest('[data-a]'); if (a && !state.learn) { doAction(a.dataset.a); return; }
    const m = e.target.closest('[data-menu]'); if (m) { openMenu.showAll = false; openMenu(m.dataset.menu, m); return; }
    const f = e.target.closest('[data-file]'); if (f) { pickFile(f.dataset.file); return; }
  });

  // drag & drop
  $$('.drop').forEach(wireDrop);
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => { e.preventDefault(); if (![...e.dataTransfer.types].includes('Files')) return; const files = await droppedEntries(e.dataTransfer); if (files.length) importFiles(files, files.some((x) => NAM_RE.test(x.file.name)) ? 'amp' : 'cab'); });

  $('#btnStart').onclick = start;
  $('#btnSave').onclick = savePreset; $('#btnSaveAs').onclick = savePresetAs; $('#btnPresets').onclick = openPresets;
  $('#presetName').onclick = () => { if (state.learn) return; const pr = state.bank[state.cur]; const n = prompt('Preset name', pr.name); if (n) { pr.name = n; saveBank(); renderPresetName(); } };
  $('#btnAudio').onclick = () => engine ? openAudio() : toast('Start audio first');
  $('#btnMidi').onclick = openMidi; $('#btnLearn').onclick = toggleLearn; $('#btnHelp').onclick = openHelp;
  $('#modalX').onclick = closeModal; $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '9') { const blk = chainBlocks()[+k - 1]; if (blk) setParam(blk[0], !state.p[blk[0]]); }
    else if (k === 'arrowleft') doAction('a:prev'); else if (k === 'arrowright') doAction('a:next');
    else if (k === 't') doAction('a:tap'); else if (k === 'u') doAction('a:tuner'); else if (k === 'b') doAction('a:bypass');
    else if (k === 'l') toggleLearn();
    else if (e.key === '[' || e.key === ']') doAction(e.key === ']' ? 'a:amp-next' : 'a:amp-prev');
    else if (e.key === ',' || e.key === '.') doAction(e.key === '.' ? 'a:cab-next' : 'a:cab-prev');
    else if (k === 'escape') { closeModal(); closeMenu(); if (state.tunerOpen) toggleTuner(); if (state.learn) toggleLearn(); }
    else return;
    e.preventDefault();
  });

  renderAll(); markMapped();
  if (sess) { state.dirty = !!sess.dirty; renderPresetName(); }
  if (midi.maps.length && midi.supported) LS.set('midi.auto', true);
  window.__profondo = { state, get engine() { return engine; }, setParam, recall, addFile, importFiles, midi, Library, addPedal, removePedal, movePedal, normalizePreset };
}
init();
