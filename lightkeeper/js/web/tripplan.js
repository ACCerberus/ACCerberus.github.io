/** Trip planner in the browser: a port of the desktop trip.py engine (plan_trip) with the same plan JSON.
 *
 *  Pure engine functions run on plain aid / POI objects. `planWithData(req, hooks)` runs the whole plan with
 *  data hooks (aids, ramps, hotels, barriers, weather, tides, road drives), so it can be tested without a
 *  browser; `planTrip(req)` wires the hooks to the site's data adapters. External data never throws: every
 *  failure becomes an empty result plus a plan warning, like the desktop _Degrader.
 */

import * as aidsData from './aids.js?v=2.1.3-2';
import * as poi from './poi.js?v=2.1.3-2';
import * as water from './water.js?v=2.1.3-2';
import * as weather from './weather.js?v=2.1.3-2';
import { cached, DAY } from './store.js?v=2.1.3-2';
import { getJson } from './http.js?v=2.1.3-2';
import { bboxAround, nearestK, todayIso, METERS_PER_MILE } from './util.js?v=2.1.3-2';

/* ── Constants (copied from constants.py) ── */
export const C = {
  NM_TO_MI: 1.15078, EARTH_RADIUS_NM: 3440.065,
  BARRIER_BBOX_PADDING: 0.2, TRIP_MAX_DAYS: 30, MAX_ROUTE_BATCH_PAIRS: 150,
  TRIP_SPEED_MIN_MPH: 3, TRIP_SPEED_MAX_MPH: 60, TRIP_DEFAULT_SPEED_MPH: 25,
  TRIP_MAX_HOURS_MIN: 4, TRIP_MAX_HOURS_MAX: 16, TRIP_DEFAULT_MAX_HOURS: 8,
  TRIP_DEFAULT_WORK_MIN: 15, TRIP_WORK_MIN_MIN: 1, TRIP_WORK_MIN_MAX: 240,
  TRIP_RAMP_RADIUS_M: 50000, TRIP_HOTEL_RADIUS_M: 30000,
  WORK_MIN_DESTROYED: 5, WORK_MIN_LIGHT_TOWER: 40, WORK_MIN_LIGHT_STRUCTURE: 30, WORK_MIN_LIGHT_RANGE: 30,
  WORK_MIN_LIGHT: 20, WORK_MIN_BUOY: 10, WORK_MIN_BUOY_MANEUVER: 3, WORK_MIN_DAYBEACON: 15,
  WORK_MIN_DAYBEACON_TALL: 20, WORK_MIN_BRIDGE: 20, WORK_MIN_LIT: 5, WORK_MIN_RACON: 10, WORK_MIN_AIS: 5,
  WORK_MIN_LONG_RANGE: 5, WORK_MIN_VERY_TALL: 5, WORK_MIN_APPROACH: 5,
  HEIGHT_TOWER_FT: 40, HEIGHT_STRUCTURE_FT: 20, HEIGHT_VERY_TALL_FT: 60, RANGE_LONG_NM: 10,
  DIFF_LIGHT_TOWER: 8, DIFF_LIGHT_VERY_TALL: 9, DIFF_LIGHT_RANGE: 6, DIFF_LIGHT: 4, DIFF_BUOY: 3,
  DIFF_DAYBEACON: 2, DIFF_BRIDGE: 3, DIFF_OTHER: 3, DIFF_BONUS: 1, DIFF_MAX: 10, DIFF_HARD: 7, DIFF_EASY: 3,
  WATERWAY_CHANGE_PENALTY: 2.5, MOMENTUM_REVERSAL_PENALTY: 2.0, MOMENTUM_SIDESTEP_PENALTY: 1.3,
  MOMENTUM_SIDESTEP_DEG: 45, MOMENTUM_REVERSAL_DEG: 135, END_BIAS_REMAINING: 3, END_BIAS_WEIGHT: 0.5,
  TWO_OPT_MAX_ITER: 1000, TWO_OPT_END_PENALTY: 0.3, DIFFICULTY_REORDER_MAX_GROWTH: 0.20,
  TORTUOSITY_LAKE: 1.05, TORTUOSITY_RIVER_LEG: 1.15, TORTUOSITY_MIN: 1.0, TORTUOSITY_MAX: 2.0,
  SCATTER_ASPECT_MAX: 3.0, SCATTER_REVERSAL_RATE: 0.4,
  LAKE_NAME_WORDS: ['lake', 'bay', 'harbor', 'harbour', 'reservoir', 'pool', 'sound', 'pond'],
  TIGHT_PAIR_MI: 0.5, SPLIT_GAP_BONUS_PER_MI: 0.15, SPLIT_GAP_BONUS_MAX: 1.0, SPLIT_WATERWAY_BONUS: 2.0,
  BALANCE_MAX_PASSES: 10, BALANCE_COUNT_TOLERANCE: 0.10, BALANCE_HOURS_RATIO: 1.15, BALANCE_HOURS_GAP: 0.5,
  BALANCE_COUNT_WEIGHT_HRS: 0.25, BALANCE_OVER_CAP_WEIGHT: 10.0, SPLIT_TARGET_WINDOW: 1.0,
  OUTLIER_CENTROID_RATIO: 0.6, OUTLIER_LEG_MI: 8.0, BORDER_SMOOTH_RATIO: 0.5,
  DAY_START_MIN: 6 * 60, LAUNCH_PREP_MIN: 25, RECOVERY_PREP_MIN: 25, DAY_BUFFER_MIN: 45, FUEL_RESERVE_FACTOR: 1.1,
  RAMP_BBOX_PAD_DEG: 0.25, RAMP_OUTSIDE_BBOX_PENALTY: 15, RAMP_SAME_WATERWAY_BONUS: 10,
  RAMP_SURFACE_HARD_BONUS: 5, RAMP_SURFACE_GRAVEL_BONUS: 2, RAMP_PUBLIC_BONUS: 2, RAMP_BARRIER_PENALTY: 100,
  RAMP_BARRIER_CORRIDOR_MI: 1.0, RAMP_ALTERNATES: 4, RAMP_NO_RAMP_WARN_MI: 25,
  RAMP_HARD_SURFACES: ['concrete', 'paved', 'asphalt'], RAMP_PRIVATE_ACCESS: ['private', 'no', 'customers', 'permit'],
  WATERWAY_GENERIC_WORDS: ['river', 'lake', 'creek', 'bay', 'harbor', 'channel', 'upper', 'lower',
    'north', 'south', 'east', 'west', 'canal', 'sound', 'inlet', 'pool'],
  CHAIN_GAP_MI: 15, CHAIN_MAX_DEADHEAD_MI: 3, CHAIN_MAX_HOURS_GROWTH: 0.15,
  HOTEL_W_RECOVER: 0.8, HOTEL_W_NEXT_LAUNCH: 0.1, HOTEL_W_CORRIDOR: 0.1, HOTEL_AIRPORT_PENALTY: 10,
  HOTEL_QUALITY_PENALTY: { verified: 0, likely: 2, unverified: 5 },
  HOTEL_MULTI_NIGHT_RAMP_MI: 35, HOTEL_REACH_MI: 35, HOTEL_CANDIDATES: 8, HOTEL_ALTERNATES: 5,
  ROAD_FACTOR: 1.3, DRIVE_FALLBACK_MPH: 45, TRIP_AUTO_MAX_DAYS: 14,
  HOTEL_EXCLUDED_KINDS: ['hostel'], HOTEL_AIRPORT_WORDS: ['airport', 'airfield'],
  LEG_WARN_MI: 50, WIND_WARN_KT: 20, TIDE_STATION_MAX_MI: 50,
};

const EPS = 1e-9;
const LIT_RE = /\b(Fl|Iso|Oc|Q|VQ|Mo|F|LFl|Al)\b/i;
const OUT_OF_SERVICE_RE = /destroyed|missing|discontinued/i;
const DAY_OVERHEAD_HRS = (C.LAUNCH_PREP_MIN + C.RECOVERY_PREP_MIN + C.DAY_BUFFER_MIN) / 60.0;
const INF = Infinity;

/* ── Python-compatible number helpers ── */

/** Python round(x, n): exact decimal value, ties to even. Returns a string with n decimals. */
export function pyFixed(x, n = 0) {
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100);
  const [ip, fp] = s.split('.');
  const rest = fp.slice(n);
  let digits = (ip + fp.slice(0, n)).split('').map(Number);
  const head = rest[0] || '0';
  const tail = rest.slice(1);
  const up = head > '5' || (head === '5' && /[1-9]/.test(tail)) || (head === '5' && !/[1-9]/.test(tail) && digits[digits.length - 1] % 2 === 1);
  if (up) {
    let i = digits.length - 1;
    while (i >= 0) { if (digits[i] === 9) { digits[i] = 0; i -= 1; } else { digits[i] += 1; break; } }
    if (i < 0) digits = [1, ...digits];
  }
  const str = digits.join('');
  const intPart = str.slice(0, str.length - n) || '0';
  const out = n ? `${intPart}.${str.slice(str.length - n)}` : intPart;
  return (neg && /[1-9]/.test(out) ? '-' : '') + out.replace(/^0+(?=\d)/, '');
}
export const pyRound = (x, n = 0) => Number(pyFixed(x, n));
/** str() of a Python float: 12.0 -> "12.0". */
const pyFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
/** Python "{:g}" for plain numbers. */
const fmtG = (v) => String(Number(Number(v).toPrecision(6)));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
/** First index with the smallest key (Python min). */
function argMin(items, key) {
  let best = null; let bestK = INF; let found = false;
  for (const it of items) { const k = key(it); if (!found || k < bestK) { best = it; bestK = k; found = true; } }
  return best;
}
function argMax(items, key) {
  let best = null; let bestK = -INF; let found = false;
  for (const it of items) { const k = key(it); if (!found || k > bestK) { best = it; bestK = k; found = true; } }
  return best;
}
const range = (a, b) => { const out = []; for (let i = a; i < b; i++) out.push(i); return out; };

