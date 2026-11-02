/** "Make this district available offline" (website / phone): saves what a crew needs for one district while there is
 *  signal, so the app keeps working on the water. Also the offline badge.
 *
 *  Saved: the district's aids, Broadcast Notices, NOAA buoys, dam and station lists; 7 days of tide highs/lows for every
 *  tide station near the aids; and for every 0.5° area with aids, the 7-day forecast, the latest weather observation and
 *  water temperature. Cards fall back to these (with their age) when there's no signal. Map tiles are not downloaded in
 *  bulk (the public tile servers don't allow it); areas already viewed stay cached by the service worker. */

import { staticJson, loadDistrict, districts as districtList } from './aids.js?v=2.1.5';
import { idbGet, idbSet } from './store.js?v=2.1.5';
import { haversineMi, todayIso } from './util.js?v=2.1.5';
import { getForecast, nearestObservation } from './weather.js?v=2.1.5';
import { waterTempNear, prefetchTides, tideStations } from './water.js?v=2.1.5';
import { saveReading, savedAgo } from './offline-store.js?v=2.1.5';

const CELL_DEG = 0.5;
const MAX_CELLS = 60;
const TIDE_NEAR_MI = 25;
const MAX_TIDE_STATIONS = 250;
const recordKey = (id) => `offline:district:${id}`;

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
  for (const f of ['manifest.json', 'districts.json', 'stations-tide.json', 'stations-current.json', `bnm-D${id}.json`, 'ndbc-latest.json', 'cwms-dams.json']) {
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
    onProgress(`Saving weather and water temperature (${n + 1} of ${zones.length} areas)`, 0.55 + 0.45 * ((n + 1) / zones.length));
  });

  const record = { id, name, at: Date.now(), aids: aids.length, tideStations: stations.length, tideDays, areas: zones.length, readings, persisted: !!persisted };
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
  pill.textContent = saved ? `Offline · using ${saved.name} data saved ${savedAgo(saved.at)}` : 'Offline · showing what was loaded before';
  pill.hidden = false;
}
export function initOfflineBadge() {
  addEventListener('offline', showBadge);
  addEventListener('online', () => { if (pill) pill.hidden = true; });
  if (!navigator.onLine) showBadge();
}
