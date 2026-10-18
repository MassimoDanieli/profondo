// End-to-end checks in headless Chromium (fake audio input). Usage: node tests/e2e.mjs <NAM example_models dir>
import { chromium } from 'playwright';
import path from 'path'; import fs from 'fs'; import os from 'os'; import { fileURLToPath } from 'url';
import { serve } from './serve.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const models = path.resolve(process.argv[2] || '.deps/NeuralAmpModelerCore/example_models');
const server = await serve(path.join(here, '../app'), models);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ permissions: ['microphone'], viewport: { width: 1360, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (ok, name, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };

await page.goto(server.url); await page.evaluate(() => localStorage.clear()); await page.reload();

// ---- 1. worklet + loader worker: normalization, separate instances, slice-wise adoption, invalid model
const w = await page.evaluate(async () => {
  const out = {};
  const wbytes = await (await fetch('nam.wasm')).arrayBuffer();
  const mod = await WebAssembly.compile(wbytes);
  const N = 800 * 128, sig = new Float32Array(N); for (let t = 0; t < N; t++) sig[t] = 0.3 * Math.sin(t * 0.01 + t * t * 1e-7) + 0.05 * Math.sin(t * 0.37);
  // reference: plain instance on the main thread
  let mem; const h = new Proxy({}, { get: (_, n) => n === 'environ_sizes_get' ? (a, b) => { const v = new DataView(mem.buffer); v.setUint32(a, 0, true); v.setUint32(b, 0, true); return 0; } : n === 'fd_prestat_get' ? () => 8 : () => 0 });
  const ri = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: h }); mem = ri.exports.memory; const x = ri.exports; x._initialize();
  const mb = new Uint8Array(await (await fetch('/models/A2.nam')).arrayBuffer()); const p = x.nam_alloc(mb.length); new Uint8Array(mem.buffer).set(mb, p); x.nam_load(p, mb.length, 48000, 128);
  const ip = x.nam_in() >> 2, op = x.nam_out() >> 2, ref = new Float32Array(N);
  for (let b = 0; b < N / 128; b++) { const f = new Float32Array(mem.buffer); f.set(sig.subarray(b * 128, b * 128 + 128), ip); x.nam_process(128); ref.set(new Float32Array(mem.buffer).subarray(op, op + 128), b * 128); }
  const loud = x.nam_loudness();

  const ctx = new OfflineAudioContext(1, N, 48000);
  await ctx.audioWorklet.addModule('worklet.js');
  const node = new AudioWorkletNode(ctx, 'profondo-front', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [1, 1], channelCount: 1, channelCountMode: 'explicit' });
  const msgs = []; node.port.onmessage = (e) => { if (e.data.type !== 'meter') msgs.push(e.data); };
  const until = (pred) => new Promise((r) => { const iv = setInterval(() => { const m = msgs.find(pred); if (m) { clearInterval(iv); r(m); } }, 10); });
  node.port.postMessage({ type: 'wasm', bytes: wbytes.slice(0) }); await until((m) => m.type === 'ready');
  const worker = new Worker('nam-loader-worker.js');
  const wcall = (msg, tr) => new Promise((r) => { worker.onmessage = (e) => r(e.data); worker.postMessage(msg, tr || []); });
  await wcall({ type: 'init', bytes: wbytes.slice(0) });
  const build = async (u) => { const bytes = await (await fetch(u)).arrayBuffer(); return wcall({ type: 'load', req: 1, bytes, sampleRate: 48000 }, [bytes]); };
  node.port.postMessage({ type: 'params', p: { normalize: 1 } });
  node.port.postMessage({ type: 'board', list: [{ uid: 'x1', type: 'nam', variant: '', on: false, p: { input: 0, level: 0 } }] });
  const bA = await build('/models/A2.nam'), bP = await build('/models/A2.nam');
  node.port.postMessage({ type: 'adopt', slot: 'amp', id: 'A2', activate: true, info: bA.info, snapshot: bA.snapshot, req: 2 }, [bA.snapshot]);
  node.port.postMessage({ type: 'adopt', slot: 'nam:x1', id: 'A2', activate: true, info: bP.info, snapshot: bP.snapshot, req: 3 }, [bP.snapshot]);
  const src = ctx.createBufferSource(); const buf = ctx.createBuffer(1, N, 48000); buf.getChannelData(0).set(sig); src.buffer = buf; src.connect(node); node.connect(ctx.destination, 0); src.start();
  const r = (await ctx.startRendering()).getChannelData(0);
  await new Promise((res) => setTimeout(res, 300));
  node.port.postMessage({ type: 'debug', req: 4 }); const dbg = await until((m) => m.type === 'debug');
  const expected = Math.pow(10, (-18 - loud) / 20); let num = 0, den = 0, md = 0;
  for (let i = 16384; i < N; i++) { num += r[i] * ref[i]; den += ref[i] * ref[i]; md = Math.max(md, Math.abs(r[i] - ref[i] * expected)); }
  out.expected = expected; out.measured = num / den; out.maxErr = md;
  out.loads = msgs.filter((m) => m.type === 'loaded').map((m) => ({ slot: m.slot, worst: m.maxStepMs }));
  out.shared = dbg.shared; out.keys = dbg.cache;
  const bad = await wcall({ type: 'load', req: 9, bytes: new TextEncoder().encode('{"version":"0.5.0","architecture":"Nope","config":{},"weights":[]}').buffer, sampleRate: 48000 });
  out.bad = bad.type;
  return out;
});
check(Math.abs(w.measured / w.expected - 1) < 1e-4 && w.maxErr < 1e-4, 'normalization applied in steady state', `expected ${w.expected.toFixed(4)}, measured ${w.measured.toFixed(4)}`);
check(w.loads.length >= 1 && w.loads.every((l) => l.worst <= 5), 'models adopted slice-wise on the audio thread', JSON.stringify(w.loads));
check(!w.shared && w.keys.length === 2, 'pedal and amp get independent instances of the same model');
check(w.bad === 'error', 'invalid model rejected by the loader');