/* ── Geo (same formulas and operation order as geo.py) ── */
const RAD = Math.PI / 180.0;
const DEG = 180.0 / Math.PI;
export function haversineMiles(lat1, lon1, lat2, lon2) {
  const dlat = (lat2 - lat1) * RAD;
  const dlon = (lon2 - lon1) * RAD;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dlon / 2) ** 2;
  return C.EARTH_RADIUS_NM * 2 * Math.asin(Math.min(1.0, Math.sqrt(a))) * C.NM_TO_MI;
}
function trueBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD; const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) * DEG) + 360) % 360);
}
const validCoords = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
function centroid(points) {
  const pts = [...points];
  if (!pts.length) return [0.0, 0.0];
  return [sum(pts.map((p) => p[0])) / pts.length, sum(pts.map((p) => p[1])) / pts.length];
}

/* ── Aid accessors ── */
const get = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
function lat(a) { const v = get(a, 'latitude') !== undefined ? a.latitude : (get(a, 'lat') !== undefined ? a.lat : 0); return Number(v || 0); }
function lon(a) { const v = get(a, 'longitude') !== undefined ? a.longitude : (get(a, 'lon') !== undefined ? a.lon : 0); return Number(v || 0); }
function num(a, key) { const v = Number(a?.[key] || 0); return Number.isNaN(v) ? 0 : v; }
const text = (a, ...keys) => keys.map((k) => String(a?.[k] || '')).join(' ').toLowerCase();
const waterway = (a) => String(a?.waterway || '').trim();
const aidName = (a) => String(a?.aidname || a?.name || '').trim();

function aidClass(a) {
  for (const t of [text(a, 'aid_type'), text(a, 'aidname')]) {
    if (t.includes('buoy')) return 'buoy';
    if (t.includes('beacon') || t.includes('dayboard')) return 'daybeacon';
    if (t.includes('bridge')) return 'bridge';
    if (t.includes('light')) return 'light';
  }
  return 'other';
}
function isLit(a) {
  const chars = String(a?.characteristics || '');
  const unlit = (`${chars} ${text(a, 'aidname', 'aid_type')}`).toLowerCase().includes('unlighted');
  return LIT_RE.test(chars) && !unlit;
}
const hasRacon = (a) => text(a, 'characteristics', 'remark', 'aidname').includes('racon');
const hasAis = (a) => /\bais\b/.test(text(a, 'characteristics', 'remark', 'aidname'));
const isOutOfService = (a) => OUT_OF_SERVICE_RE.test(String(a?.remark || ''));
const isTower = (a) => text(a, 'aidname', 'structure').includes('tower');
const isRange = (a) => text(a, 'aidname').includes('range');

/* ── Work time and difficulty ── */
function lightWorkMinutes(a) {
  const height = num(a, 'aidheight');
  if (height > C.HEIGHT_TOWER_FT || isTower(a)) return C.WORK_MIN_LIGHT_TOWER;
  const structure = text(a, 'structure');
  if (height > C.HEIGHT_STRUCTURE_FT || ['platform', 'pile', 'caisson'].some((w) => structure.includes(w))) return C.WORK_MIN_LIGHT_STRUCTURE;
  if (isRange(a)) return C.WORK_MIN_LIGHT_RANGE;
  return C.WORK_MIN_LIGHT;
}
function baseWorkMinutes(a, def) {
  const kind = aidClass(a);
  if (kind === 'light') return lightWorkMinutes(a);
  if (kind === 'buoy') return C.WORK_MIN_BUOY + C.WORK_MIN_BUOY_MANEUVER;
  if (kind === 'daybeacon') return num(a, 'aidheight') > C.HEIGHT_STRUCTURE_FT ? C.WORK_MIN_DAYBEACON_TALL : C.WORK_MIN_DAYBEACON;
  if (kind === 'bridge') return C.WORK_MIN_BRIDGE;
  return def;
}
function workExtras(a) {
  let extra = C.WORK_MIN_APPROACH;
  if (isLit(a)) extra += C.WORK_MIN_LIT;
  if (hasRacon(a)) extra += C.WORK_MIN_RACON;
  if (hasAis(a)) extra += C.WORK_MIN_AIS;
  if (num(a, 'aidrange') > C.RANGE_LONG_NM) extra += C.WORK_MIN_LONG_RANGE;
  if (num(a, 'aidheight') > C.HEIGHT_VERY_TALL_FT) extra += C.WORK_MIN_VERY_TALL;
  return extra;
}
/** Estimated on-station service time for one aid, in minutes (the planner's one stop time when it set one). */
export function workMinutes(a, def = C.TRIP_DEFAULT_WORK_MIN) {
  if (a?._stop_min !== null && a?._stop_min !== undefined) return Math.trunc(Number(a._stop_min));   // one stop time set by the planner
  if (isOutOfService(a)) return C.WORK_MIN_DESTROYED;
  return baseWorkMinutes(a, def) + workExtras(a);
}
function baseDifficulty(a) {
  const kind = aidClass(a);
  if (kind === 'light') {
    const height = num(a, 'aidheight');
    if (height > C.HEIGHT_VERY_TALL_FT) return C.DIFF_LIGHT_VERY_TALL;
    if (height > C.HEIGHT_TOWER_FT || isTower(a)) return C.DIFF_LIGHT_TOWER;
    if (isRange(a) || height > C.HEIGHT_STRUCTURE_FT) return C.DIFF_LIGHT_RANGE;
    return C.DIFF_LIGHT;
  }
  return { buoy: C.DIFF_BUOY, daybeacon: C.DIFF_DAYBEACON, bridge: C.DIFF_BRIDGE }[kind] ?? C.DIFF_OTHER;
}
/** Service difficulty 0-10 (towers hardest, daybeacons easiest). */
export function difficulty(a) {
  const bonuses = [hasRacon(a), hasAis(a), num(a, 'aidrange') > C.RANGE_LONG_NM, num(a, 'aidheight') > C.HEIGHT_VERY_TALL_FT];
  const score = baseDifficulty(a) + C.DIFF_BONUS * bonuses.filter(Boolean).length;
  return Math.max(0, Math.min(C.DIFF_MAX, score));
}

/* ── Geometry helpers ── */
/** (lat, lon) array from [lat, lon], {lat, lon} or {latitude, longitude}; null when absent/invalid. */
function point(p) {
  if (p === null || p === undefined) return null;
  let la; let lo;
  if (Array.isArray(p)) { la = Number(p[0]); lo = Number(p[1]); } else if (typeof p === 'object') { la = lat(p); lo = lon(p); } else return null;
  return validCoords(la, lo) && !(la === 0 && lo === 0) ? [la, lo] : null;
}
const dist = (a, b) => haversineMiles(lat(a), lon(a), lat(b), lon(b));
const distPt = (a, p) => haversineMiles(lat(a), lon(a), p[0], p[1]);
const distPts = (p, q) => haversineMiles(p[0], p[1], q[0], q[1]);
function rampGap(a, b) { const pa = point(a); const pb = point(b); return pa && pb ? distPts(pa, pb) : INF; }
const truthy = (o) => Boolean(o) && (typeof o !== 'object' || Object.keys(o).length > 0);
const samePoi = (a, b) => truthy(a) && truthy(b) && (get(a, 'id') === get(b, 'id') || rampGap(a, b) < EPS);
const isLakeName = (name) => (name.toLowerCase().match(/[a-z]+/g) || []).some((w) => C.LAKE_NAME_WORDS.includes(w));
const legTortuosity = (a, b) => (isLakeName(waterway(a)) || isLakeName(waterway(b)) ? C.TORTUOSITY_LAKE : C.TORTUOSITY_RIVER_LEG);

