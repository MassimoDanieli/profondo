// Profondo — model loader (Web Worker, off the audio thread).
// Parses, builds and prewarms (core Reset) a NAM model in its own WebAssembly instance, then sends a
// snapshot of that instance's memory. The AudioWorklet adopts the snapshot with a single memory
// copy, so the audio thread never parses JSON, allocates the network or runs the prewarm.

let module = null;

function wasi(getMem) {
  return { wasi_snapshot_preview1: new Proxy({}, { get: (_, name) => {
    if (name === 'proc_exit') return (c) => { throw new Error('proc_exit ' + c); };
    if (name === 'environ_sizes_get') return (a, b) => { const v = new DataView(getMem().buffer); v.setUint32(a, 0, true); v.setUint32(b, 0, true); return 0; };
    if (name === 'environ_get') return () => 0;
    if (name === 'fd_prestat_get') return () => 8;
    if (name === 'fd_write') return (fd, iov, n, out) => { const v = new DataView(getMem().buffer); let t = 0; for (let i = 0; i < n; i++) t += v.getUint32(iov + i * 8 + 4, true); v.setUint32(out, t, true); return 0; };
    return () => 52;
  } }) };
}
const cstr = (mem, p) => { const u = new Uint8Array(mem.buffer); let s = ''; while (u[p] && s.length < 500) s += String.fromCharCode(u[p++]); return s; };

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') { module = await WebAssembly.compile(m.bytes); self.postMessage({ type: 'ready' }); return; }
  if (m.type !== 'load') return;
  try {
    let mem;
    const inst = new WebAssembly.Instance(module, wasi(() => mem));
    mem = inst.exports.memory; const x = inst.exports;
    x._initialize();
    const bytes = new Uint8Array(m.bytes);
    const p = x.nam_alloc(bytes.length);
    new Uint8Array(mem.buffer).set(bytes, p);
    let ok = 0;
    try { ok = x.nam_load(p, bytes.length, m.sampleRate, 128); }
    catch (err) { throw new Error(cstr(mem, x.nam_error()) || String(err)); }
    if (!ok) throw new Error(cstr(mem, x.nam_error()) || 'load failed');
    x.nam_free(p);
    // nam_load runs the core's own prewarm (Reset), here in the worker
    const pw = x.nam_prewarm_samples();
    const info = { expectedRate: x.nam_expected_rate(), loudness: x.nam_loudness(), inputLevel: x.nam_input_level(), outputLevel: x.nam_output_level(), prewarm: pw };
    const snapshot = mem.buffer.slice(0);
    self.postMessage({ type: 'built', req: m.req, info, snapshot }, [snapshot]);
  } catch (err) {
    self.postMessage({ type: 'error', req: m.req, message: String(err.message || err) });
  }
};
