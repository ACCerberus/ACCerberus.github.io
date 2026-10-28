/** Client-side geo math (mirrors geo.py). Keep this the only place these formulas live in the frontend. */

const R_NM = 3440.065;
export const NM_TO_MI = 1.15078;
export const NM_TO_KM = 1.852;

export function haversineNM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1); const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
export const haversineMi = (a, b, c, d) => haversineNM(a, b, c, d) * NM_TO_MI;

export function trueBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(lat1); const p2 = toRad(lat2); const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function formatDistance(nm, unit) {
  if (unit === 'mi') return `${(nm * NM_TO_MI).toFixed(2)} mi`;
  if (unit === 'km') return `${(nm * NM_TO_KM).toFixed(2)} km`;
  return `${nm.toFixed(2)} NM`;
}