function projected(aids) {
  const ref = Math.cos((sum(aids.map(lat)) / aids.length) * RAD);
  return aids.map((a) => [lon(a) * ref, lat(a)]);
}
function principalAxis(xy) {
  const n = xy.length;
  const mx = sum(xy.map((p) => p[0])) / n; const my = sum(xy.map((p) => p[1])) / n;
  const sxx = sum(xy.map((p) => (p[0] - mx) ** 2));
  const syy = sum(xy.map((p) => (p[1] - my) ** 2));
  const sxy = sum(xy.map((p) => (p[0] - mx) * (p[1] - my)));
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [Math.cos(theta), Math.sin(theta)];
}
function axisProjections(aids) {
  const xy = projected(aids);
  const [ux, uy] = principalAxis(xy);
  return [xy.map((p) => p[0] * ux + p[1] * uy), xy.map((p) => -p[0] * uy + p[1] * ux)];
}
function bboxOf(aids) {
  const lats = aids.map(lat); const lons = aids.map(lon);
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
}
function pathLength(aids) { let t = 0; for (let i = 1; i < aids.length; i++) t += dist(aids[i - 1], aids[i]); return t; }
function headingChange(prev, cur, nxt) {
  const h1 = trueBearing(lat(prev), lon(prev), lat(cur), lon(cur));
  const h2 = trueBearing(lat(cur), lon(cur), lat(nxt), lon(nxt));
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/* ── Route ordering ── */
function edgeCost(a, b) {
  let cost = dist(a, b);
  if (waterway(a) && waterway(b) && waterway(a).toLowerCase() !== waterway(b).toLowerCase()) cost *= C.WATERWAY_CHANGE_PENALTY;
  return cost;
}
function momentumFactor(prev, cur, nxt) {
  if (prev === null) return 1.0;
  const change = headingChange(prev, cur, nxt);
  if (change > C.MOMENTUM_REVERSAL_DEG) return C.MOMENTUM_REVERSAL_PENALTY;
  if (change > C.MOMENTUM_SIDESTEP_DEG) return C.MOMENTUM_SIDESTEP_PENALTY;
  return 1.0;
}
function firstIndex(aids, start) {
  if (start !== null) return argMin(range(0, aids.length), (i) => distPt(aids[i], start));
  const [along] = axisProjections(aids);
  return argMin(range(0, aids.length), (i) => along[i]);
}
function nearestNeighbour(aids, start, end) {
  const remaining = range(0, aids.length);
  let cur = firstIndex(aids, start);
  remaining.splice(remaining.indexOf(cur), 1);
  const route = [cur]; let prev = null;
  while (remaining.length) {
    const endBias = end !== null && remaining.length <= C.END_BIAS_REMAINING;
    const farEnd = endBias ? Math.max(...remaining.map((i) => distPt(aids[i], end))) : 0.0;
    const cost = (i) => {
      let c = edgeCost(aids[cur], aids[i]) * momentumFactor(prev !== null ? aids[prev] : null, aids[cur], aids[i]);
      if (endBias) c += C.END_BIAS_WEIGHT * (farEnd - distPt(aids[i], end));
      return c;
    };
    const nxt = argMin(remaining, cost);
    remaining.splice(remaining.indexOf(nxt), 1);
    route.push(nxt);
    prev = cur; cur = nxt;
  }
  return route;
}
const terminalCost = (a, terminal) => (terminal !== null ? C.TWO_OPT_END_PENALTY * distPt(a, terminal) : 0.0);
function twoOpt(aids, route, start, end) {
  const n = route.length;
  if (n < 3) return route;
  const maxIter = Math.min(C.TWO_OPT_MAX_ITER, n * n);
  let iters = 0; let improved = true;
  while (improved && iters < maxIter) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = aids[route[i]]; const b = aids[route[j]];
        const old = (i > 0 ? edgeCost(aids[route[i - 1]], a) : terminalCost(a, start))
          + (j < n - 1 ? edgeCost(b, aids[route[j + 1]]) : terminalCost(b, end));
        const nw = (i > 0 ? edgeCost(aids[route[i - 1]], b) : terminalCost(b, start))
          + (j < n - 1 ? edgeCost(a, aids[route[j + 1]]) : terminalCost(a, end));
        if (nw < old - EPS) {
          const seg = route.slice(i, j + 1).reverse();
          route.splice(i, seg.length, ...seg);
          improved = true;
          iters += 1;
          if (iters >= maxIter) return route;
        }
      }
    }
  }
  return route;
}
function difficultyReorder(route) {
  const bucket = route.map((a) => { const d = difficulty(a); return d >= C.DIFF_HARD ? 0 : d <= C.DIFF_EASY ? 2 : 1; });
  const order = range(0, route.length).sort((x, y) => bucket[x] - bucket[y]);
  const reordered = order.map((i) => route[i]);
  if (reordered.every((a, i) => a === route[i])) return route;
  return pathLength(reordered) <= pathLength(route) * (1 + C.DIFFICULTY_REORDER_MAX_GROWTH) ? reordered : route;
}
/** Order aids into a no-zig-zag service route, optionally anchored at start/end points. */
export function orderRoute(aids, start = null, end = null, byDifficulty = true) {
  aids = [...aids];
  if (aids.length < 2) return aids;
  const s = point(start); const e = point(end);
  const idx = twoOpt(aids, nearestNeighbour(aids, s, e), s, e);
  const route = idx.map((i) => aids[i]);
  return byDifficulty ? difficultyReorder(route) : route;
}

/* ── Tortuosity ── */
function largestWaterwayGroup(aids) {
  const groups = new Map();
  for (const a of aids) { const k = waterway(a).toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  return argMax([...groups.values()], (g) => g.length);
}
function reversalRate(sorted) {
  if (sorted.length < 3) return 0.0;
  let turns = 0;
  for (let i = 1; i < sorted.length - 1; i++) if (headingChange(sorted[i - 1], sorted[i], sorted[i + 1]) > 90) turns += 1;
  return turns / (sorted.length - 2);
}
/** Ratio of water path to straight line for the dominant waterway, clamped 1.0-2.0. */
export function tortuosity(aids) {
  if (aids.length < 3) return C.TORTUOSITY_MIN;
  const group = largestWaterwayGroup(aids);
  if (group.length < 3 || isLakeName(waterway(group[0]))) return C.TORTUOSITY_LAKE;
  const [along, across] = axisProjections(group);
  const ordered = range(0, group.length).sort((x, y) => along[x] - along[y]).map((i) => group[i]);
  const spanAlong = Math.max(...along) - Math.min(...along);
  const spanAcross = Math.max(...across) - Math.min(...across);
  const aspect = spanAcross > EPS ? spanAlong / spanAcross : INF;
  if (aspect < C.SCATTER_ASPECT_MAX && reversalRate(ordered) > C.SCATTER_REVERSAL_RATE) return C.TORTUOSITY_LAKE;
  const straight = dist(ordered[0], ordered[ordered.length - 1]);
  if (straight < EPS) return C.TORTUOSITY_MIN;
  return Math.max(C.TORTUOSITY_MIN, Math.min(C.TORTUOSITY_MAX, pathLength(ordered) / straight));
}

/* ── Day splitting ── */
const travelHours = (miles, speed) => miles / Math.max(speed, EPS);
function dayHours(aids, speed, tort, workDefault = C.TRIP_DEFAULT_WORK_MIN) {
  if (!aids.length) return 0.0;
  const work = sum(aids.map((a) => workMinutes(a, workDefault))) / 60.0;
  return work + travelHours(pathLength(aids) * tort, speed) + DAY_OVERHEAD_HRS;
}
function aidHours(route, speed, tort, workDefault) {
  return route.map((a, i) => {
    const leg = i > 0 ? dist(route[i - 1], a) * tort : 0.0;
    return workMinutes(a, workDefault) / 60.0 + travelHours(leg, speed);
  });
}
function splitBonus(route, b) {
  const gap = dist(route[b - 1], route[b]);
  let bonus = Math.min(gap * C.SPLIT_GAP_BONUS_PER_MI, C.SPLIT_GAP_BONUS_MAX);
  if (waterway(route[b - 1]).toLowerCase() !== waterway(route[b]).toLowerCase()) bonus += C.SPLIT_WATERWAY_BONUS;
  return bonus;
}
function chooseSplits(route, hours, k) {
  const n = route.length;
  const cum = [0.0];
  for (const h of hours) cum.push(cum[cum.length - 1] + h);
  const total = cum[cum.length - 1]; const perDay = total / k;
  const bounds = []; let prev = 0;
  for (let j = 1; j < k; j++) {
    const target = total * j / k;
    const candidates = range(prev + 1, n - (k - j) + 1);
    const loose = candidates.filter((b) => dist(route[b - 1], route[b]) >= C.TIGHT_PAIR_MI);
    const pool = loose.length ? loose : candidates;
    const nearList = pool.filter((b) => Math.abs(cum[b] - target) <= perDay * C.SPLIT_TARGET_WINDOW);
    const near = nearList.length ? nearList : pool;
    const best = argMin(near, (b) => Math.abs(cum[b] - target) - splitBonus(route, b));
    bounds.push(best);
    prev = best;
  }
  return bounds;
}
function sliceDays(route, bounds) {
  const edges = [0, ...bounds, route.length];
  return range(0, edges.length - 1).map((i) => route.slice(edges[i], edges[i + 1]));
}
const waterwayBoundary = (left, right) => waterway(left[left.length - 1]).toLowerCase() !== waterway(right[0]).toLowerCase();
function moveAllowed(left, right, fromLeft, crossWaterway = false) {
  const source = fromLeft ? left : right;
  if (source.length < 2) return false;
  if (waterwayBoundary(left, right) && !crossWaterway) return false;
  const oldGap = dist(left[left.length - 1], right[0]);
  const newGap = fromLeft ? dist(left[left.length - 2], left[left.length - 1]) : dist(right[0], right[1]);
  return newGap >= C.TIGHT_PAIR_MI || oldGap < C.TIGHT_PAIR_MI;
}
const moved = (left, right, fromLeft) => (fromLeft ? [left.slice(0, -1), [left[left.length - 1], ...right]] : [[...left, right[0]], right.slice(1)]);
function pairBalanced(ha, hb, na, nb, maxHours) {
  if (Math.max(ha, hb) > maxHours) return false;
  const hoursOk = Math.max(ha, hb) <= Math.min(ha, hb) * C.BALANCE_HOURS_RATIO || Math.abs(ha - hb) < C.BALANCE_HOURS_GAP;
  const countOk = Math.abs(na - nb) <= Math.max(1, C.BALANCE_COUNT_TOLERANCE * (na + nb) / 2);
  return hoursOk && countOk;
}
function pairScore(ha, hb, na, nb, maxHours) {
  const over = Math.max(0.0, ha - maxHours) + Math.max(0.0, hb - maxHours);
  return Math.abs(ha - hb) + C.BALANCE_COUNT_WEIGHT_HRS * Math.abs(na - nb) + C.BALANCE_OVER_CAP_WEIGHT * over;
}
function balancePair(days, i, speed, tort, maxHours, workDefault) {
  const left = days[i]; const right = days[i + 1];
  const ha = dayHours(left, speed, tort, workDefault); const hb = dayHours(right, speed, tort, workDefault);
  if (pairBalanced(ha, hb, left.length, right.length, maxHours)) return false;
  const current = pairScore(ha, hb, left.length, right.length, maxHours);
  const overCap = Math.max(ha, hb) > maxHours;
  let best = null; let bestScore = current - EPS;
  for (const fromLeft of [true, false]) {
    if (!moveAllowed(left, right, fromLeft, overCap)) continue;
    const [l2, r2] = moved(left, right, fromLeft);
    const score = pairScore(dayHours(l2, speed, tort, workDefault), dayHours(r2, speed, tort, workDefault), l2.length, r2.length, maxHours);
    if (score < bestScore) { best = [l2, r2]; bestScore = score; }
  }
  if (best === null) return false;
  [days[i], days[i + 1]] = best;
  return true;
}
function balanceDays(days, speed, tort, maxHours, workDefault) {
  for (let p = 0; p < C.BALANCE_MAX_PASSES; p++) {
    let any = false;
    for (let i = 0; i < days.length - 1; i++) any = balancePair(days, i, speed, tort, maxHours, workDefault) || any;
    if (!any) return;
  }
}
const centroidOf = (aids) => centroid(aids.map((a) => [lat(a), lon(a)]));
function isOutlier(a, own, other) {
  if (own.length < 1 || !other.length) return false;
  return distPt(a, centroidOf(other)) < C.OUTLIER_CENTROID_RATIO * distPt(a, centroidOf(own));
}
function outlierBoundaryPass(days) {
  for (let i = 0; i < days.length - 1; i++) {
    const left = days[i]; const right = days[i + 1];
    if (moveAllowed(left, right, true) && isOutlier(left[left.length - 1], left.slice(0, -1), right)) {
      [days[i], days[i + 1]] = moved(left, right, true);
      continue;
    }
    if (moveAllowed(left, right, false) && isOutlier(right[0], right.slice(1), left)) [days[i], days[i + 1]] = moved(left, right, false);
  }
}
const fits = (aids, speed, tort, maxHours, workDefault) => dayHours(aids, speed, tort, workDefault) <= maxHours;
function splitLongLegs(days, speed, tort, maxHours, workDefault) {
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (day.length < 2) continue;
    const m = argMax(range(1, day.length), (j) => dist(day[j - 1], day[j]));
    if (dist(day[m - 1], day[m]) <= C.OUTLIER_LEG_MI) continue;
    const head = day.slice(0, m); const tail = day.slice(m);
    if (head.length <= tail.length && i > 0 && fits([...days[i - 1], ...head], speed, tort, maxHours, workDefault)) {
      days[i - 1] = [...days[i - 1], ...head]; days[i] = tail;
    } else if (tail.length < head.length && i + 1 < days.length && fits([...tail, ...days[i + 1]], speed, tort, maxHours, workDefault)) {
      days[i] = head; days[i + 1] = [...tail, ...days[i + 1]];
    }
  }
}
function smoothBorders(days) {
  for (let i = 0; i < days.length - 1; i++) {
    const left = days[i]; const right = days[i + 1];
    const gap = dist(left[left.length - 1], right[0]);
    if (left.length >= 2 && gap < C.BORDER_SMOOTH_RATIO * dist(left[left.length - 2], left[left.length - 1]) && moveAllowed(left, right, true)) {
      [days[i], days[i + 1]] = moved(left, right, true);
      continue;
    }
    if (right.length >= 2 && gap < C.BORDER_SMOOTH_RATIO * dist(right[0], right[1]) && moveAllowed(left, right, false)) [days[i], days[i + 1]] = moved(left, right, false);
  }
}
/** Split aids into up to k contiguous day sections along the route. */
export function splitDays(aids, k, speed, maxHours, start = null, workDefault = C.TRIP_DEFAULT_WORK_MIN) {
  if (!aids.length) return [];
  const route = orderRoute(aids, start, null, false);
  k = Math.max(1, Math.min(Math.trunc(k), route.length));
  const tort = tortuosity(route);
  const hours = aidHours(route, speed, tort, workDefault);
  const days = sliceDays(route, chooseSplits(route, hours, k));
  balanceDays(days, speed, tort, maxHours, workDefault);
  outlierBoundaryPass(days);
  splitLongLegs(days, speed, tort, maxHours, workDefault);
  smoothBorders(days);
  return days.filter((d) => d.length);
}

