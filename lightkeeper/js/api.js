/** Browser edition of the API client. Same `api.get/post/del(path, …)` surface as the desktop app, but
 *  every `/api/...` path is answered in the page: the Light List from static tables on this site, places from
 *  OpenStreetMap (Overpass + Nominatim), water from NOAA / USGS / Open-Meteo, weather from the NWS, trips and
 *  settings from localStorage. Desktop-only endpoints (tile cache, pre-cache, backup, open file) answer
 *  `{ok:false}` quietly. */

import * as aids from './web/aids.js?v=2.1.1-6';
import * as poi from './web/poi.js?v=2.1.1-6';
import * as water from './web/water.js?v=2.1.1-6';
import * as weather from './web/weather.js?v=2.1.1-6';
import * as discrep from './web/discrepancies.js?v=2.1.1-6';
import * as bnm from './web/bnm.js?v=2.1.1-6';
import { latLonArgs, parseBbox, validateCoords } from './web/util.js?v=2.1.1-6';

export const VERSION = '2.1.1';
const LS_SETTINGS = 'lk2.web.settings';
const LS_TRIPS = 'lk2.web.trips';
const DESKTOP_ONLY = { ok: false, error: 'Available in the desktop app', desktop_only: true };
const PLAN_MESSAGE = 'Trip planning runs in the desktop app — download it from the LightKeeper page';

const read = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const nowIso = () => new Date().toISOString().slice(0, 19);

function settingsGet() {
  return { speed_mph: 25, fuel_gph: 12, tank_gal: 100, units: 'mi', ...read(LS_SETTINGS, {}), has_mapbox_token: false, has_google_key: false, web: true };
}

/* ── Trips (saved plans) ── */
function tripsList() { return read(LS_TRIPS, []); }
function tripSummary(t) {
  const days = t.plan?.days || [];
  return { id: t.id, name: t.name, created_at: t.created_at, updated_at: t.updated_at, day_count: days.length, aid_count: days.reduce((n, d) => n + (d.aids || []).length, 0) };
}
function tripSave(body) {
  const trips = tripsList();
  const id = body.id || Math.max(0, ...trips.map((t) => t.id)) + 1;
  const existing = trips.find((t) => t.id === id);
  const rec = { id, name: body.name || 'Untitled trip', plan: body.plan || {}, created_at: existing?.created_at || nowIso(), updated_at: nowIso() };
  write(LS_TRIPS, [...trips.filter((t) => t.id !== id), rec]);
  return { ok: true, id };
}

/* ── Status ── */
async function status() {
  const [m, d] = await Promise.all([aids.manifest().catch(() => null), aids.districts().catch(() => [])]);
  return { version: VERSION, aids_total: m?.total ?? aids.loadedCount(), districts: d, online: navigator.onLine, built_at: m?.built_at || '', sync: { running: false, progress: 0, total: 0, message: '' } };
}

/* ── Router ── */
const INVALID = { ok: false, error: 'Invalid coordinates' };
const radius = (p) => (p?.radius_m != null ? Number(p.radius_m) : undefined);