// ---- 2. full app
await page.click('#btnStart'); await page.waitForTimeout(2000);
check(await page.$eval('#startOverlay', (e) => e.classList.contains('hidden')), 'engine starts with audio input');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-file="amp"]')]); await fc.setFiles(path.join(models, 'A2.nam'));
await page.waitForTimeout(2000);
check((await page.textContent('#ampName')) === 'A2' && (await page.textContent('#ampInfo')).includes('loaded'), 'amp model loads through the UI');
const a = await page.evaluate(async () => {
  const P = window.__profondo, midi = P.midi, out = {};
  midi.access = midi.access || { inputs: new Map() };
  P.state.learn = true; document.body.classList.add('learn');
  document.querySelector('.knob[data-p="eq.bass"]').click(); midi.onMessage([0xb0, 11, 100]);
  document.querySelector('[data-t="delay.on"]').click(); midi.onMessage([0x90, 60, 127]);
  document.querySelector('#btnTap').click(); midi.onMessage([0xb0, 80, 127]);
  P.state.learn = false; document.body.classList.remove('learn');
  midi.onMessage([0xb0, 11, 127]); out.bassMax = P.state.p['eq.bass']; midi.onMessage([0xb0, 11, 0]); out.bassMin = P.state.p['eq.bass'];
  const d0 = P.state.p['delay.on']; midi.onMessage([0x90, 60, 127]); midi.onMessage([0x80, 60, 0]); out.toggled = P.state.p['delay.on'] !== d0;
  midi.onMessage([0xb0, 80, 127]); await new Promise((r) => setTimeout(r, 500)); midi.onMessage([0xb0, 80, 127]); out.bpm = P.state.p.bpm;
  midi.onMessage([0xc0, 2]); await new Promise((r) => setTimeout(r, 300)); out.preset = P.state.cur;
  midi.settings.clock = true; const iv = 60000 / 100 / 24; midi.clockTimes = []; for (let i = 0; i < 48; i++) midi.clockTimes.push(i * iv);
  const now = performance.now; performance.now = () => 48 * iv; midi.clockTick(); performance.now = now; out.clockBpm = P.state.p.bpm;
  await P.recall(0); out.cleanDiAmp = P.state.p['amp.on'];
  for (const b of P.state.board) P.setParam(`pb.${b.uid}.on`, true);
  for (const k of ['amp.on', 'eq.on', 'cab.on', 'delay.on', 'rev.on']) P.setParam(k, true);
  P.setParam('blend.amount', 40); P.setParam('blend.xover', 150);
  await new Promise((r) => setTimeout(r, 1200));
  const b = new Float32Array(1024); P.engine.outAnalyser.getFloatTimeDomainData(b); out.finite = b.every(Number.isFinite);
  return out;
});
check(a.bassMax === 12 && a.bassMin === -12, 'MIDI learn: CC → knob (full range)');
check(a.toggled, 'MIDI learn: note → switch');
check(Math.abs(a.bpm - 120) < 2, 'MIDI tap tempo', `${a.bpm} BPM`);
check(a.preset === 2, 'Program Change → preset');
check(a.clockBpm === 100, 'MIDI clock → BPM');
check(a.cleanDiAmp === false, '"Clean DI" preset has the amp off');
check(a.finite, 'full chain output is finite');

