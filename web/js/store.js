// IndexedDB persistence ("arc" v1) with an in-memory fallback for private
// modes where IndexedDB is unavailable.

const DB_NAME = 'arc';
const DB_VERSION = 1;
const IDB_TIMEOUT_MS = 8000;
export const SCHEMA_VERSION = 1;
const STORES = ['items', 'blocks', 'profile', 'routineLog', 'history', 'postcards', 'meta'];
const LOCAL_KEY = 'arc.local.v1';

let db = null;
let memory = null;
let backend = 'opening';
let idbError = null;
let persistState = 'not requested';
let persistRequested = false;
let fallbackPromise = null;
export const persistent = () => backend === 'indexedDB' && !!db;
export const storageStatus = () => ({ backend, idbError, persist: persistState });
function notifyStorage() {
  if (typeof globalThis.dispatchEvent === 'function' && typeof Event === 'function') globalThis.dispatchEvent(new Event('arc-storagechange'));
}

function errorInfo(e) {
  return { name: e && e.name || 'Error', message: e && e.message || String(e) };
}

function emptyMemory() {
  return Object.fromEntries(STORES.map((s) => [s, new Map()]));
}

const memKey = (_store, k) => (Array.isArray(k) ? k.join('|') : k);

function readLocal() {
  const raw = localStorage.getItem(LOCAL_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== 1 || !parsed.stores) throw new Error('Local storage data has an unsupported format');
  const data = emptyMemory();
  for (const store of STORES) {
    for (const entry of parsed.stores[store] || []) {
      if (Array.isArray(entry) && entry.length === 2) data[store].set(memKey(store, entry[0]), entry[1]);
    }
  }
  return data;
}

function saveLocal() {
  const stores = Object.fromEntries(STORES.map((store) => [store, [...memory[store].entries()]]));
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ version: 1, stores }));
}

function requestPersistOnce() {
  if (persistRequested) return;
  persistRequested = true;
  let request;
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
      persistState = 'unavailable';
      notifyStorage();
      return;
    }
    request = navigator.storage.persist();
  } catch (e) {
    const detail = errorInfo(e);
    persistState = `failed: ${detail.name}: ${detail.message}`;
    notifyStorage();
    return;
  }
  if (!request) {
    persistState = 'unavailable';
    notifyStorage();
    return;
  }
  persistState = 'requesting';
  Promise.resolve(request).then((granted) => {
    persistState = granted ? 'granted' : 'not granted';
    notifyStorage();
  }, (e) => {
    const detail = errorInfo(e);
    persistState = `failed: ${detail.name}: ${detail.message}`;
    notifyStorage();
  });
}

function snapshotDatabase(source) {
  if (!source) return Promise.resolve(null);
  return Promise.all(STORES.map((name) => new Promise((resolve, reject) => {
    let rows = [];
    let tx;
    try { tx = source.transaction(name, 'readonly'); } catch (e) { reject(e); return; }
    const cursor = tx.objectStore(name).openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (current) { rows.push([current.key, current.value]); current.continue(); }
    };
    tx.oncomplete = () => resolve([name, rows]);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }))).then((rows) => Object.fromEntries(rows));
}

async function fallbackToLocal(error, source = db) {
  if (fallbackPromise) return fallbackPromise;
  fallbackPromise = (async () => {
    idbError = errorInfo(error);
    backend = 'switching';
    let data = null;
    if (source) {
      try { data = await snapshotDatabase(source); } catch (snapshotError) {
        console.warn('Could not copy IndexedDB into fallback storage:', snapshotError);
      }
    }
    try {
      if (data && STORES.some((store) => (data[store] || []).length)) {
        memory = emptyMemory();
        for (const store of STORES) {
          for (const [key, value] of data[store] || []) memory[store].set(memKey(store, key), value);
        }
      } else {
        try { memory = readLocal() || emptyMemory(); }
        catch (e) { console.warn('Could not read localStorage fallback:', e); memory = emptyMemory(); }
      }
      try {
        const stores = Object.fromEntries(STORES.map((s) => [s, [...memory[s].entries()]]));
        localStorage.setItem(LOCAL_KEY, JSON.stringify({ version: 1, stores }));
        backend = 'localStorage';
      } catch (e) {
        console.warn('localStorage unavailable, using memory only:', e);
        backend = 'memory';
      }
    } finally {
      if (source) source.close();
      if (db === source) db = null;
      if (backend === 'switching') backend = 'memory';
      fallbackPromise = null;
      notifyStorage();
    }
  })();
  return fallbackPromise;
}

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
    const opened = await new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      let blocked = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        const e = new Error(blocked ? 'IndexedDB open remained blocked' : 'IndexedDB open timed out');
        e.name = blocked ? 'BlockedError' : 'TimeoutError';
        finish(rej, e);
      }, IDB_TIMEOUT_MS);
      req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion);
      req.onsuccess = () => {
        if (settled) req.result.close();
        else finish(res, req.result);
      };
      req.onerror = () => finish(rej, req.error);
      req.onblocked = () => { blocked = true; };
    });
    db = opened;
    backend = 'indexedDB';
    opened.onversionchange = (event) => {
      const e = new Error(`IndexedDB version changed from ${event.oldVersion} to ${event.newVersion}; switching storage.`);
      e.name = 'VersionError';
      fallbackToLocal(e, opened);
    };
    const v = await get('meta', 'schemaVersion');
    if (!v) await put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
  } catch (e) {
    console.warn('IndexedDB unavailable; switching to fallback storage:', e);
    await fallbackToLocal(e);
  }
}