async function route(method, path, params = {}, body = {}) {
  const p = path.replace(/\?.*$/, '').replace(/\/+$/, '');
  const seg = p.split('/').slice(2); // drop '', 'api'
  const head = seg[0];
  const sub = seg[1];
  const rest = seg.slice(2);
  const pt = latLonArgs(params);

  switch (head) {
    case 'version': return { version: VERSION };
    case 'status': return status();
    case 'settings':
      if (method === 'POST') { write(LS_SETTINGS, { ...read(LS_SETTINGS, {}), ...body }); return { ok: true }; }
      return settingsGet();
    case 'districts':
      if (sub && rest[0] === 'enabled') return { ok: true, id: Number(sub), enabled: Boolean(body.enabled) };
      return aids.districts();
    case 'aids':
      if (sub === 'changes') return { ok: true, run_at: '', summary: { added: 0, removed: 0, moved: 0, changed: 0 }, items: [] };
      if (sub) { const aid = await aids.getAid(sub); if (!aid) throw new Error(`Aid ${sub} not found`); return aid; }
      return aids.query(params);
    case 'sync':
      return sub === 'status' ? { running: false, progress: 0, total: 0, message: '', errors: [], done_districts: [] } : { started: false, stopped: false, ok: false, error: 'The Light List on this site is refreshed weekly by the data workflow' };
    case 'poi': {
      const items = async (fn) => { try { return { ok: true, items: await fn() }; } catch (err) { return { ok: false, error: err.message, items: [] }; } };
      if (sub === 'enrich') return items(() => poi.enrich((body.items || []).filter((it) => it && typeof it === 'object')));
      if (sub === 'search') return params.q && String(params.q).trim().length >= 2 ? items(() => poi.searchPlaces(params.q, pt?.[0], pt?.[1])) : { ok: false, error: 'Query too short', items: [] };
      if (!pt) return { ...INVALID, items: [] };
      if (sub === 'ramps') return items(() => poi.fetchRamps(pt[0], pt[1], radius(params)));
      if (sub === 'parks') return items(() => poi.fetchParks(pt[0], pt[1], radius(params)));
      if (sub === 'hotels') return items(() => poi.fetchHotels(pt[0], pt[1], radius(params), params.types ? String(params.types).split(',') : null));
      break;
    }
    case 'geocode': return poi.geocode(params.q);
    case 'reverse': return pt ? poi.reverseGeocode(pt[0], pt[1]) : INVALID;
    case 'water': {
      if (sub === 'stations') {
        const bbox = parseBbox(params.bbox);
        if (!bbox) return { ok: false, error: 'bbox must be south,west,north,east', items: [] };
        const types = params.types ? String(params.types).split(',').map((t) => t.trim()).filter(Boolean) : water.STATION_TYPES;
        const unknown = types.filter((t) => !water.STATION_TYPES.includes(t));
        if (unknown.length) return { ok: false, error: `Unknown station type(s): ${unknown.join(', ')}`, items: [] };
        return { ok: true, items: await water.stationsInBbox(bbox, types) };
      }
      if (sub === 'station') return water.stationDetail(decodeURIComponent(rest.join('/')), params.date);
      if (sub === 'temp') return pt ? water.waterTempNear(pt[0], pt[1]) : { ok: false, error: 'Invalid or missing lat/lon', all: [] };
      break;
    }
    case 'weather':
      if (sub === 'observation') return pt ? weather.nearestObservation(pt[0], pt[1]) : { ok: false, error: 'Invalid or missing lat/lon' };
      return pt ? weather.getForecast(pt[0], pt[1]) : { ok: false, error: 'Invalid or missing lat/lon', periods: [] };
    case 'trip':
      if (sub === 'plan') return { ok: false, error: PLAN_MESSAGE, desktop_only: true };
      break;
    case 'bnm': return bnm.list(params);
    case 'discrepancies': {
      if (!sub) return method === 'POST' ? discrep.save(body) : discrep.list(params);
      if (sub === 'export') return discrep.exportXlsx();
      if (sub === 'email') return discrep.email(body?.to || settingsGet().report_email || '');
      if (sub === 'import') return discrep.importXlsx(body?.data_b64 || '');
      if (method === 'DELETE') return discrep.remove(sub);
      throw new Error('Unknown discrepancy action');
    }
    case 'trips': {
      if (!sub) return method === 'POST' ? tripSave(body) : tripsList().map(tripSummary);
      const id = Number(sub);
      if (rest[0] === 'pdf') return { ...DESKTOP_ONLY, error: 'PDF export runs in the desktop app' };
      if (method === 'DELETE') { write(LS_TRIPS, tripsList().filter((t) => t.id !== id)); return { ok: true }; }
      const trip = tripsList().find((t) => t.id === id);
      if (!trip) throw new Error(`Trip ${id} not found`);
      return trip;
    }
    case 'route':
    case 'waterway':
    case 'tiles':
    case 'warm':
    case 'backup':
    case 'open':
      if (head === 'tiles' && sub === 'status') return { active: false, done: 0, total: 0, cache_mb: 0, ok: false, desktop_only: true };
      if (head === 'warm' && sub === 'status') return { running: false, ok: false, desktop_only: true };
      return DESKTOP_ONLY;
    default:
      break;
  }
  throw new Error(`Unknown endpoint ${method} ${path}`);
}

async function request(method, path, { params, body } = {}) {
  try {
    return await route(method, path, params || {}, body || {});
  } catch (err) {
    if (err?.message?.startsWith('Unknown endpoint') || err?.message?.includes('not found')) throw err;
    console.warn(`[lightkeeper] ${method} ${path} failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export const api = {
  get: (path, params, opts) => request('GET', path, { params, ...opts }),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  del: (path, opts) => request('DELETE', path, opts),
};

export { validateCoords };
