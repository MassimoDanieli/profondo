// Compare app/nam.wasm (loaded exactly like app/nam-loader-worker.js) against the native core for every example model.
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
const [,, refBin, modelsDir] = process.argv;
const mod = new WebAssembly.Module(fs.readFileSync(new URL('../app/nam.wasm', import.meta.url)));
const wasi = (gm) => ({ wasi_snapshot_preview1: new Proxy({}, { get: (_, n) => n === 'environ_sizes_get' ? (a, b) => { const v = new DataView(gm().buffer); v.setUint32(a, 0, true); v.setUint32(b, 0, true); return 0; } : n === 'fd_prestat_get' ? () => 8 : () => 0 }) });
let failed = 0;
for (const f of fs.readdirSync(modelsDir).filter((x) => x.endsWith('.nam')).sort()) {
  const file = path.join(modelsDir, f), refFile = `/tmp/ref-${f}.f32`;
  try { execFileSync(refBin, [file, refFile], { stdio: 'pipe' }); } catch (e) { console.log(`SKIP ${f}: native core rejects it (${String(e.stderr).trim().split('\n').pop()})`); continue; }
  const ref = new Float32Array(fs.readFileSync(refFile).buffer.slice(0));
  let mem; const inst = new WebAssembly.Instance(mod, wasi(() => mem)); mem = inst.exports.memory; const x = inst.exports; x._initialize();
  const bytes = fs.readFileSync(file); const p = x.nam_alloc(bytes.length); new Uint8Array(mem.buffer).set(bytes, p);
  let ok = 0; try { ok = x.nam_load(p, bytes.length, 48000, 128); } catch { ok = 0; }
  if (!ok) { console.log(`FAIL ${f}: wasm could not load a model the native core accepts`); failed++; continue; }
  const ip = x.nam_in() >> 2, op = x.nam_out() >> 2;
  let md = 0, pk = 0;
  for (let b = 0; b < 400; b++) {
    const fin = new Float32Array(mem.buffer); for (let i = 0; i < 128; i++) { const t = b * 128 + i; fin[ip + i] = Math.fround(0.3 * Math.fround(Math.sin(Math.fround(t * 0.01) + Math.fround(t * t * 1e-7))) + 0.05 * Math.fround(Math.sin(Math.fround(t * 0.37)))); }
    x.nam_process(128); const fo = new Float32Array(mem.buffer);
    for (let i = 0; i < 128; i++) { md = Math.max(md, Math.abs(fo[op + i] - ref[b * 128 + i])); pk = Math.max(pk, Math.abs(ref[b * 128 + i])); }
  }
  const rel = md / (pk || 1), pass = rel < 5e-3;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${f.padEnd(34)} max |wasm-native| ${md.toExponential(2)}  (peak ${pk.toFixed(3)}, rel ${rel.toExponential(1)})`);
  if (!pass) failed++;
}
process.exit(failed ? 1 : 0);
