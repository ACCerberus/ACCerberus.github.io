/** First launch: guess the user's district from their internet address (rough location, city level), so the
 *  map and lists open on home waters instead of the whole country. Only runs while no district was ever picked. */

const LOOKUPS = [
  ['https://get.geojs.io/v1/ip/geo.json', (j) => [Number(j.latitude), Number(j.longitude)]],
  ['https://ipwho.is/', (j) => [Number(j.latitude), Number(j.longitude)]],
];

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally { clearTimeout(timer); }
}

/** Rough [lat, lon] for this internet connection, or null. */
export async function ipLocation(ms = 4000) {
  for (const [url, pick] of LOOKUPS) {
    try {
      const [lat, lon] = pick(await getJson(url, ms));
      if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) return [lat, lon];
    } catch { /* try the next service */ }
  }
  return null;
}

/** The district whose area holds the point, else the nearest one (inland users get the closest coast). */
export function districtFor(districts, lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const d of districts) {
    for (const [w, s, e, n] of d.bounds || []) {
      const dx = lon < w ? w - lon : lon > e ? lon - e : 0;
      const dy = lat < s ? s - lat : lat > n ? lat - n : 0;
      const dist = Math.hypot(dx * Math.cos((lat * Math.PI) / 180), dy);
      if (dist < bestD) { bestD = dist; best = d; }
    }
  }
  return best;
}
