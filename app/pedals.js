// Profondo — pedal catalogue (shared by the UI; the DSP lives in pedal-dsp.js)
// params: key: [label, min, max, default, unit, log, onlyForVariants?]

export const PEDALS = {
  gate: {
    label: 'GATE', color: 'gate', sub: 'noise gate',
    params: { thresh: ['THRESH', -90, -20, -65, 'dB'], release: ['RELEASE', 20, 500, 120, 'ms', 1] },
  },
  comp: {
    label: 'COMP', color: 'comp', gr: true,
    variants: { opto: 'OPTO · smooth', vca: 'VCA · punchy', fet: 'FET · aggressive', multi: 'MULTIBAND · 2 bands' },
    defaultVariant: 'opto',
    params: {
      amount: ['SUSTAIN', 0, 10, 4, ''], attack: ['ATTACK', 1, 50, 10, 'ms', 1], release: ['RELEASE', 30, 800, 180, 'ms', 1],
      level: ['LEVEL', -12, 12, 0, 'dB'], blend: ['BLEND', 0, 100, 100, '%'], xover: ['X-OVER', 60, 400, 150, 'Hz', 1, ['multi']],
    },
  },
  drive: {
    label: 'DRIVE', color: 'drive',
    variants: { tube: 'TUBE OD', dist: 'BASS DISTORTION', fuzz: 'FUZZ', octfuzz: 'OCTAVE FUZZ' },
    defaultVariant: 'tube',
    params: { gain: ['GAIN', 0, 10, 4, ''], tone: ['TONE', 0, 10, 5, ''], level: ['LEVEL', -24, 12, 0, 'dB'], blend: ['BLEND', 0, 100, 50, '%'] },
  },
  octave: {
    label: 'OCTAVER', color: 'octave', sub: 'monophonic sub octaves',
    params: { sub1: ['SUB −1', 0, 100, 70, '%'], sub2: ['SUB −2', 0, 100, 0, '%'], dry: ['DRY', 0, 100, 80, '%'], tone: ['TONE', 0, 10, 4, ''] },
  },
  envf: {
    label: 'ENV FILTER', color: 'envf',
    variants: { lp: 'LOW-PASS · up', bp: 'BAND-PASS · up', down: 'LOW-PASS · down' },
    defaultVariant: 'lp',
    params: { sens: ['SENS', 0, 10, 5, ''], range: ['RANGE', 0, 10, 6, ''], reso: ['RESO', 0, 10, 5, ''], mix: ['MIX', 0, 100, 80, '%'] },
  },
  chorus: {
    label: 'CHORUS', color: 'chorus', sub: 'bass chorus · lows stay dry',
    params: { rate: ['RATE', 0.1, 5, 0.8, 'Hz', 1], depth: ['DEPTH', 0, 10, 5, ''], mix: ['MIX', 0, 100, 50, '%'], xover: ['X-OVER', 40, 400, 120, 'Hz', 1] },
  },
  nam: {
    label: 'NAM PEDAL', color: 'nam', nam: true,
    params: { input: ['INPUT', -12, 12, 0, 'dB'], level: ['LEVEL', -24, 12, 0, 'dB'] },
  },
};
export const PEDAL_ORDER = ['comp', 'drive', 'octave', 'envf', 'chorus', 'nam', 'gate'];
export const MAX_PEDALS = 8;

// NAM capture categories (for the NAM pedal's filter)
export const NAM_CATS = { any: 'ALL', comp: 'COMP', drive: 'DRIVE', fuzz: 'FUZZ', preamp: 'PREAMP / DI', other: 'OTHER' };
export function namCategory(x) {
  if (x.cat) return x.cat;
  const d = x.desc || {};
  const t = `${x.name || ''} ${x.file || ''} ${x.folder || ''} ${d.make || ''} ${d.model || ''}`.toLowerCase();
  const tone = (d.tone || '').toLowerCase(), gear = (d.type || '').toLowerCase();
  if (/\bcomp|compressor|squeeze|limiter|1176|la-?2a|\bopto\b|dyna/.test(t)) return 'comp';
  if (tone === 'fuzz' || /fuzz|muff|bender|fuzz ?face|octavia/.test(t)) return 'fuzz';
  if (gear === 'preamp' || /pre-?amp|sansamp|\bb7k\b|darkglass|\bvintage microtubes\b|\bdi\b|bass driver|\bvt ?bass\b/.test(t)) return 'preamp';
  if (['overdrive', 'crunch', 'hi_gain', 'distortion'].includes(tone) || /drive|\bod\b|distortion|\bdist\b|boost|klon|screamer|\bts-?\d|\brat\b|grit/.test(t)) return 'drive';
  if (gear.startsWith('pedal')) return 'other';
  return gear ? (gear.startsWith('amp') ? 'amp' : 'other') : 'other';
}

let uidN = 0;
export const newUid = () => 'p' + Date.now().toString(36).slice(-4) + (uidN++).toString(36) + Math.random().toString(36).slice(2, 4);

export function variantsOf(type) { return PEDALS[type].variants || null; }
export function paramsFor(type, variant) {
  return Object.entries(PEDALS[type].params).filter(([, d]) => !d[6] || d[6].includes(variant));
}
export function pedalDefaults(type) {
  const o = {}; for (const [k, d] of Object.entries(PEDALS[type].params)) o[k] = d[3]; return o;
}

// v0.3 presets had a fixed gate → comp → drive → NAM pedal chain with global parameter ids
export const LEGACY_BOARD = [
  { uid: 'g1', type: 'gate' }, { uid: 'c1', type: 'comp', variant: 'vca' }, { uid: 'd1', type: 'drive', variant: 'tube' }, { uid: 'n1', type: 'nam', cat: 'any' },
];
export const LEGACY_KEYS = {
  'gate.on': 'pb.g1.on', 'gate.thresh': 'pb.g1.thresh', 'gate.release': 'pb.g1.release',
  'comp.on': 'pb.c1.on', 'comp.sustain': 'pb.c1.amount', 'comp.attack': 'pb.c1.attack', 'comp.level': 'pb.c1.level', 'comp.blend': 'pb.c1.blend',
  'drive.on': 'pb.d1.on', 'drive.gain': 'pb.d1.gain', 'drive.tone': 'pb.d1.tone', 'drive.level': 'pb.d1.level', 'drive.blend': 'pb.d1.blend',
  'pedal.on': 'pb.n1.on', 'pedal.input': 'pb.n1.input', 'pedal.level': 'pb.n1.level',
};
