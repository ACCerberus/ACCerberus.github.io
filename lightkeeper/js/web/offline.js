/** "Make this district available offline" (website / phone): saves what a crew needs for one district while there is
 *  signal, so the app keeps working on the water. Also the offline badge.
 *
 *  Saved: the district's aids, Broadcast Notices, NOAA buoys, dam and station lists; 7 days of tide highs/lows for every
 *  tide station near the aids; and for every 0.5° area with aids, the 7-day forecast, the latest weather observation and
 *  water temperature. Cards fall back to these (with their age) when there's no signal. Map tiles are not downloaded in
 *  bulk (the public tile servers don't allow it); areas already viewed stay cached by the service worker. */

import { staticJson, loadDistrict, districts as districtList } from './aids.js?v=2.1.8-6';
import { idbGet, idbSet } from './store.js?v=2.1.8-6';
import { haversineMi, todayIso } from './util.js?v=2.1.8-6';
import { getForecast, nearestObservation } from './weather.js?v=2.1.8-6';
import { waterTempNear, prefetchTides, tideStations } from './water.js?v=2.1.8-6';
import { saveReading, savedAgo } from './offline-store.js?v=2.1.8-6';
import { chartTileUrls, setCharts, chartsOn } from '../map.js?v=2.1.8-6';
import { toast } from '../ui.js?v=2.1.8-6';

const CELL_DEG = 0.5;
const MAX_CELLS = 60;
const TIDE_NEAR_MI = 25;
const MAX_TIDE_STATIONS = 250;
const recordKey = (id) => `offline:district:${id}`;
export const SAVE_DAYS = 7;                     // saved data covers the next week
const CHART_CACHE = 'lk-keep-charts';           // the service worker serves chart tiles from here
const MAX_CHART_TILES = 6000;                   // ~3-30 KB each
const day = 864e5;
export const untilText = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/** Chart tiles around the aids: whole areas at zoom 8-10, around each aid at 11-12, the aid's own tile at 13-14. */
function chartTiles(aids) {
  const tileOf = (lat, lon, z) => {
    const n = 2 ** z; const r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n), z };
  };
  const seen = new Map();
  const add = (t) => { const k = `${t.z}/${t.x}/${t.y}`; if (!seen.has(k)) seen.set(k, t); };
  for (const z of [8, 9, 10, 11, 12, 13, 14]) {
    const ring = z <= 10 ? 1 : z <= 12 ? 1 : 0;
    for (const a of aids) {
      const t = tileOf(a.latitude, a.longitude, z);
      for (let dx = -ring; dx <= ring; dx += 1) for (let dy = -ring; dy <= ring; dy += 1) add({ x: t.x + dx, y: t.y + dy, z });
    }
    if (seen.size > MAX_CHART_TILES) break;
  }
  return Array.from(seen.values()).slice(0, MAX_CHART_TILES);
}

async function saveCharts(aids, onProgress) {
  if (!('caches' in globalThis)) return 0;
  const cache = await caches.open(CHART_CACHE);
  const urls = chartTileUrls(chartTiles(aids));
  let saved = 0;
  await pool(urls, 6, async (u, n) => {
    if (!(await cache.match(u))) {
      const resp = await fetch(u, { mode: 'no-cors' });      // NOAA sends no CORS headers: an opaque copy is fine for the map
      if (resp.type === 'opaque' || resp.ok) await cache.put(u, resp);
    }
    saved += 1;
    if (n % 25 === 0) onProgress(`Saving NOAA charts (${n + 1} of ${urls.length} tiles)`, 0.75 + 0.25 * ((n + 1) / urls.length));
  });
  return saved;
}

/** Run jobs a few at a time. */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i; i += 1; try { await fn(items[n], n); } catch { /* one failure doesn't stop the rest */ } }
  });
  await Promise.all(workers);
}

/** Areas (cell centres of the aids) to save readings for. */
function areas(aids) {
  for (let deg = CELL_DEG; ; deg *= 2) {
    const cells = new Map();
    for (const a of aids) {
      const k = `${Math.floor(a.latitude / deg)},${Math.floor(a.longitude / deg)}`;
      const c = cells.get(k) || { lat: 0, lon: 0, n: 0 };
      c.lat += a.latitude; c.lon += a.longitude; c.n += 1;
      cells.set(k, c);
    }
    if (cells.size <= MAX_CELLS || deg >= 4) return Array.from(cells.values(), (c) => ({ lat: c.lat / c.n, lon: c.lon / c.n }));
  }
}

export async function districtStatus(id) { return (await idbGet(recordKey(id)))?.value || null; }

export async function storageInfo() {
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  return { persisted: !!persisted, usedMb: est ? Math.round(est.usage / 1048576) : null, quotaMb: est ? Math.round(est.quota / 1048576) : null };
}