// ---- 3. clean auto-alignment against cab IRs with known delay / polarity
const al = await page.evaluate(async () => {
  const P = window.__profondo, e = P.engine, ctx = e.ctx, sr = ctx.sampleRate, res = [];
  e.srcNode.disconnect();
  // known-delay check: keep the chain neutral (drive's high-pass and EQ shift the low-frequency phase on purpose)
  for (const b of P.state.board) P.setParam(`pb.${b.uid}.on`, false);
  for (const k of ['delay.on', 'rev.on']) P.setParam(k, false);
  for (const k of ['eq.bass', 'eq.lowmid', 'eq.mid', 'eq.treble', 'eq.presence', 'blend.xover']) P.setParam(k, 0);
  const N = sr * 8, buf = ctx.createBuffer(1, N, sr), d = buf.getChannelData(0); const notes = [41.2, 55, 73.4, 98, 61.7, 82.4]; let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 32; n++) { const f = notes[Math.floor(rnd() * notes.length)], st = n * sr / 4; for (let i = 0; i < sr / 4; i++) { const t = i / sr; d[st + i] = 0.25 * Math.exp(-t * 3) * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t)); } }
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(e.inGain); s.start();
  for (const [ms, sign] of [[5, 1], [3.2, -1]]) {
    const len = 2048, pos = Math.round(ms * sr / 1000), dv = new DataView(new ArrayBuffer(44 + len * 2)); const w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, len * 2, true); dv.setInt16(44 + pos * 2, sign * 30000, true);
    await e.setCabFile('t' + ms, dv.buffer); P.setParam('cab.on', true); P.setParam('amp.on', true);
    await new Promise((r) => setTimeout(r, 300));
    res.push({ ms, invert: sign < 0, got: await e.measureAlignment(2000) });
  }
  return res;
});
for (const r of al) check(r.got && Math.abs(r.got.ms - r.ms) < 0.8 && r.got.invert === r.invert, `auto-align finds ${r.ms} ms${r.invert ? ' inverted' : ''}`, r.got ? `${r.got.ms} ms, invert ${r.got.invert}` : 'no result');