/* ── Day stats ── */
const legMiles = (a, b, real) => (real !== null && real !== undefined ? real : dist(a, b) * legTortuosity(a, b));
function transitMiles(ramp, a) { const p = point(ramp); return p ? distPt(a, p) * legTortuosity(a, a) : 0.0; }
function clock(minutes) {
  const m = ((pyRound(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
/** Water miles, travel/work/total hours, finish time, fuel and per-aid arrival minutes. */
export function dayStats(aids, speed, launch = null, recover = null, wDists = null, fuelGph = null, departMin = C.DAY_START_MIN, workDefault = C.TRIP_DEFAULT_WORK_MIN) {
  aids = [...aids];
  if (!aids.length) {
    return { water_mi: 0.0, travel_hrs: 0.0, work_hrs: 0.0, total_hrs: 0.0, finish_time: clock(departMin), fuel_gal: null, arrive_min: [], legs_mi: [], legs_est: [],
      to_first_mi: 0.0, from_last_mi: 0.0, start_time: clock(departMin) };
  }
  const has = wDists && wDists.length;
  const legs = range(1, aids.length).map((i) => legMiles(aids[i - 1], aids[i], has && i - 1 < wDists.length ? wDists[i - 1] : null));
  const toFirst = transitMiles(launch, aids[0]); const fromLast = transitMiles(recover, aids[aids.length - 1]);
  let t = departMin + C.LAUNCH_PREP_MIN + travelHours(toFirst, speed) * 60;
  const arrivals = []; let workTotal = 0;
  aids.forEach((a, i) => {
    if (i > 0) t += travelHours(legs[i - 1], speed) * 60;
    arrivals.push(pyRound(t));
    const w = workMinutes(a, workDefault);
    workTotal += w;
    t += w;
  });
  t += travelHours(fromLast, speed) * 60 + C.RECOVERY_PREP_MIN + C.DAY_BUFFER_MIN;
  const waterMi = sum(legs) + toFirst + fromLast;
  const travelHrs = travelHours(waterMi, speed);
  return {
    water_mi: pyRound(waterMi, 1),
    travel_hrs: pyRound(travelHrs, 2),
    work_hrs: pyRound(workTotal / 60.0, 2),
    total_hrs: pyRound((t - departMin) / 60.0, 2),
    finish_time: clock(t),
    fuel_gal: fuelGph ? pyRound(fuelGph * travelHrs * C.FUEL_RESERVE_FACTOR, 1) : null,
    arrive_min: arrivals,
    legs_mi: legs.map((x) => pyRound(x, 2)),
    legs_est: legs.map((_, i) => !(has && i < wDists.length && wDists[i] !== null && wDists[i] !== undefined)),
    to_first_mi: pyRound(toFirst, 2), from_last_mi: pyRound(fromLast, 2),
    start_time: clock(departMin),
  };
}

/* ── Ramp selection ── */
const poiTag = (p, key) => String((p?.tags || {})[key] || '').toLowerCase();
const waterwayTokens = (w) => new Set((w.toLowerCase().match(/[a-z]{4,}/g) || []).filter((x) => !C.WATERWAY_GENERIC_WORDS.includes(x)));
function sameWaterway(p, w) {
  const tokens = waterwayTokens(w);
  if (!tokens.size) return false;
  const tags = p.tags || {};
  const hay = [String(p.name || ''), String(p.address || ''), ...Object.values(tags).map(String)].join(' ').toLowerCase();
  return [...tokens].some((t) => hay.includes(t));
}
const isPrivate = (r) => C.RAMP_PRIVATE_ACCESS.includes(poiTag(r, 'access'));
function surfaceBonus(r) {
  const s = poiTag(r, 'surface');
  if (C.RAMP_HARD_SURFACES.some((x) => s.includes(x))) return C.RAMP_SURFACE_HARD_BONUS;
  if (s.includes('gravel')) return C.RAMP_SURFACE_GRAVEL_BONUS;
  return 0.0;
}
function outsideBbox(p, [s, w, n, e]) {
  const pad = C.RAMP_BBOX_PAD_DEG;
  return !(s - pad <= p[0] && p[0] <= n + pad && w - pad <= p[1] && p[1] <= e + pad);
}
function pointSegmentMiles(p, a, b) {
  const ref = Math.cos(a[0] * RAD);
  const ax = a[1] * ref; const ay = a[0]; const bx = b[1] * ref; const by = b[0]; const px = p[1] * ref; const py = p[0];
  const dx = bx - ax; const dy = by - ay;
  const segSq = dx * dx + dy * dy;
  const t = segSq < EPS ? 0.0 : Math.max(0.0, Math.min(1.0, ((px - ax) * dx + (py - ay) * dy) / segSq));
  const cy = ay + t * dy; const cx = (ax + t * dx) / ref;
  return [haversineMiles(p[0], p[1], cy, cx), t];
}
function barrierBetween(rampPt, aidPt, barriers) {
  for (const b of barriers) {
    const bp = point(b);
    if (bp === null) continue;
    const [miles, t] = pointSegmentMiles(bp, rampPt, aidPt);
    if (t > 0.0 && t < 1.0 && miles <= C.RAMP_BARRIER_CORRIDOR_MI) return b;
  }
  return null;
}
function rampScore(ramp, anchor, bbox, w, barriers) {
  const p = point(ramp);
  let score = distPt(anchor, p);
  const reasons = [`${pyFixed(distPt(anchor, p), 1)} mi from aid`];
  if (outsideBbox(p, bbox)) score += C.RAMP_OUTSIDE_BBOX_PENALTY;
  if (sameWaterway(ramp, w)) { score -= C.RAMP_SAME_WATERWAY_BONUS; reasons.push('same waterway'); }
  const surface = surfaceBonus(ramp);
  if (surface) { score -= surface; reasons.push(`${poiTag(ramp, 'surface')} surface`); }
  if (['', 'yes', 'public', 'permissive'].includes(poiTag(ramp, 'access'))) { score -= C.RAMP_PUBLIC_BONUS; reasons.push('public'); }
  const barrier = barrierBetween(p, [lat(anchor), lon(anchor)], barriers);
  if (barrier) {
    score += C.RAMP_BARRIER_PENALTY;
    reasons.push(`behind ${barrier.name || (get(barrier, 'kind') !== undefined ? barrier.kind : 'barrier')}`);
  }
  return [score, reasons];
}
function rankRamps(ramps, anchor, bbox, w, barriers) {
  const scored = [];
  for (const r of ramps) {
    if (point(r) === null || isPrivate(r)) continue;
    const [score, reasons] = rampScore(r, anchor, bbox, w, barriers);
    scored.push([score, { ...r, why: reasons.join(', '), score: pyRound(score, 1) }]);
  }
  scored.sort((x, y) => x[0] - y[0]);
  return scored.map((s) => s[1]);
}
/** Launch (near the first aid) and recovery (near the last aid) ramps for one day. */
export function pickRamps(dayAids, ramps, barriers = null) {
  dayAids = [...dayAids];
  if (!dayAids.length) return { launch: null, recover: null, alt_launches: [], alt_recovers: [], aids: [] };
  barriers = barriers || [];
  const bbox = bboxOf(dayAids); const w = waterway(dayAids[0]);
  const launches = rankRamps(ramps, dayAids[0], bbox, w, barriers);
  const recovers = rankRamps(ramps, dayAids[dayAids.length - 1], bbox, w, barriers);
  const launch = launches[0] || null; const recover = recovers[0] || null;
  const anchored = (launch || recover) && !samePoi(launch, recover);
  const ordered = anchored ? orderRoute(dayAids, launch, recover) : dayAids;
  return { launch, recover, alt_launches: launches.slice(1, 1 + C.RAMP_ALTERNATES), alt_recovers: recovers.slice(1, 1 + C.RAMP_ALTERNATES), aids: ordered };
}

/* ── Day chaining ── */
function dayHoursWithRamps(day, speed) {
  const a = day.aids;
  const transit = transitMiles(day.launch, a[0]) + transitMiles(day.recover, a[a.length - 1]);
  return dayHours(a, speed, tortuosity(a)) + travelHours(transit, speed);
}
function deadheadOk(day, ramp, which, speed) {
  const a = day.aids;
  const anchor = which === 'launch' ? a[0] : a[a.length - 1];
  const added = transitMiles(ramp, anchor) - transitMiles(day[which], anchor);
  if (added > C.CHAIN_MAX_DEADHEAD_MI) return false;
  const hours = dayHoursWithRamps(day, speed);
  return travelHours(Math.max(added, 0.0), speed) <= C.CHAIN_MAX_HOURS_GROWTH * Math.max(hours, EPS);
}
function chainCandidates(today, tomorrow) {
  const recovers = [today.recover, ...(today.alt_recovers || []), tomorrow.launch, ...(tomorrow.alt_launches || [])].filter(truthy);
  const launches = [tomorrow.launch, ...(tomorrow.alt_launches || []), today.recover, ...(today.alt_recovers || [])].filter(truthy);
  return [recovers, launches];
}
function applyChain(today, tomorrow, recover, launch) {
  const changed = [];
  if (!samePoi(today.recover, recover)) { today.recover = recover; changed.push("today's recovery"); }
  if (!samePoi(tomorrow.launch, launch)) { tomorrow.launch = launch; changed.push("tomorrow's launch"); }
  const nm = (p) => (get(p, 'name') !== undefined ? p.name : 'ramp');
  let note = samePoi(recover, launch) ? `Chained: ${nm(launch)} is both recovery and next launch`
    : `Chained: recovery ${nm(recover)} and next launch ${nm(launch)} sit close together`;
  if (changed.length) note += ` (moved ${changed.join(' and ')})`;
  (today.notes = today.notes || []).push(note);
}
/** Make each day's recovery double as the next launch when it costs little dead-heading. */
export function chainDays(days, speed = C.TRIP_DEFAULT_SPEED_MPH) {
  for (let i = 0; i < days.length - 1; i++) {
    const today = days[i]; const tomorrow = days[i + 1];
    if (!today.aids.length || !tomorrow.aids.length) continue;
    const gap = rampGap(today.recover, tomorrow.launch);
    if (gap <= C.CHAIN_GAP_MI) continue;
    let best = null; let bestGap = gap;
    const [recovers, launches] = chainCandidates(today, tomorrow);
    for (const r of recovers) {
      if (!samePoi(r, today.recover) && !deadheadOk(today, r, 'recover', speed)) continue;
      for (const l of launches) {
        if (!samePoi(l, tomorrow.launch) && !deadheadOk(tomorrow, l, 'launch', speed)) continue;
        const g = rampGap(r, l);
        if (g < bestGap - EPS) { best = [r, l]; bestGap = g; }
      }
    }
    if (best) applyChain(today, tomorrow, ...best);
  }
  return days;
}

/* ── Hotels (never hostels) ── */
export function isHostel(p) {
  const t = (`${String(p?.kind || '')} ${String(p?.name || '')} ${poiTag(p, 'tourism')}`).toLowerCase();
  return C.HOTEL_EXCLUDED_KINDS.some((k) => t.includes(k));
}
const isAirportHotel = (p) => C.HOTEL_AIRPORT_WORDS.some((w) => String(p.name || '').toLowerCase().includes(w));
const nightAnchor = (day) => point(day.recover) || (day.aids?.length ? point(day.aids[day.aids.length - 1]) : null);
function morningAnchor(day) {
  if (!day) return null;
  return point(day.launch) || (day.aids?.length ? point(day.aids[0]) : null);
}
function hotelCandidates(hotels, anchor) {
  const usable = hotels.filter((h) => point(h) && !isHostel(h));
  usable.sort((x, y) => distPts(point(x), anchor) - distPts(point(y), anchor));
  return usable.slice(0, C.HOTEL_CANDIDATES);
}
function roadMilesFrom(results, pairs) {
  const fallback = pairs.map(([o, d]) => distPts(o, d) * C.ROAD_FACTOR);
  if (results === null) return fallback;
  const out = (results || []).map((r, i) => {
    let miles = null;
    if (r && typeof r === 'object' && r.ok) miles = r.distance_mi ?? null;
    else if (typeof r === 'number') miles = r;
    return miles !== null && miles !== undefined ? Number(miles) : fallback[i];
  });
  return [...out, ...fallback.slice(out.length)];
}
function hotelScore(h, recMi, nextMi, corridorMi) {
  let score = C.HOTEL_W_RECOVER * recMi + C.HOTEL_W_CORRIDOR * corridorMi;
  if (nextMi !== null) score += C.HOTEL_W_NEXT_LAUNCH * nextMi;
  score += C.HOTEL_QUALITY_PENALTY[String(h.quality || 'unverified')] ?? C.HOTEL_QUALITY_PENALTY.unverified;
  if (isAirportHotel(h)) score += C.HOTEL_AIRPORT_PENALTY;
  return score;
}
function scoreHotels(cands, rec, nxt, miles) {
  const ranked = cands.map((h, i) => {
    const recMi = miles[i];
    const nextMi = nxt ? miles[cands.length + i] : null;
    const corridor = nxt ? pointSegmentMiles(point(h), rec, nxt)[0] : 0.0;
    const why = `${pyFixed(recMi, 0)} mi by road from recovery` + (nextMi !== null ? `, ${pyFixed(nextMi, 0)} mi to tomorrow's launch` : '');
    return [hotelScore(h, recMi, nextMi, corridor), { ...h, drive_mi: pyRound(recMi, 1), next_drive_mi: nextMi !== null ? pyRound(nextMi, 1) : null, why }];
  });
  ranked.sort((x, y) => x[0] - y[0]);
  return ranked.map((r) => r[1]);
}
function multiNight(prevDay, rec, ranked) {
  if (!prevDay || !prevDay.hotel) return null;
  const hotel = prevDay.hotel; const prevRec = nightAnchor(prevDay); const hotelPt = point(hotel);
  if (!(prevRec && hotelPt) || distPts(prevRec, rec) >= C.HOTEL_MULTI_NIGHT_RAMP_MI) return null;
  const match = ranked.find((h) => samePoi(h, hotel));
  const reach = match ? match.drive_mi : distPts(hotelPt, rec) * C.ROAD_FACTOR;
  return reach <= C.HOTEL_REACH_MI ? hotel : null;
}
/**
 * Attach hotel / alt_hotels to each day. `driveLookup(pairs)` takes [{olat, olon, dlat, dlon}] and resolves to
 * routing results ({ok, distance_mi}); haversine x ROAD_FACTOR fills any gap. All days are looked up at once.
 */
export async function pickHotels(days, hotelsByDay, driveLookup) {
  const jobs = days.map((day, i) => {
    if (day.hotel === undefined) day.hotel = null;
    if (day.alt_hotels === undefined) day.alt_hotels = [];
    const rec = nightAnchor(day);
    if (rec === null) return null;
    const nxt = morningAnchor(i + 1 < days.length ? days[i + 1] : null);
    const hotels = i < hotelsByDay.length && hotelsByDay[i] ? hotelsByDay[i] : [];
    const cands = hotelCandidates(hotels, rec);
    const pairs = cands.map((h) => [rec, point(h)]);
    if (nxt) pairs.push(...cands.map((h) => [point(h), nxt]));
    return { rec, nxt, cands, pairs };
  });
  const miles = await Promise.all(jobs.map(async (job) => {
    if (!job || !job.pairs.length) return [];
    let results = null;
    try { results = await driveLookup(job.pairs.map(([o, d]) => ({ olat: o[0], olon: o[1], dlat: d[0], dlon: d[1] }))); } catch { results = null; }
    return roadMilesFrom(results, job.pairs);
  }));
  days.forEach((day, i) => {
    const job = jobs[i];
    if (!job) return;
    const ranked = scoreHotels(job.cands, job.rec, job.nxt, miles[i]);
    const repeat = multiNight(i > 0 ? days[i - 1] : null, job.rec, ranked);
    if (repeat) {
      day.hotel = { ...repeat, why: 'second night, same hotel (ramps are close together)' };
      day.alt_hotels = ranked.filter((h) => !samePoi(h, repeat)).slice(0, C.HOTEL_ALTERNATES);
    } else if (ranked.length) {
      day.hotel = ranked[0];
      day.alt_hotels = ranked.slice(1, 1 + C.HOTEL_ALTERNATES);
    }
  });
  return days;
}

/* ── Request parsing ── */
class PlanError extends Error {}

function numberField(req, key, def, low, high, label) {
  const raw = req[key];
  let value;
  if (raw === null || raw === undefined || raw === '') value = Number(def);
  else if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'boolean') value = Number(raw);
  else if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw.trim()))) value = Number(raw.trim());
  else throw new PlanError(`${label} must be a number`);
  if (!(low <= value && value <= high)) throw new PlanError(`${label} must be between ${fmtG(low)} and ${fmtG(high)}`);
  return value;
}
function startMinutes(t) {
  if (t === null || t === undefined || t === '') return C.DAY_START_MIN;
  const parts = String(t).trim().split(':').slice(0, 2);
  const intRe = /^\s*[+-]?\d+\s*$/;
  if (parts.length !== 2 || !intRe.test(parts[0]) || !intRe.test(parts[1])) throw new PlanError('Start time must look like 06:00');
  const value = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  if (!(value >= 0 && value < 24 * 60)) throw new PlanError('Start time must look like 06:00');
  return value;
}
function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}
const isoOf = (d) => d.toISOString().slice(0, 10);

