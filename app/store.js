// Model / IR library in IndexedDB, small settings in localStorage (always guarded).

const DB = 'profondo', STORE = 'library', META = 'meta';
// v2: a separate 'meta' store (no bytes) so listing a large library stays fast
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = (e) => {
      const d = r.result, t = r.transaction;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(META)) {
        const meta = d.createObjectStore(META, { keyPath: 'id' });
        if (e.oldVersion >= 1) { // migrate v1 entries
          const c = t.objectStore(STORE).openCursor();
          c.onsuccess = () => { const cur = c.result; if (!cur) return; const { bytes, ...m } = cur.value; meta.put({ ...m, size: bytes?.byteLength || 0 }); cur.continue(); };
        }
      }
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (stores, mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(stores, mode); const r = fn(t); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };

export async function hashBytes(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const Library = {
  async put(item) {
    const { bytes, ...m } = item;
    try { await tx([STORE, META], 'readwrite', (t) => { t.objectStore(STORE).put(item); t.objectStore(META).put({ ...m, size: bytes?.byteLength || 0 }); }); return true; }
    catch (e) { console.warn('library put failed', e); return false; }
  },
  async get(id) { try { return await tx([STORE], 'readonly', (t) => t.objectStore(STORE).get(id)); } catch { return null; } },
  async has(id) { try { return !!(await tx([META], 'readonly', (t) => t.objectStore(META).getKey(id))); } catch { return false; } },
  async del(id) { try { await tx([STORE, META], 'readwrite', (t) => { t.objectStore(STORE).delete(id); t.objectStore(META).delete(id); }); } catch {} },
  // change catalogue fields (e.g. the NAM category) without touching the file bytes
  async patch(id, fields) { try { await tx([META], 'readwrite', (t) => { const st = t.objectStore(META); const r = st.get(id); r.onsuccess = () => { if (r.result) st.put({ ...r.result, ...fields }); }; }); } catch {} },
  async list() { try { return (await tx([META], 'readonly', (t) => t.objectStore(META).getAll())) || []; } catch { return []; } },
};

export const LS = {
  get(k, def) { try { const v = localStorage.getItem('profondo.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('profondo.' + k, JSON.stringify(v)); } catch {} },
};
