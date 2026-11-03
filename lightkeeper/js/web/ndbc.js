/** NOAA buoy / coastal station readings (lightkeeper/data/ndbc-latest.json, published hourly by tools/build_ndbc.py).
 *  Fills gaps on aid cards: water temperature on the Great Lakes and open coast, air temperature and wind where the
 *  National Weather Service has no recent station report. */

import { staticJson } from './aids.js?v=2.1.8-6';
import { haversineMi, compassPoint, inRange } from './util.js?v=2.1.8-6';

const TTL = 15 * 60 * 1000;
const MAX_AGE_MS = 6 * 3600 * 1000;
const cToFRaw = (c) => (c * 9) / 5 + 32;
// Sanity limit (util.js READING_LIMITS) per field: an impossible reading lets the next-nearest station answer.
const LIMIT = { water_c: ['water_temp_f', cToFRaw], air_c: ['air_temp_f', cToFRaw], wind_kt: ['wind_kt', (v) => v], gust_kt: ['wind_kt', (v) => v] };

export async function nearest(lat, lon, field, maxMi) {
  const data = await staticJson('ndbc-latest.json', TTL).catch(() => null);
  let best = null;
  let bestMi = maxMi;
  for (const s of data?.items || []) {
    if (s[field] == null || Date.now() - Date.parse(s.time) > MAX_AGE_MS) continue;
    if (LIMIT[field] && !inRange(LIMIT[field][0], LIMIT[field][1](s[field]))) continue;
    const mi = haversineMi(lat, lon, s.lat, s.lon);
    if (mi <= bestMi) { best = s; bestMi = mi; }
  }
  return best ? { ...best, distance_mi: Math.round(bestMi * 10) / 10, wind_dir: best.wind_deg != null ? compassPoint(best.wind_deg) : null } : null;
}