/** Validate and normalise the plan request. Throws PlanError. */
export function parseRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new PlanError('Request body must be an object');
  let rawIds = req.aid_ids || [];
  if (typeof rawIds === 'string') rawIds = Array.from(rawIds);
  if (!Array.isArray(rawIds)) rawIds = [];
  const ids = rawIds.filter((i) => /^\d+$/.test(String(i).trim().replace(/^-+/, ''))).map((i) => parseInt(String(i).trim(), 10));
  if (!ids.length) throw new PlanError('Select at least one aid');
  const start = parseIsoDate(String(req.start_date || todayIso()));
  if (!start) throw new PlanError('start_date must be YYYY-MM-DD');
  const fuel = req.fuel_gph;
  const daysRaw = 'days' in req ? req.days : '';
  const autoDays = ['', '0', 'auto'].includes(String(daysRaw === null ? 'None' : daysRaw).trim().toLowerCase());
  const name = String(req.name || 'Trip').trim() || 'Trip';
  const days = autoDays ? null : Math.trunc(numberField(req, 'days', 1, 1, C.TRIP_MAX_DAYS, 'Days'));
  const startMin = startMinutes(req.start_time);
  const tank = req.tank_gal !== null && req.tank_gal !== undefined && req.tank_gal !== '' ? numberField(req, 'tank_gal', 0, 0, 1000, 'Fuel tank (gal)') : null;
  const speed = numberField(req, 'speed_mph', C.TRIP_DEFAULT_SPEED_MPH, C.TRIP_SPEED_MIN_MPH, C.TRIP_SPEED_MAX_MPH, 'Speed (mph)');
  const maxHours = numberField(req, 'max_hours', C.TRIP_DEFAULT_MAX_HOURS, C.TRIP_MAX_HOURS_MIN, C.TRIP_MAX_HOURS_MAX, 'Max hours');
  const depart = point(req.depart);
  const lodging = (Array.isArray(req.lodging) ? req.lodging : []).map(String);
  const workDefault = Math.trunc(numberField(req, 'work_min_default', C.TRIP_DEFAULT_WORK_MIN, C.TRIP_WORK_MIN_MIN, C.TRIP_WORK_MIN_MAX, 'Default work minutes'));
  const fuelGph = fuel !== null && fuel !== undefined && fuel !== '' ? numberField(req, 'fuel_gph', 0, 0, 100, 'Fuel burn (gal/h)') : null;
  return { name, aid_ids: ids, days, start_min: startMin, tank_gal: tank, speed, max_hours: maxHours, start, depart,
    lodging: lodging.length ? lodging : null, work_default: workDefault, fuel_gph: fuelGph, stop_by_type: Boolean(req.stop_by_type) };
}