// ---- 3a. pedalboard: add, types, order, migration, NAM pedals, every pedal type produces sane audio
{
  const r = await page.evaluate(async () => {
    const P = window.__profondo, out = {};
    const dbg = () => new Promise((res) => { const e = P.engine; const h = (m) => { if (m.data.type === 'debug') { e.front.port.removeEventListener('message', h); res(m.data); } }; e.front.port.addEventListener('message', h); e.front.port.postMessage({ type: 'debug' }); });
    // legacy v0.3 preset → board
    const n = P.normalizePreset({ params: { 'comp.on': true, 'comp.sustain': 7, 'drive.on': true, 'drive.gain': 8, 'gate.thresh': -50 }, pedal: 'nam-x' });
    out.legacy = n.board.map((b) => b.type + ':' + b.variant).join(' ') + ` | comp ${n.params['pb.c1.amount']} on ${n.params['pb.c1.on']} | drive ${n.params['pb.d1.gain']} | gate ${n.params['pb.g1.thresh']} | pedal ${n.pedals.n1}`;
    // fresh board with every type and variant
    for (const b of [...P.state.board]) P.removePedal(b.uid);
    const uids = ['comp', 'drive', 'octave', 'envf', 'chorus', 'gate', 'nam'].map((t) => P.addPedal(t));
    await new Promise((r) => setTimeout(r, 300));
    out.board = (await dbg()).board.map((x) => x.split(':')[0]).join(' ');
    out.di = (await dbg()).di;
    P.movePedal(uids[1], 0, 0); // drive to the front
    await new Promise((r) => setTimeout(r, 200));
    out.reordered = (await dbg()).board.map((x) => x.split(':')[0]).join(' ');
    out.diAfter = (await dbg()).di;
    // every variant: output finite and not silent, with a bass-like test tone
    const e = P.engine, ctx = e.ctx, sr = ctx.sampleRate;
    e.srcNode?.disconnect(); window.__src?.disconnect();
    const osc = ctx.createOscillator(); osc.frequency.value = 55; const og = ctx.createGain(); og.gain.value = 0.3; osc.connect(og); og.connect(e.inGain); osc.start();
    const level = async () => { await new Promise((r) => setTimeout(r, 450)); const a = new Float32Array(2048); e.outAnalyser.getFloatTimeDomainData(a); let pk = 0, ok = true; for (const v of a) { if (!Number.isFinite(v)) ok = false; pk = Math.max(pk, Math.abs(v)); } return ok ? pk : NaN; };
    out.levels = {};
    const board = P.state.board;
    for (const b of board) P.setParam(`pb.${b.uid}.on`, false);
    const sel = (b, v) => { b.variant = v; e.setPedal(b.uid, { variant: v }); };
    for (const b of board) {
      if (b.type === 'nam') continue;
      P.setParam(`pb.${b.uid}.on`, true);
      const vars = { comp: ['opto', 'vca', 'fet', 'multi'], drive: ['tube', 'dist', 'fuzz', 'octfuzz'], envf: ['lp', 'bp', 'down'] }[b.type] || [''];
      for (const v of vars) { if (v) sel(b, v); out.levels[b.type + (v ? ':' + v : '')] = +(await level()).toFixed(3); }
      P.setParam(`pb.${b.uid}.on`, false);
    }
    osc.stop();
    return out;
  });
  check(r.legacy.startsWith('gate: comp:vca drive:tube nam:') && r.legacy.includes('comp 7 on true') && r.legacy.includes('drive 8') && r.legacy.includes('gate -50') && r.legacy.includes('pedal nam-x'), 'v0.3 presets become a pedalboard', r.legacy);
  check(r.board === 'comp drive octave envf chorus gate nam' && r.di === 1, 'pedals added in order; DI after leading comp', `${r.board} · DI ${r.di}`);
  check(r.reordered.startsWith('drive comp') && r.diAfter === 0, 'reorder reaches the engine; DI follows', `${r.reordered} · DI ${r.diAfter}`);
  const bad = Object.entries(r.levels).filter(([, v]) => !(v > 0.002 && v < 2));
  check(Object.keys(r.levels).length === 14 && !bad.length, 'every pedal type and variant produces sane audio', JSON.stringify(r.levels));
  // NAM pedal: load a capture through its own LOAD, category filter
  const namUid = await page.evaluate(() => window.__profondo.state.board.find((b) => b.type === 'nam').uid);
  const [fcN] = await Promise.all([page.waitForEvent('filechooser'), page.click(`[data-file="nam:${namUid}"]`)]);
  await fcN.setFiles(path.join(models, 'lstm.nam')); await page.waitForTimeout(1500);
  check((await page.textContent(`.pedal[data-uid="${namUid}"] .nam-name`)).length > 0 && (await page.evaluate((u) => !!window.__profondo.state.p[`pb.${u}.on`], namUid)), 'NAM pedal loads its own capture and switches on', await page.textContent(`.pedal[data-uid="${namUid}"] .nam-name`));
  const second = await page.evaluate(() => window.__profondo.addPedal('nam'));
  await page.waitForTimeout(300);
  const [fcN2] = await Promise.all([page.waitForEvent('filechooser'), page.click(`[data-file="nam:${second}"]`)]);
  await fcN2.setFiles(path.join(models, 'lstm.nam')); await page.waitForTimeout(1500);
  const shared = await page.evaluate(() => new Promise((res) => { const e = window.__profondo.engine; const h = (m) => { if (m.data.type === 'debug') { e.front.port.removeEventListener('message', h); res(m.data.shared); } }; e.front.port.addEventListener('message', h); e.front.port.postMessage({ type: 'debug' }); }));
  check(shared === false, 'two NAM pedals with the same capture keep separate state');
  // save + recall keeps the board, variants and the NAM captures
  const rt = await page.evaluate(async () => {
    const P = window.__profondo, sig = () => JSON.stringify(P.state.board.map((b) => [b.type, b.variant, P.state.models['nam:' + b.uid]?.id || null, P.state.p[`pb.${b.uid}.on`]]));
    const comp = P.state.board.find((b) => b.type === 'comp'); comp.variant = 'fet'; P.setParam(`pb.${comp.uid}.amount`, 8.5);
    const before = sig(), cur = P.state.cur;
    document.querySelector('#btnSave').click();
    await P.recall(cur === 1 ? 2 : 1); const other = sig();
    await P.recall(cur); await new Promise((r) => setTimeout(r, 1200));
    return { before, after: sig(), other, amount: P.state.p[`pb.${P.state.board.find((b) => b.type === 'comp').uid}.amount`] };
  });
  check(rt.before === rt.after && rt.other !== rt.before && rt.amount === 8.5, 'preset save / recall restores board, types and NAM captures', rt.after);
}

