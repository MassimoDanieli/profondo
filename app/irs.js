// Built-in, synthesized impulse responses (no third-party IRs bundled).

export const CAB_PRESETS = {
  'syn-810': { name: '8x10 Classic (synth)', f: [['highpass', 45, 0.7], ['peaking', 90, 1, 4], ['peaking', 450, 1.2, -4], ['peaking', 2200, 2, 3], ['lowpass', 4500, 0.9], ['lowpass', 6000, 0.7]] },
  'syn-410': { name: '4x10 Modern (synth)', f: [['highpass', 40, 0.7], ['peaking', 110, 1, 3], ['peaking', 600, 1, -2.5], ['peaking', 3000, 1.5, 4], ['lowpass', 6500, 1], ['lowpass', 8000, 0.7]] },
  'syn-115': { name: '1x15 Vintage (synth)', f: [['highpass', 35, 0.7], ['peaking', 80, 1, 5], ['peaking', 800, 1, -3], ['lowpass', 2600, 1], ['lowpass', 3500, 0.7]] },
  'syn-212': { name: '2x12 Mid Punch (synth)', f: [['highpass', 60, 0.7], ['peaking', 150, 1, 2], ['peaking', 1000, 1, 3], ['lowpass', 5000, 0.8], ['lowpass', 7000, 0.7]] },
  'syn-frfr': { name: 'Full range / FRFR', f: [['highpass', 30, 0.7], ['lowpass', 16000, 0.7]] },
};

export const ROOM_PRESETS = {
  'rev-room': { name: 'Small Room', decay: 0.7, bright: 0.45, density: 1 },
  'rev-studio': { name: 'Studio Live', decay: 1.2, bright: 0.55, density: 1 },
  'rev-plate': { name: 'Plate', decay: 2.2, bright: 0.85, density: 1.4 },
  'rev-hall': { name: 'Concert Hall', decay: 3.6, bright: 0.5, density: 1 },
  'rev-dub': { name: 'Dub Chamber', decay: 5.5, bright: 0.3, density: 0.8 },
};

export async function makeCabIR(id, sr) {
  const spec = CAB_PRESETS[id];
  const len = 4096;
  const oc = new OfflineAudioContext(1, len, sr);
  const b = oc.createBuffer(1, len, sr);
  const d = b.getChannelData(0);
  d[0] = 1; d[Math.round(0.00031 * sr)] = 0.32; d[Math.round(0.00088 * sr)] = -0.14; // cone/cabinet early reflections
  const src = oc.createBufferSource(); src.buffer = b;
  let node = src;
  for (const [type, f, q, gain] of spec.f) {
    const bq = oc.createBiquadFilter(); bq.type = type; bq.frequency.value = f; bq.Q.value = q; if (gain !== undefined) bq.gain.value = gain;
    node.connect(bq); node = bq;
  }
  node.connect(oc.destination); src.start();
  const out = await oc.startRendering();
  normalizeIR(out);
  return out;
}

export function normalizeIR(buf) {
  // normalize energy so cab level stays consistent between IRs
  let e = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) e += d[i] * d[i]; }
  const k = 1 / Math.sqrt(e / buf.numberOfChannels + 1e-12);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
  return buf;
}

export function makeRoomIR(ctx, id) {
  const spec = ROOM_PRESETS[id];
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * Math.min(8, spec.decay * 1.4));
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-6.9 * t / spec.decay);
      // damping: gets darker with time
      const a = Math.max(0.03, spec.bright * Math.exp(-t * 1.5 / spec.decay));
      lp += a * (rnd() - lp);
      const sparse = spec.density < 1 && rnd() > spec.density ? 0 : 1;
      d[i] = lp * env * sparse;
    }
    // early reflections
    for (let k = 0; k < 8; k++) {
      const pos = Math.floor((0.004 + 0.009 * k + 0.003 * c) * sr * (0.5 + spec.decay / 3));
      if (pos < len) d[pos] += 0.6 * Math.exp(-k * 0.35) * (k % 2 ? -1 : 1);
    }
  }
  return normalizeIR(buf);
}
