/** Browser-edition helpers shared by the data adapters (mirrors geo.py + small bits of poi.py). */

import { haversineMi } from '../geo.js?v=2.0.9c';

export const METERS_PER_MILE = 1609.344;
export const METERS_TO_FEET = 3.28084;

export { haversineMi };

export function validateCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** Rough US-territory check (CONUS, Alaska, Hawaii, Puerto Rico, Guam). */
export function isInUs(lat, lon) {
  const boxes = [
    [24.0, 49.0, -125.5, -66.5], [51.0, 72.0, -180.0, -130.0], [18.5, 22.5, -160.5, -154.5],
    [17.5, 18.7, -67.5, -65.5], [13.0, 14.0, 144.0, 145.5],
  ];
  return boxes.some(([s, n, w, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
}

/** (south, west, north, east) around a point. */
export function bboxAround(lat, lon, radiusM) {
  const dlat = radiusM / 111320;
  const dlon = radiusM / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return [lat - dlat, lon - dlon, lat + dlat, lon + dlon];
}

/** 's,w,n,e' → [s, w, n, e] or null. */
export function parseBbox(text) {
  const parts = String(text || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [s, w, n, e] = parts;
  if (!validateCoords(s, w) || !validateCoords(n, e) || s > n) return null;
  return [s, w, n, e];
}

export const inBbox = (lat, lon, [s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e;

/** US phone → '+1 ###-###-####' or ''. */
export function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return '';
  return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function toNumber(raw) {
  if (raw === null || raw === undefined || raw === '' || String(raw) === '-999999') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export const round = (v, dp = 1) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
export const cToF = (c) => round((c * 9) / 5 + 32, 1);
export const fToC = (f) => round(((f - 32) * 5) / 9, 1);

export function latLonArgs(params) {
  const lat = Number(params?.lat); const lon = Number(params?.lon);
  return validateCoords(lat, lon) ? [lat, lon] : null;
}

export function first(obj, ...keys) {
  for (const k of keys) { const v = obj?.[k]; if (v) return String(v).trim(); }
  return '';
}

export function formatAddress(houseNumber, road, town, state, postcode) {
  const street = [houseNumber, road].filter(Boolean).join(' ').trim();
  const region = [state, postcode].filter(Boolean).join(' ').trim();
  return [street, town, region].filter(Boolean).join(', ');
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function compassPoint(deg) {
  if (deg == null) return '';
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.floor((Number(deg) + 11.25) / 22.5) % 16];
}

/** Up to k closest records within maxMi, copied with distance_mi. */
export function nearestK(lat, lon, pois, maxMi, k, excludeId = '') {
  return pois.filter((p) => p.id !== excludeId)
    .map((p) => ({ ...p, distance_mi: round(haversineMi(lat, lon, p.lat, p.lon), 1) }))
    .filter((p) => p.distance_mi < maxMi)
    .sort((a, b) => a.distance_mi - b.distance_mi)
    .slice(0, k);
}
export const nearest = (lat, lon, pois, maxMi) => nearestK(lat, lon, pois, maxMi, 1)[0] || null;

/** Run async jobs in parallel; a failing job yields `fallback` instead of rejecting. */
export async function settle(jobs, fallback) {
  const out = {};
  await Promise.all(Object.entries(jobs).map(async ([name, fn]) => {
    try { out[name] = await fn(); } catch (err) { console.debug(`[lightkeeper] ${name} failed:`, err?.message || err); out[name] = fallback; }
  }));
  return out;
}