// ---- 3b. multi-file and folder import, library browsing
{
  const nams = fs.readdirSync(models).filter((f) => f.endsWith('.nam')).map((f) => path.join(models, f));
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-file="amp"]')]);
  check(await fc2.isMultiple(), 'LOAD accepts multiple files');
  await fc2.setFiles(nams); await page.waitForTimeout(2500);
  const lib1 = await page.evaluate(async () => (await window.__profondo.Library.list()).filter((x) => x.kind === 'nam').length);
  check(lib1 >= nams.length - 1, 'multi-select imports every capture', `${lib1} of ${nams.length} in library`);
  const before = await page.textContent('#ampName');
  await page.click('[data-a="a:amp-next"]'); await page.waitForTimeout(1500);
  const after = await page.textContent('#ampName');
  check(before !== after, '▸ steps to the next model', `${before} → ${after}`);
  await page.click('[data-menu="amp"]'); await page.waitForTimeout(300);
  const hasSearch = await page.$('#dropdown .dd-search');
  if (hasSearch) { await page.fill('#dropdown .dd-search', 'lstm'); await page.waitForTimeout(100); }
  const rows = await page.$$eval('#dropdown .dd-body > div:not(.sec)', (r) => r.map((x) => x.textContent));
  check(!!hasSearch && rows.length === 1 && /lstm/i.test(rows[0]), 'model menu search filters the library', JSON.stringify(rows));
  await page.keyboard.press('Escape');
  // folder with subfolders, mixed .nam + .wav
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-')), pack = path.join(dir, 'BassPack');
  fs.mkdirSync(path.join(pack, 'Amps'), { recursive: true }); fs.mkdirSync(path.join(pack, 'Cabs'));
  const tiny = JSON.parse(fs.readFileSync(path.join(models, 'lstm.nam'), 'utf8')); tiny.metadata = { ...(tiny.metadata || {}), name: 'Tiny LSTM' };
  fs.writeFileSync(path.join(pack, 'Amps', 'Tiny LSTM.nam'), JSON.stringify(tiny)); // distinct file (identical files are de-duplicated)
  const wav = (ms) => { const sr = 48000, len = 1024, b = Buffer.alloc(44 + len * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + len * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(len * 2, 40); b.writeInt16LE(20000, 44 + Math.round(ms * 48) * 2); return b; };
  fs.writeFileSync(path.join(pack, 'Cabs', '810 SM57.wav'), wav(0.5)); fs.writeFileSync(path.join(pack, 'Cabs', '410 R121.wav'), wav(1)); fs.writeFileSync(path.join(pack, 'readme.txt'), 'x');
  await page.click('[data-menu="cab"]'); await page.waitForTimeout(200);
  const [fc3] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#dropdown .dd-body > div', { hasText: 'Import a whole folder' }).click()]);
  await fc3.setFiles(pack); await page.waitForTimeout(2500);
  const lib2 = await page.evaluate(async () => (await window.__profondo.Library.list()).filter((x) => x.folder && x.folder.startsWith('BassPack')).map((x) => `${x.kind}:${x.folder}/${x.name}`).sort());
  check(lib2.length === 3 && lib2.includes('ir:BassPack/Cabs/410 R121') && lib2.includes('nam:BassPack/Amps/Tiny LSTM'), 'folder import keeps subfolders, mixed .nam and .wav', JSON.stringify(lib2));
  check((await page.textContent('#cabName')) === '410 R121', 'first IR of the folder becomes the cab', await page.textContent('#cabName'));
  await page.click('[data-a="a:cab-next"]'); await page.waitForTimeout(800);
  check((await page.textContent('#cabName')) === '810 SM57', 'cab ▸ steps inside the same folder', await page.textContent('#cabName'));
  await page.click('[data-menu="cab"]'); await page.waitForTimeout(200);
  const secs = await page.$$eval('#dropdown .dd-body > div.sec', (r) => r.map((x) => x.textContent));
  check(secs.some((s) => s.includes('BassPack/Cabs')), 'cab menu groups IRs by folder', JSON.stringify(secs));
  await page.keyboard.press('Escape');
}

