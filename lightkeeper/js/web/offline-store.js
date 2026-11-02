/** Readings saved for offline use: forecasts, observations and water temperatures around a district, each with the
 *  point it was taken for. When a live lookup fails, the nearest saved one (within a radius) is shown, with its time.
 *  Written by offline.js ("Make this district available offline"); read by weather.js and water.js. */

import { idbGet, idbSet } from './store.js?v=2.1.7';
import { haversineMi } from './util.js?v=2.1.7';

const INDEX_KEY = 'offline:index';
const MAX_AGE_MS = 7 * 864e5 + 6 * 3600e3;   // the saved week, plus a few hours' grace        // { fc: [{lat, lon}], obs: [...], temp: [...] }
const keyOf = (kind, lat, lon) => `offline:${kind}:${lat.toFixed(2)},${lon.toFixed(2)}`;

async function index() { return (await idbGet(INDEX_KEY))?.value || { fc: [], obs: [], temp: [] }; }

export async function saveReading(kind, lat, lon, value) {
  if (value == null) return;
  await idbSet(keyOf(kind, lat, lon), value);
  const idx = await index();
  const list = idx[kind] || (idx[kind] = []);
  if (!list.some((p) => Math.abs(p.lat - lat) < 0.005 && Math.abs(p.lon - lon) < 0.005)) list.push({ lat, lon });
  await idbSet(INDEX_KEY, idx);
}

/** The nearest saved reading of a kind within maxMi: {value, at, distance_mi}, or null. */
export async function nearestSaved(kind, lat, lon, maxMi = 40) {
  const idx = await index();
  let best = null;
  let bestMi = maxMi;
  for (const p of idx[kind] || []) {
    const mi = haversineMi(lat, lon, p.lat, p.lon);
    if (mi <= bestMi) { best = p; bestMi = mi; }
  }
  if (!best) return null;
  const hit = await idbGet(keyOf(kind, best.lat, best.lon));
  if (!hit || Date.now() - hit.at > MAX_AGE_MS) return null;     // past the 7-day offline window
  return { value: hit.value, at: hit.at, distance_mi: Math.round(bestMi * 10) / 10 };
}

export const savedAgo = (at) => {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
