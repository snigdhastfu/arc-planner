// IndexedDB persistence ("arc" v1) with an in-memory fallback for private
// modes where IndexedDB is unavailable.

const DB_NAME = 'arc';
const DB_VERSION = 1;
export const SCHEMA_VERSION = 1;
const STORES = ['items', 'blocks', 'profile', 'routineLog', 'history', 'postcards', 'meta'];

let db = null;
let memory = null; // Map per store when IndexedDB is unavailable
export const persistent = () => !!db;

function migrate(d, oldVersion) {
  if (oldVersion < 1) {
    d.createObjectStore('items', { keyPath: 'id' });
    const blocks = d.createObjectStore('blocks', { keyPath: 'id' });
    blocks.createIndex('day', 'day');
    d.createObjectStore('profile', { keyPath: 'key' });
    d.createObjectStore('routineLog', { keyPath: ['day', 'itemId'] });
    d.createObjectStore('history', { autoIncrement: true });
    d.createObjectStore('postcards', { keyPath: 'day' });
    d.createObjectStore('meta', { keyPath: 'key' });
  }
  // future: if (oldVersion < 2) { ... }
}

export async function open() {
  if (db || memory) return;
  try {
    if (!('indexedDB' in globalThis)) throw new Error('no indexedDB');
    db = await new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('blocked'));
    });
    const v = await get('meta', 'schemaVersion');
    if (!v) await put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
  } catch (e) {
    console.warn('IndexedDB unavailable, running in memory:', e && e.message);
    db = null;
    memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  }
}

function keyOf(store, value, key) {
  if (key !== undefined) return key;
  if (store === 'routineLog') return `${value.day}|${value.itemId}`;
  if (store === 'postcards') return value.day;
  if (store === 'profile' || store === 'meta') return value.key;
  return value.id;
}
let autoKey = 1;
const memKey = (store, k) => (Array.isArray(k) ? k.join('|') : k);

function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function get(store, key) {
  if (memory) return clone(memory[store].get(memKey(store, key)));
  return tx(store, 'readonly', (s) => reqP(s.get(key)));
}
export async function all(store) {
  if (memory) return [...memory[store].values()].map(clone);
  return tx(store, 'readonly', (s) => reqP(s.getAll()));
}
export async function put(store, value, key) {
  if (memory) { memory[store].set(store === 'history' ? (key ?? autoKey++) : keyOf(store, value, key), clone(value)); return; }
  return tx(store, 'readwrite', (s) => reqP(key !== undefined ? s.put(value, key) : s.put(value)));
}
export async function putMany(store, values) {
  if (memory) { values.forEach((v) => memory[store].set(keyOf(store, v), clone(v))); return; }
  return tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); });
}
export async function del(store, key) {
  if (memory) { memory[store].delete(memKey(store, key)); return; }
  return tx(store, 'readwrite', (s) => reqP(s.delete(key)));
}
export async function delMany(store, keys) {
  if (memory) { keys.forEach((k) => memory[store].delete(memKey(store, k))); return; }
  return tx(store, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); });
}
export async function clear(store) {
  if (memory) { memory[store].clear(); return; }
  return tx(store, 'readwrite', (s) => reqP(s.clear()));
}
/** History entries with their keys, oldest first. */
export async function historyEntries() {
  if (memory) return [...memory.history.entries()].map(([key, value]) => ({ key, value: clone(value) }));
  return tx('history', 'readonly', (s) => new Promise((res, rej) => {
    const out = [];
    const c = s.openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ key: cur.key, value: cur.value }); cur.continue(); } else res(out); };
    c.onerror = () => rej(c.error);
  }));
}
export async function eraseAll() {
  for (const s of STORES) await clear(s);
  await put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
}
export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (_) { /* ignore */ }
  return false;
}
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
