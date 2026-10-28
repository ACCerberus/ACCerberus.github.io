/** IndexedDB-backed cache with TTLs (falls back to memory when IndexedDB is unavailable).
 *
 *  cached(key, ttlMs, loader) → value   fresh copy, else loader(); a stale copy is served when loader fails.
 *  idbGet / idbSet                       raw access for the Light List tables.
 */

const DB_NAME = 'lightkeeper';
const STORE = 'cache';
const memory = new Map();
const OPEN_TIMEOUT_MS = 2000;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in globalThis)) { resolve(null); return; }
    // Another tab of an older build can hold the database open while a new build deletes it; the open request
    // then waits with no event. Never let that stall the app: fall back to memory after a short wait.
    const fallback = setTimeout(() => { console.warn('[lightkeeper] IndexedDB busy (another tab?) — using memory cache'); resolve(null); }, OPEN_TIMEOUT_MS);
    const done = (db) => { clearTimeout(fallback); resolve(db); };
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        // Let a newer build (or "Clear cached data") delete or upgrade the database without waiting on this tab.
        db.onversionchange = () => { db.close(); dbPromise = Promise.resolve(null); };
        done(db);
      };
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch { done(null); }
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) { reject(err); }
  });
}

/** {value, at} or undefined. */
export async function idbGet(key) {
  if (memory.has(key)) return memory.get(key);
  const db = await openDb();
  if (!db) return undefined;
  try { return await tx(db, 'readonly', (s) => s.get(key)); } catch { return undefined; }
}

export async function idbSet(key, value) {
  const entry = { value, at: Date.now() };
  memory.set(key, entry);
  const db = await openDb();
  if (!db) return;
  try { await tx(db, 'readwrite', (s) => s.put(entry, key)); } catch { /* quota or private mode */ }
}

export async function idbDelete(key) {
  memory.delete(key);
  const db = await openDb();
  if (!db) return;
  try { await tx(db, 'readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
}

const inflight = new Map();

/**
 * Cache-through. Returns {value, age, cached}. A copy younger than ttlMs is returned without
 * calling loader; otherwise loader runs, its result is stored, and if it throws a stale copy is
 * returned when one exists (offline fallback) — with nothing cached the error propagates.
 */
export async function cached(key, ttlMs, loader) {
  const hit = await idbGet(key);
  const age = hit ? Date.now() - hit.at : 0;
  if (hit && age < ttlMs) return { value: hit.value, age, cached: true };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await loader();
      if (value !== undefined && value !== null) await idbSet(key, value);
      return { value, age: 0, cached: false };
    } catch (err) {
      if (hit) return { value: hit.value, age, cached: true, stale: true };
      throw err;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