export async function fallbackToMemory(error) {
  await fallbackToLocal(error || new Error('IndexedDB operation failed'));
}

function keyOf(store, value, key) {
  if (key !== undefined) return key;
  if (store === 'routineLog') return `${value.day}|${value.itemId}`;
  if (store === 'postcards') return value.day;
  if (store === 'profile' || store === 'meta') return value.key;
  return value.id;
}
let autoKey = 1;

function tx(source, store, mode, fn) {
  return new Promise((res, rej) => {
    let t;
    try { t = source.transaction(store, mode); } catch (e) { rej(e); return; }
    const s = t.objectStore(store);
    let out;
    let operationDone = false, transactionDone = false, settled = false;
    const finish = (done, value) => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
    const complete = () => { if (operationDone && transactionDone) finish(res, out); };
    const timer = setTimeout(() => {
      const e = new Error('IndexedDB transaction timed out');
      e.name = 'TimeoutError';
      finish(rej, e);
      try { t.abort(); } catch (_) {}
    }, IDB_TIMEOUT_MS);
    let operation;
    try { operation = fn(s); } catch (e) { finish(rej, e); return; }
    Promise.resolve(operation).then((v) => {
      out = v;
      operationDone = true;
      complete();
    }, (e) => {
      finish(rej, e);
      try { t.abort(); } catch (_) {}
    });
    t.oncomplete = () => { transactionDone = true; complete(); };
    t.onerror = () => finish(rej, t.error);
    t.onabort = () => finish(rej, t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function run(store, mode, operation, inMemory, write = false) {
  if (fallbackPromise) await fallbackPromise;
  if (backend === 'indexedDB' && db) {
    try {
      const result = await tx(db, store, mode, operation);
      if (write) requestPersistOnce();
      return result;
    } catch (e) {
      console.warn('IndexedDB transaction failed; switching to fallback storage:', e);
      await fallbackToLocal(e);
    }
  }
  if (!memory) memory = emptyMemory();
  const result = inMemory();
  if (write) {
    if (backend === 'localStorage') {
      try { saveLocal(); } catch (e) { console.warn('Could not persist localStorage fallback; using memory only:', e); backend = 'memory'; }
    }
    requestPersistOnce();
  }
  return result;
}

export async function get(store, key) {
  return run(store, 'readonly', (s) => reqP(s.get(key)), () => clone(memory[store].get(memKey(store, key))));
}
export async function all(store) {
  return run(store, 'readonly', (s) => reqP(s.getAll()), () => [...memory[store].values()].map(clone));
}
export async function put(store, value, key) {
  return run(store, 'readwrite', (s) => reqP(key !== undefined ? s.put(value, key) : s.put(value)), () => {
    const k = store === 'history' ? (key !== undefined ? key : autoKey++) : keyOf(store, value, key);
    memory[store].set(memKey(store, k), clone(value));
  }, true);
}
export async function putMany(store, values) {
  return run(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }, () => {
    values.forEach((v) => {
      const key = keyOf(store, v);
      memory[store].set(memKey(store, key), clone(v));
    });
  }, true);
}
export async function del(store, key) {
  return run(store, 'readwrite', (s) => reqP(s.delete(key)), () => memory[store].delete(memKey(store, key)), true);
}
export async function delMany(store, keys) {
  return run(store, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); }, () => keys.forEach((k) => memory[store].delete(memKey(store, k))), true);
}
export async function clear(store) {
  return run(store, 'readwrite', (s) => reqP(s.clear()), () => memory[store].clear(), true);
}
/** History entries with their keys, oldest first. */
export async function historyEntries() {
  return run('history', 'readonly', (s) => new Promise((res, rej) => {
    const out = [];
    const c = s.openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ key: cur.key, value: cur.value }); cur.continue(); } else res(out); };
    c.onerror = () => rej(c.error);
  }), () => [...memory.history.entries()].map(([key, value]) => ({ key, value: clone(value) })));
}
export async function eraseAll() {
  for (const s of STORES) await clear(s);
  await put('meta', { key: 'schemaVersion', value: SCHEMA_VERSION });
}
export async function requestPersist() {
  requestPersistOnce();
  return persistState === 'granted';
}
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