/** Days = Auto: the fewest days whose on-water hours (before ramps) all fit the daily limit. */
export function autoDays(aids, params) {
  const tort = tortuosity(aids);
  const top = Math.min(aids.length, C.TRIP_AUTO_MAX_DAYS);
  for (let k = 1; k <= top; k++) {
    const sections = splitDays(aids, k, params.speed, params.max_hours, params.depart, params.work_default);
    if (sections.every((sec) => dayHours(sec, params.speed, tort, params.work_default) <= params.max_hours * 0.92)) return k;
  }
  return top;
}

/* ── Degrader: optional external calls collect warnings instead of failing ── */
class Degrader {
  constructor() { this.warnings = []; }
  async run(label, fn, def, timeoutMs, ...args) {
    let timer = null;
    try {
      const work = Promise.resolve().then(() => fn(...args));
      const limit = timeoutMs ? new Promise((_, reject) => {
        timer = setTimeout(() => { const e = new Error(`${label} timed out`); e.name = 'TimeoutError'; reject(e); }, timeoutMs);
      }) : null;
      const result = await (limit ? Promise.race([work, limit]) : work);
      return result === null || result === undefined ? def : result;
    } catch (err) {
      console.warn?.(`[lightkeeper] ${label} failed:`, err?.message || err);
      this.warnings.push(`${label} unavailable (the map servers did not answer)`);
      return def;
    } finally { if (timer) clearTimeout(timer); }
  }
}

function dayDates(start, n) {
  return range(0, n).map((i) => isoOf(new Date(start.getTime() + i * 86400000)));
}

