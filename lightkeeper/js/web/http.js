/** Outbound HTTP for the browser edition: JSON GET with timeout, Overpass mirror racing and the
 *  Nominatim 1-request-per-second throttle (the usage policy; the browser supplies the Referer). */

import { cached, DAY } from './store.js?v=2.0.9';

export const OVERPASS_SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const NOMINATIM_THROTTLE_MS = 1100;
const OVERPASS_TTL = 7 * DAY;

export async function getJson(url, { timeoutMs = 10000, headers, method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method, headers, body, signal: ctrl.signal });
    if (!resp.ok) { const err = new Error(`HTTP ${resp.status}`); err.status = resp.status; throw err; }
    return await resp.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally { clearTimeout(timer); }
}

export const qs = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/* ── Nominatim (search | reverse), serialised at ≤ 1 request per second ── */
let nominatimChain = Promise.resolve();
let nominatimNextOk = 0;
export function nominatimGet(endpoint, params) {
  const run = async () => {
    const wait = Math.max(0, nominatimNextOk - Date.now());
    nominatimNextOk = Math.max(Date.now(), nominatimNextOk) + NOMINATIM_THROTTLE_MS;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return getJson(`${NOMINATIM_URL}/${endpoint}?${qs(params)}`, { timeoutMs: 10000 });
  };
  const p = nominatimChain.then(run, run);
  nominatimChain = p.catch(() => {});
  return p;
}

/* ── Overpass: race the mirrors, cache results for 7 days ── */
async function hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function raceMirrors(query, timeoutMs) {
  return new Promise((resolve, reject) => {
    let pending = OVERPASS_SERVERS.length;
    let settled = false;
    const ctrls = [];
    for (const server of OVERPASS_SERVERS) {
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      fetch(server, { method: 'POST', body: `data=${encodeURIComponent(query)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((data) => {
          if (settled) return;
          settled = true;
          ctrls.forEach((c) => c !== ctrl && c.abort());
          resolve(data);
        })
        .catch((err) => {
          if (settled) return;
          if (--pending === 0) reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => clearTimeout(timer));
    }
  });
}

/** Overpass QL → parsed JSON; `{elements: []}` when every mirror fails and nothing is cached. */
export async function overpass(query, timeoutS = 25) {
  const key = `overpass:${await hash(query)}`;
  try {
    const { value } = await cached(key, OVERPASS_TTL, () => raceMirrors(query, (timeoutS + 5) * 1000));
    return value || { elements: [] };
  } catch (err) {
    console.warn('[lightkeeper] Overpass unavailable:', err?.message || err);
    return { elements: [], unavailable: true };
  }
}