// ---- 4. tuner + mobile layout
await page.keyboard.press('u'); await page.waitForTimeout(1200);
check(/^[A-G]#?$/.test(await page.textContent('#tNote')), 'tuner detects a note', await page.textContent('#tFreq'));
await page.keyboard.press('u');
await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(300);
check((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'no horizontal scroll at phone width');
check(errors.length === 0, 'no page errors', errors.join(' | '));

// ---- 5. guide page
const gp = await browser.newPage(); const gErr = []; gp.on('pageerror', (e) => gErr.push(e.message));
await gp.goto(server.url + '/guide.html?lang=it');
const gIt = await gp.evaluate(() => ({ lang: document.documentElement.lang, h1: [...document.querySelectorAll('h1')].find((h) => h.offsetParent)?.textContent, sections: [...document.querySelectorAll('.wrap[data-lang="it"] main h2')].length }));
await gp.click('[data-set-lang="en"]');
const gEn = await gp.evaluate(() => ({ lang: document.documentElement.lang, h1: [...document.querySelectorAll('h1')].find((h) => h.offsetParent)?.textContent, sections: [...document.querySelectorAll('.wrap[data-lang="en"] main h2')].length, scroll: document.documentElement.scrollWidth }));
const ids = await gp.evaluate(() => [...document.querySelectorAll('nav.toc a')].every((a) => document.querySelector(a.getAttribute('href'))));
check(gIt.h1 === 'Guida a Profondo' && gEn.h1 === 'Profondo guide' && gIt.sections === 12 && gEn.sections === 12, 'guide renders in IT and EN', `${gIt.sections}/${gEn.sections} sections`);
check(ids, 'guide table of contents links resolve');
await gp.setViewportSize({ width: 390, height: 800 });
check((await gp.evaluate(() => document.documentElement.scrollWidth)) <= 390 && gErr.length === 0, 'guide: phone width, no errors', gErr.join(' | '));

await browser.close(); server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