/* ── Rendering ── */
function slimAid(a, arriveMin, workDefault) {
  const keys = ['objectid', 'aidname', 'lightlistnumber', 'latitude', 'longitude', 'aid_type', 'characteristics', 'waterway'];
  const out = {};
  for (const k of keys) out[k] = a[k] ?? null;
  return { ...out, work_min: workMinutes(a, workDefault), arrive_min: arriveMin };
}
function windKt(wx, dayDate) {
  const periods = wx.periods || [];
  const todays = periods.filter((p) => String(p.startTime ?? '').startsWith(dayDate));
  let best = 0.0;
  for (const p of (todays.length ? todays : periods)) {
    const speeds = (String(p.windSpeed || '').match(/\d+/g) || []).map(Number);
    if (speeds.length) best = Math.max(best, Math.max(...speeds) / C.NM_TO_MI);
  }
  return best;
}
function dayWarnings(d, params) {
  const tag = `Day ${d.day}`;
  const out = [];
  if (d.stats.total_hrs > params.max_hours) out.push(`${tag}: ${pyFloat(d.stats.total_hrs)} h exceeds the ${fmtG(params.max_hours)} h cap`);
  for (const which of ['launch', 'recover']) {
    const ramp = d[which]; const anchor = which === 'launch' ? d.aids[0] : d.aids[d.aids.length - 1];
    if (!ramp || distPt(anchor, point(ramp)) > C.RAMP_NO_RAMP_WARN_MI) out.push(`${tag}: no ${which === 'launch' ? 'launch' : 'recovery'} ramp within ${C.RAMP_NO_RAMP_WARN_MI} mi`);
  }
  if (!d.hotel) out.push(`${tag}: no hotel found`);
  const tank = params.tank_gal; const fuel = d.stats.fuel_gal;
  if (tank && fuel && fuel > tank) out.push(`${tag}: needs about ${fmtG(fuel)} gal of fuel but the tank holds ${fmtG(tank)} gal - plan a fuel stop`);
  if (d.stats.legs_mi.some((leg) => leg > C.LEG_WARN_MI)) out.push(`${tag}: a leg between aids is longer than ${C.LEG_WARN_MI} mi`);
  for (const alert of (d.weather || {}).alerts || []) {
    const headline = alert && typeof alert === 'object' ? (alert.headline || alert.event) : String(alert);
    out.push(`${tag}: weather alert - ${headline ?? 'None'}`);
  }
  const wind = windKt(d.weather || {}, d.date);
  if (wind > C.WIND_WARN_KT) out.push(`${tag}: forecast wind up to ${pyFixed(wind, 0)} kt`);
  return out;
}
function boundaryPair(prev, cur) {
  const pairs = [];
  for (const a of [prev[0], prev[prev.length - 1]]) for (const b of [cur[0], cur[cur.length - 1]]) pairs.push([a, b]);
  return argMin(pairs, ([a, b]) => dist(a, b));
}
function splitReason(prev, cur) {
  const [a, b] = boundaryPair(prev.aids, cur.aids);
  if (waterway(a).toLowerCase() !== waterway(b).toLowerCase()) return `it starts a new waterway (${waterway(b) || 'unnamed'})`;
  const gap = dist(a, b);
  if (gap >= C.OUTLIER_LEG_MI) return `a ${pyFixed(gap, 1)} mi gap separates it from day ${prev.day}`;
  return `it balances hours with day ${prev.day}`;
}
function dayNotes(d, prev, params) {
  const a = d.aids; const s = d.stats;
  const ways = [...new Set(a.map(waterway).filter(Boolean))].sort();
  const notes = [`${a.length} aids on ${ways.join(', ') || 'unnamed water'} from ${aidName(a[0])} to ${aidName(a[a.length - 1])}: `
    + `${pyFloat(s.water_mi)} water mi, ${pyFloat(s.work_hrs)} h of work, ${pyFloat(s.total_hrs)} h total, done about ${s.finish_time}.`];
  if (prev) notes.push(`Split here because ${splitReason(prev, d)}.`);
  for (const [which, label] of [['launch', 'Launch'], ['recover', 'Recover']]) {
    const ramp = d[which];
    notes.push(ramp ? `${label} at ${ramp.name} (${get(ramp, 'why') !== undefined ? ramp.why : 'nearest usable ramp'}).` : `${label}: no usable ramp found nearby; check the map.`);
  }
  notes.push(...(d.notes || []));
  if (d.hotel) notes.push(`Hotel: ${d.hotel.name} - ${get(d.hotel, 'why') !== undefined ? d.hotel.why : 'nearest to the recovery ramp'}.`);
  if (s.total_hrs > params.max_hours) notes.push('This day runs long; consider adding a day or trimming aids.');
  return notes;
}
function totals(days) {
  const drive = sum(days.map((d) => (d.drive.morning_mi || 0) + (d.drive.evening_mi || 0)));
  const fuel = days.map((d) => d.stats.fuel_gal).filter((f) => f !== null && f !== undefined);
  return {
    aids: sum(days.map((d) => d.aids.length)), days: days.length,
    water_mi: pyRound(sum(days.map((d) => d.stats.water_mi)), 1),
    drive_mi: pyRound(drive, 1),
    hours: pyRound(sum(days.map((d) => d.stats.total_hrs)), 1),
    work_hrs: pyRound(sum(days.map((d) => d.stats.work_hrs)), 1),
    travel_hrs: pyRound(sum(days.map((d) => d.stats.travel_hrs)), 1),
    fuel_gal: fuel.length ? pyRound(sum(fuel), 1) : null,
  };
}
const STAT_KEYS = ['water_mi', 'travel_hrs', 'work_hrs', 'total_hrs', 'fuel_gal', 'finish_time', 'legs_mi', 'legs_est', 'to_first_mi', 'from_last_mi', 'start_time'];
function renderDay(d, prev, params) {
  const arrivals = d.stats.arrive_min;
  return {
    day: d.day, date: d.date,
    aids: d.aids.map((a, i) => slimAid(a, arrivals[i], params.work_default)),
    launch: d.launch ?? null, recover: d.recover ?? null, hotel: d.hotel ?? null,
    alt_launches: d.alt_launches || [], alt_recovers: d.alt_recovers || [], alt_hotels: d.alt_hotels || [],
    stats: Object.fromEntries(STAT_KEYS.map((k) => [k, d.stats[k]])),
    drive: d.drive, weather: d.weather || {}, tides: d.tides ?? null,
    notes: dayNotes(d, prev, params),
  };
}

/* ── Orchestration ── */
const T = { aids: 90000, pois: 45000, barriers: 30000, env: 25000, drives: 40000, waterway: 20000 };

function attachDrives(days, params, results, pairs, slots) {
  slots.forEach(([d, key], n) => {
    const [o, t] = pairs[n];
    const r = n < results.length && results[n] && typeof results[n] === 'object' ? results[n] : {};
    const base = key.slice(0, -3);
    if (r.ok && r.distance_mi !== null && r.distance_mi !== undefined) {
      const mi = Number(r.distance_mi);
      d.drive[key] = pyRound(mi, 1);
      d.drive[`${base}_min`] = pyRound(Number(r.duration_min || 0)) || pyRound(mi / C.DRIVE_FALLBACK_MPH * 60);
      d.drive[`${base}_est`] = false;
    } else {
      const miles = distPts(o, t) * C.ROAD_FACTOR;
      d.drive[key] = pyRound(miles, 1);
      d.drive[`${base}_min`] = pyRound(miles / C.DRIVE_FALLBACK_MPH * 60);
      d.drive[`${base}_est`] = true;
    }
  });
}

/**
 * Build a complete multi-day plan from data hooks (all may be async; any may throw or be missing):
 *   loadAids(ids) -> [aid], fetchRamps(lat, lon) -> [poi], fetchHotels(lat, lon, types, date) -> [poi],
 *   fetchBarriers(aids) -> [{lat, lon, name, kind}], fetchWeather(lat, lon) -> {}, fetchTides(lat, lon, date) -> {}|null,
 *   waterwayDists(aids) -> [miles|null] | null, driveBatch(pairs) -> [{ok, distance_mi, duration_min}].
 * Returns {ok:false, error} for bad input; never throws.
 */
export async function planWithData(req, hooks = {}) {
  let params;
  try { params = parseRequest(req); } catch (err) { return { ok: false, error: err.message }; }
  const deg = new Degrader();
  const h = { loadAids: async () => [], fetchRamps: async () => [], fetchHotels: async () => [], fetchBarriers: async () => [],
    fetchWeather: async () => ({}), fetchTides: async () => null, waterwayDists: async () => null, driveBatch: async () => [], ...hooks };
  const loaded = await deg.run('Aid lookup', h.loadAids, [], T.aids, params.aid_ids);
  let aids = (Array.isArray(loaded) ? loaded : []).filter((a) => point(a));
  if (!aids.length) return { ok: false, error: 'None of the selected aids could be loaded' };
  // the one stop time the user typed applies to every aid unless stops vary by type
  if (!params.stop_by_type) aids = aids.map((a) => ({ ...a, _stop_min: params.work_default }));
  const auto = params.days === null;
  if (auto) params.days = autoDays(aids, params);
  const sections = splitDays(aids, params.days, params.speed, params.max_hours, params.depart, params.work_default);
  if (sections.length < params.days && !auto) deg.warnings.push(`Only ${sections.length} day(s) could be formed from ${aids.length} aids`);
  const dates = dayDates(params.start, sections.length);

  // Everything that only needs the sections starts now, in parallel.
  const cents = sections.map(centroidOf);
  const rampsP = Promise.all(cents.map((c, i) => deg.run(`Day ${i + 1} ramps`, h.fetchRamps, [], T.pois, c[0], c[1])));
  const hotelsP = Promise.all(cents.map((c, i) => deg.run(`Day ${i + 1} hotels`, h.fetchHotels, [], T.pois, c[0], c[1], params.lodging, dates[i])));
  const barriersP = deg.run('Barrier lookup', h.fetchBarriers, [], T.barriers, sections.flat());
  const wxP = Promise.all(cents.map((c, i) => deg.run(`Day ${i + 1} weather`, h.fetchWeather, {}, T.env, c[0], c[1])));
  const tidesP = Promise.all(cents.map((c, i) => deg.run(`Day ${i + 1} tides`, h.fetchTides, null, T.env, c[0], c[1], dates[i])));
  const [ramps, hotels, barriers] = await Promise.all([rampsP, hotelsP, barriersP]);

  const days = sections.map((sec, i) => {
    const picked = pickRamps(sec, ramps[i] || [], barriers || []);
    return { day: i + 1, date: dates[i], aids: picked.aids, launch: picked.launch, recover: picked.recover,
      alt_launches: picked.alt_launches, alt_recovers: picked.alt_recovers, hotel: null, alt_hotels: [], notes: [] };
  });
  chainDays(days, params.speed);
  const dists = await Promise.all(days.map((d) => deg.run(`Day ${d.day} waterway distances`, h.waterwayDists, null, T.waterway, d.aids)));
  days.forEach((d, i) => {
    d.stats = dayStats(d.aids, params.speed, d.launch, d.recover, dists[i], params.fuel_gph, params.start_min, params.work_default);
    d.waterway_real = Boolean(dists[i] && dists[i].some((x) => x !== null && x !== undefined));
  });
  await pickHotels(days, hotels.map((list) => (list || []).filter((x) => !isHostel(x))), (p) => deg.run('Hotel road distances', h.driveBatch, [], T.drives, p));
  const [wx, tides] = await Promise.all([wxP, tidesP]);
  days.forEach((d, i) => { d.weather = wx[i]; d.tides = tides[i]; });

  const pairs = []; const slots = [];
  days.forEach((d, i) => {
    const origin = i > 0 ? point(days[i - 1].hotel) : params.depart;
    const launch = morningAnchor(d); const rec = nightAnchor(d); const hotel = point(d.hotel);
    d.drive = { morning_mi: null, evening_mi: null };
    if (origin && launch) { pairs.push([origin, launch]); slots.push([d, 'morning_mi']); }
    if (rec && hotel) { pairs.push([rec, hotel]); slots.push([d, 'evening_mi']); }
  });
  const results = pairs.length ? await deg.run('Drive distances', h.driveBatch, [], T.drives, pairs.map(([o, t]) => ({ olat: o[0], olon: o[1], dlat: t[0], dlon: t[1] }))) : [];
  attachDrives(days, params, Array.isArray(results) ? results : [], pairs, slots);

  const warnings = [...deg.warnings];
  for (const d of days) warnings.push(...dayWarnings(d, params));
  const rendered = days.map((d, i) => renderDay(d, i > 0 ? days[i - 1] : null, params));
  return { ok: true, name: params.name, start_date: isoOf(params.start), speed_mph: params.speed, max_hours: params.max_hours, auto_days: auto,
    fuel_gph: params.fuel_gph, tank_gal: params.tank_gal, work_min: params.work_default, start_time: clock(params.start_min),
    days: rendered, totals: totals(days), warnings };
}