/** Save district `id` for offline use. onProgress(text, fraction). Returns the saved record. */
export async function saveDistrict(id, onProgress = () => {}) {
  if (!navigator.onLine) throw new Error('No connection right now - connect first, then save');
  const persisted = await navigator.storage?.persist?.().catch(() => false);
  onProgress('Saving the district data', 0.02);
  const name = (await districtList().catch(() => []))?.find?.((d) => d.id === id)?.name || `D${id}`;
  const aids = await loadDistrict(id);
  const man = await staticJson('manifest.json', 0, { fresh: true }).catch(() => null);
  const placeFiles = [man?.places?.[id]?.file, man?.dams?.[id]?.file].filter(Boolean);   // ramps, hotels, parks, dams
  for (const f of ['districts.json', 'stations-tide.json', 'stations-current.json', `bnm-D${id}.json`, 'ndbc-latest.json', 'cwms-dams.json', ...placeFiles]) {
    await staticJson(f, 0, { fresh: true }).catch(() => null);
  }
  const zones = areas(aids);

  // Tides: 7 days for stations near the aids (one request per station)
  onProgress('Saving tide predictions', 0.1);
  const stations = (await tideStations().catch(() => [])).filter((s) => zones.some((z) => haversineMi(z.lat, z.lon, s.lat, s.lon) <= TIDE_NEAR_MI)).slice(0, MAX_TIDE_STATIONS);
  let tideDays = 0;
  const today = todayIso();
  await pool(stations, 4, async (s, n) => {
    tideDays += await prefetchTides(s, today, 7);
    onProgress(`Saving tide predictions (${n + 1} of ${stations.length} stations)`, 0.1 + 0.45 * ((n + 1) / Math.max(1, stations.length)));
  });

  // Forecast, observation and water temperature per area
  let readings = 0;
  await pool(zones, 3, async (z, n) => {
    const [fc, obs, temp] = await Promise.all([
      getForecast(z.lat, z.lon).catch(() => null), nearestObservation(z.lat, z.lon).catch(() => null), waterTempNear(z.lat, z.lon).catch(() => null)]);
    if (fc?.ok && !fc.offline_saved) { await saveReading('fc', z.lat, z.lon, fc); readings += 1; }
    if (obs?.ok && !obs.offline_saved) { await saveReading('obs', z.lat, z.lon, obs); readings += 1; }
    let water = temp;
    // The river-gauge lookup can run past its time limit on a first visit and settle for a far reading; it keeps
    // going in the background, so asking again a moment later usually finds the near gauge.
    if (!water?.primary || water.primary.distance_mi > 50) {
      await new Promise((r) => setTimeout(r, 4000));
      const again = await waterTempNear(z.lat, z.lon).catch(() => null);
      if (again?.primary && (!water?.primary || again.primary.distance_mi < water.primary.distance_mi)) water = again;
    }
    if (water?.primary && !water.offline_saved) { await saveReading('temp', z.lat, z.lon, water); readings += 1; }
    onProgress(`Saving weather and water temperature (${n + 1} of ${zones.length} areas)`, 0.55 + 0.2 * ((n + 1) / zones.length));
  });

  const chartTilesSaved = await saveCharts(aids, onProgress).catch(() => 0);
  const at = Date.now();
  const record = { id, name, at, until: at + SAVE_DAYS * day, aids: aids.length, tideStations: stations.length, tideDays, areas: zones.length, readings, chartTiles: chartTilesSaved, persisted: !!persisted };
  await idbSet(recordKey(id), record);
  onProgress('Saved', 1);
  return record;
}

/* ── Offline badge ── */
let pill = null;
async function newestSave() {
  let newest = null;
  for (const d of await districtList().catch(() => []) || []) {
    const r = await districtStatus(d.id);
    if (r && (!newest || r.at > newest.at)) newest = r;
  }
  return newest;
}
async function showBadge() {
  if (!pill) { pill = document.createElement('div'); pill.id = 'offline-pill'; pill.setAttribute('role', 'status'); document.body.append(pill); }
  const saved = await newestSave();
  const until = saved && (saved.until || saved.at + SAVE_DAYS * day);
  pill.textContent = !saved ? 'Offline · showing what was loaded before'
    : Date.now() > until ? `Offline · ${saved.name} data ran out ${untilText(until)}`
      : `Offline · ${saved.name} data saved ${savedAgo(saved.at)}, good until ${untilText(until)}`;
  pill.classList.toggle('expired', !!saved && Date.now() > until);
  pill.hidden = false;
  if (saved?.chartTiles && !chartsOn()) { setCharts(true); toast('Showing the saved NOAA charts', 'info', 4000); }
}

/** On opening the app: say when saved offline data is about to run out, or has. */
async function remind() {
  for (const d of await districtList().catch(() => []) || []) {
    const r = await districtStatus(d.id);
    if (!r) continue;
    const until = r.until || r.at + SAVE_DAYS * day;
    const left = until - Date.now();
    if (left < 0) toast(`Offline data for D${r.id} ${r.name} ran out on ${untilText(until)}. Save it again (Settings > Offline) before you lose signal.`, 'warn', 9000);
    else if (left < day) toast(`Offline data for D${r.id} ${r.name} runs out ${untilText(until)}. Save it again while you have signal.`, 'info', 8000);
  }
}

export function initOfflineBadge() {
  addEventListener('offline', showBadge);
  addEventListener('online', () => { if (pill) pill.hidden = true; });
  if (!navigator.onLine) showBadge();
  setTimeout(remind, 4000);
}
