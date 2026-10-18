// Model / IR library in IndexedDB, small settings in localStorage (always guarded).

const DB = 'profondo', STORE = 'library';
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(STORE, mode); const s = t.objectStore(STORE); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };

export async function hashBytes(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const Library = {
  async put(item) { try { await tx('readwrite', (s) => s.put(item)); } catch (e) { console.warn('library put failed', e); } },
  async get(id) { try { return await tx('readonly', (s) => s.get(id)); } catch { return null; } },
  async del(id) { try { await tx('readwrite', (s) => s.delete(id)); } catch {} },
  async list() {
    try {
      const d = await db();
      return await new Promise((res) => { const out = []; const c = d.transaction(STORE).objectStore(STORE).openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { const { bytes, ...meta } = cur.value; out.push({ ...meta, size: bytes?.byteLength || 0 }); cur.continue(); } else res(out); };
        c.onerror = () => res(out); });
    } catch { return []; }
  },
};

export const LS = {
  get(k, def) { try { const v = localStorage.getItem('profondo.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('profondo.' + k, JSON.stringify(v)); } catch {} },
};
