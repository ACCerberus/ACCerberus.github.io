/** Light List in the browser: static per-district tables built by tools/build_aids.py, loaded lazily,
 *  kept in memory and mirrored in IndexedDB so the app keeps working offline. */

import { idbGet, idbSet } from './store.js?v=2.1.2';
import { parseBbox } from './util.js?v=2.1.2';

const DATA_URL = new URL('../../data/', import.meta.url);
const SLIM = ['objectid', 'lightlistnumber', 'aidname', 'latitude', 'longitude', 'aid_type', 'characteristics', 'waterway', 'district_id'];
const AID_TYPES = new Set(['light', 'buoy', 'daybeacon', 'bridge', 'other']);

const state = { manifest: null, districts: null, tables: new Map(), loading: new Map(), byId: new Map() };

async function fetchData(name, fresh = false) {
  // fresh: straight from the server, past the service worker's saved copy (the BNM Refresh button)
  const url = new URL(name, DATA_URL);
  if (fresh) url.searchParams.set('fresh', Date.now());
  const resp = await fetch(url, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`${name}: HTTP ${resp.status}`);
  return resp.json();
}

/** Network first (so a weekly data update is picked up), IndexedDB copy when offline. */
export async function staticJson(name, ttlMs = 0, { fresh = false } = {}) {
  const key = `static:${name}`;
  const hit = await idbGet(key);
  if (!fresh && hit && ttlMs && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fetchData(name, fresh);
    await idbSet(key, value);
    return value;
  } catch (err) {
    if (hit) return hit.value;
    throw err;
  }
}

// Both are memoised as promises so concurrent callers at boot share one request.
export function manifest() {
  if (!state.manifest) state.manifest = staticJson('manifest.json', 10 * 60 * 1000).catch((err) => { state.manifest = null; throw err; });
  return state.manifest;
}

export function districts() {
  if (!state.districts) state.districts = staticJson('districts.json', 10 * 60 * 1000).catch((err) => { state.districts = null; throw err; });
  return state.districts;
}

function expand(table) {
  const f = table.fields;
  return table.rows.map((row) => {
    const o = {}; f.forEach((k, i) => { o[k] = row[i]; });
    // Some published numbers carry float noise ("13672.300000000001"); show them as "13672.3".
    if (/^\d+\.\d{6,}$/.test(o.lightlistnumber || '')) o.lightlistnumber = String(Number(Number(o.lightlistnumber).toFixed(4)));
    return o;
  });
}

function emit(detail) { globalThis.dispatchEvent(new CustomEvent('lk:progress', { detail })); }

/** Aids of one district (full records), downloading the table once per build. */
export async function loadDistrict(id) {
  if (state.tables.has(id)) return state.tables.get(id);
  if (state.loading.has(id)) return state.loading.get(id);
  const p = (async () => {
    const m = await manifest().catch(() => null);
    const key = `aids:D${id}`;
    const hit = await idbGet(key);
    let table = hit && (!m || hit.value?.built_at === m.built_at) ? hit.value.table : null;
    if (!table) {
      try {
        table = await fetchData(`aids-D${id}.json`);
        await idbSet(key, { built_at: m?.built_at || '', table });
      } catch (err) {
        if (hit) table = hit.value.table; else throw err;
      }
    }
    const aids = expand(table);
    for (const a of aids) state.byId.set(a.objectid, a);
    state.tables.set(id, aids);
    state.loading.delete(id);
    return aids;
  })();
  state.loading.set(id, p);
  return p;
}

async function loadMany(ids) {
  const missing = ids.filter((id) => !state.tables.has(id));
  if (missing.length) {
    let done = 0;
    emit({ text: `Loading Light List — ${missing.length} district file${missing.length > 1 ? 's' : ''}…`, fraction: 0 });
    await Promise.all(missing.map((id) => loadDistrict(id).then(() => {
      done += 1;
      emit({ text: `Loading Light List — D${id} ready (${done}/${missing.length})`, fraction: done / missing.length });
    }).catch((err) => { console.warn(`[lightkeeper] D${id} unavailable:`, err.message); done += 1; })));
    emit({ done: true });
  }
  return ids.flatMap((id) => state.tables.get(id) || []);
}

const slim = (a) => { const o = {}; for (const k of SLIM) o[k] = a[k]; return o; };
const norm = (s) => String(s || '').toLowerCase();
// Search is word-based: every word typed must appear in the name or Light List number (or waterway), in any order,
// so "goose 4" or "lit goo res 12" finds "Little Goose Reservoir Light 12". Short forms are expanded ("lt" -> "light").
const SEARCH_ALIASES = { lt: 'light', db: 'daybeacon', dbn: 'daybeacon', lb: 'lighted buoy', bn: 'beacon' };
const searchTokens = (q) => norm(q).replace(/\./g, '').split(/\s+/).filter(Boolean).flatMap((w) => (SEARCH_ALIASES[w] || w).split(' ')).slice(0, 8);
const words = (v) => norm(v).replace(/\./g, '').split(/[\s\-()\/]+/).filter(Boolean);
// Each word must START a word of the name (or waterway), or start the Light List number: "goo" finds "Goose".
const tokenIn = (a, t, withWaterway) => words(a.aidname).some((w) => w.startsWith(t)) || norm(a.lightlistnumber).startsWith(t)
  || (withWaterway && words(a.waterway).some((w) => w.startsWith(t)));
const nameLlMatch = (a, q) => { const ts = searchTokens(q); return ts.length > 0 && ts.every((t) => tokenIn(a, t, false)); };
const anyMatch = (a, q) => { const ts = searchTokens(q); return ts.length > 0 && ts.every((t) => tokenIn(a, t, true)); };

/** GET /api/aids?bbox&districts&type&q&limit&offset → {aids:[slim], total}. */
export async function query(params = {}) {
  const all = await districts();
  const wanted = String(params.districts || '').split(',').map(Number).filter((n) => all.some((d) => d.id === n));
  const ids = wanted.length ? wanted : all.map((d) => d.id);
  let rows = await loadMany(ids);
  const bbox = params.bbox ? parseBbox(params.bbox) : null;
  if (bbox) { const [s, w, n, e] = bbox; rows = rows.filter((a) => a.latitude >= s && a.latitude <= n && a.longitude >= w && a.longitude <= e); }
  const type = norm(params.type);
  if (type && AID_TYPES.has(type)) rows = rows.filter((a) => a.aid_type === type);
  const q = norm(params.q).slice(0, 200);
  if (q) rows = rows.filter((a) => anyMatch(a, q));
  const total = rows.length;
  rows = rows.slice().sort((a, b) => (q ? Number(!nameLlMatch(a, q)) - Number(!nameLlMatch(b, q)) : 0) || a.aidname.localeCompare(b.aidname));
  const offset = Math.max(0, Number(params.offset) || 0);
  const limit = Math.min(100000, Math.max(1, Number(params.limit) || 3000));
  return { aids: rows.slice(offset, offset + limit).map(slim), total };
}

/** GET /api/aids/<objectid> → full record or null. */
export async function getAid(objectid) {
  const id = Number(objectid);
  if (state.byId.has(id)) return state.byId.get(id);
  const all = await districts();
  await loadMany(all.map((d) => d.id));
  return state.byId.get(id) || null;
}

export function loadedCount() { let n = 0; for (const t of state.tables.values()) n += t.length; return n; }