/* ── Browser data hooks ── */
const OSRM_URL = 'https://router.project-osrm.org';
const OSRM_PAIR_TIMEOUT_MS = 8000;
const OSRM_CONCURRENCY = 4;
const OSRM_TABLE_MAX = 50;
const ROUTE_TTL = 30 * DAY;
const routeKey = (p) => `osrm:${p.olat.toFixed(4)},${p.olon.toFixed(4)};${p.dlat.toFixed(4)},${p.dlon.toFixed(4)}`;
const okRoute = (meters, seconds) => (meters === null || meters === undefined ? { ok: false, error: 'No route' }
  : { ok: true, distance_mi: meters / METERS_PER_MILE, duration_min: seconds != null ? seconds / 60 : null });

async function runLimited(jobs, limit) {
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const job = jobs[next++]; await job(); } };
  await Promise.all(range(0, Math.min(limit, jobs.length)).map(worker));
}

/** Road distances for [{olat, olon, dlat, dlon}] from the public OSRM server. Pairs sharing an origin or a
 *  destination go in one table request; the rest use the route service. Cached 30 days; never throws. */
export async function driveBatch(pairs, budgetMs = T.drives - 2000) {
  const deadline = Date.now() + budgetMs;
  const head = pairs.slice(0, C.MAX_ROUTE_BATCH_PAIRS);
  const out = head.map(() => null);
  const keys = head.map(routeKey);
  await Promise.all(head.map(async (p, i) => {
    try { const { value } = await cached(keys[i], ROUTE_TTL, () => { throw new Error('miss'); }); if (value) out[i] = value; } catch { /* not cached */ }
  }));
  const todo = range(0, head.length).filter((i) => !out[i]);
  const ptKey = (la, lo) => `${la},${lo}`;
  const groupBy = (idx, fn) => { const g = new Map(); for (const i of idx) { const k = fn(head[i]); if (!g.has(k)) g.set(k, []); g.get(k).push(i); } return g; };
  const jobs = []; const left = new Set(todo);
  const remember = (i, r) => { out[i] = r; if (r.ok) cached(keys[i], ROUTE_TTL, async () => r).catch(() => {}); };
  const timeLeft = () => Math.min(OSRM_PAIR_TIMEOUT_MS, deadline - Date.now());
  const addTable = (idx, fromOrigin) => {
    for (let s = 0; s < idx.length; s += OSRM_TABLE_MAX) {
      const chunk = idx.slice(s, s + OSRM_TABLE_MAX);
      chunk.forEach((i) => left.delete(i));
      jobs.push(async () => {
        if (timeLeft() <= 0) return;
        const p0 = head[chunk[0]];
        const others = chunk.map((i) => (fromOrigin ? [head[i].dlon, head[i].dlat] : [head[i].olon, head[i].olat]));
        const fixed = fromOrigin ? [p0.olon, p0.olat] : [p0.dlon, p0.dlat];
        const coords = (fromOrigin ? [fixed, ...others] : [...others, fixed]).map(([x, y]) => `${x},${y}`).join(';');
        const n = chunk.length;
        const q = fromOrigin ? `sources=0&destinations=${range(1, n + 1).join(';')}` : `sources=${range(0, n).join(';')}&destinations=${n}`;
        try {
          const data = await getJson(`${OSRM_URL}/table/v1/driving/${coords}?${q}&annotations=distance,duration`, { timeoutMs: timeLeft() });
          chunk.forEach((i, j) => {
            const m = fromOrigin ? data.distances?.[0]?.[j] : data.distances?.[j]?.[0];
            const sec = fromOrigin ? data.durations?.[0]?.[j] : data.durations?.[j]?.[0];
            remember(i, okRoute(m, sec));
          });
        } catch (err) { console.debug?.('[lightkeeper] OSRM table failed:', err?.message); }
      });
    }
  };
  for (const [, idx] of groupBy(todo, (p) => ptKey(p.olat, p.olon))) if (idx.length > 1) addTable(idx, true);
  for (const [, idx] of groupBy([...left], (p) => ptKey(p.dlat, p.dlon))) if (idx.length > 1) addTable(idx, false);
  for (const i of left) {
    jobs.push(async () => {
      if (timeLeft() <= 0) return;
      const p = head[i];
      try {
        const data = await getJson(`${OSRM_URL}/route/v1/driving/${p.olon},${p.olat};${p.dlon},${p.dlat}?overview=false`, { timeoutMs: timeLeft() });
        const r = data.code === 'Ok' && data.routes?.[0] ? data.routes[0] : null;
        remember(i, r ? okRoute(r.distance, r.duration) : { ok: false, error: data.code || 'No route' });
      } catch (err) { out[i] = { ok: false, error: err?.message || 'Routing failed' }; }
    });
  }
  await runLimited(jobs, OSRM_CONCURRENCY);
  return [...out.map((r) => r || { ok: false, error: 'Routing unavailable' }), ...pairs.slice(C.MAX_ROUTE_BATCH_PAIRS).map(() => ({ ok: false, error: 'Batch limit exceeded' }))];
}

async function loadAidsWeb(ids) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return [];
  const firstAid = await aidsData.getAid(wanted[0]);   // loads the tables once; the rest are memory lookups
  const rest = await Promise.all(wanted.slice(1).map((id) => aidsData.getAid(id).catch(() => null)));
  return [firstAid, ...rest].filter(Boolean);
}

async function barriersWeb(aids) {
  const [s, w, n, e] = bboxOf(aids);
  const pad = C.BARRIER_BBOX_PADDING;
  const dams = await water.stationsInBbox([s - pad, w - pad, n + pad, e + pad], ['dam']);
  return (dams || []).filter((d) => point(d)).map((d) => ({ lat: d.lat, lon: d.lon, name: d.name || '', kind: 'dam' }));
}

/** Tide detail for the nearest NOAA tide station within 50 mi, or null. */
async function tidesWeb(la, lo, day) {
  const stations = await water.stationsInBbox(bboxAround(la, lo, C.TIDE_STATION_MAX_MI * METERS_PER_MILE), ['tide']);
  const station = nearestK(la, lo, stations || [], C.TIDE_STATION_MAX_MI, 1)[0];
  if (!station) return null;
  const detail = await water.stationDetail(station.id, day);
  if (!detail?.ok) return null;
  return { ...detail, poi: station, distance_mi: station.distance_mi };
}

const WEB_HOOKS = {
  loadAids: loadAidsWeb,
  fetchRamps: (la, lo) => poi.fetchRamps(la, lo, C.TRIP_RAMP_RADIUS_M),
  fetchHotels: async (la, lo, types) => (await poi.fetchHotels(la, lo, C.TRIP_HOTEL_RADIUS_M, types)).filter((x) => !isHostel(x)),
  fetchBarriers: barriersWeb,
  fetchWeather: (la, lo) => weather.getForecast(la, lo),
  fetchTides: tidesWeb,
  waterwayDists: async () => null,      // no water routing on the web: straight line x tortuosity
  driveBatch: (pairs) => driveBatch(pairs),
};

/** POST /api/trip/plan in the browser. Same plan JSON as the desktop app. */
export async function planTrip(req) {
  try {
    return await planWithData(req, WEB_HOOKS);
  } catch (err) {
    console.warn('[lightkeeper] Trip planning failed:', err);
    return { ok: false, error: `Planning failed: ${err?.message || err}` };
  }
}
