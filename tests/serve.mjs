// Minimal static server for the tests: / -> app/, /models/ -> NAM example models dir
import http from 'http'; import fs from 'fs'; import path from 'path';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.nam': 'application/json', '.json': 'application/json', '.png': 'image/png' };
export function serve(appDir, modelsDir, port = 0) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const [root, rel] = u.startsWith('/models/') ? [modelsDir, u.slice(8)] : [appDir, u === '/' ? 'index.html' : u.slice(1)];
    const f = path.resolve(root, rel);
    if (!f.startsWith(path.resolve(root)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}
