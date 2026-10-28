/** Web edition of /api/bnm: the hourly-published lightkeeper/data/bnm-D<id>.json (tools/build_bnm.py), with
 *  "active" recomputed here so notices expire on time between updates. Northwest only for now. */

import { staticJson } from './aids.js?v=2.1.0-4';

const DISTRICTS = [13];
const TTL = 10 * 60 * 1000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dtgToDate(dtg) {
  const m = /^(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{2})/.exec(String(dtg || '').toUpperCase());
  if (!m || !MONTHS.includes(m[4])) return null;
  return new Date(Date.UTC(2000 + Number(m[5]), MONTHS.indexOf(m[4]), Number(m[1]), Number(m[2]), Number(m[3])));
}

function markActive(items, now = new Date()) {
  const cancelled = new Set(items.filter((i) => i.category === 'CANCELLATION' && i.cancels).map((i) => i.cancels));
  for (const i of items) {
    const expires = i.cancel_at ? dtgToDate(i.cancel_at) : null;
    i.active = ['SAFETY', 'UPDATE'].includes(i.category) && !cancelled.has(i.id) && (!expires || expires > now);
  }
  return items;
}

export async function list(params = {}) {
  const district = Number(params.district) || 13;
  if (!DISTRICTS.includes(district)) {
    return { ok: false, district, items: [], error: 'Broadcast notices are available for the Northwest district so far; other districts are coming' };
  }
  const data = await staticJson(`bnm-D${district}.json`, params.refresh ? 1 : TTL).catch(() => null);
  if (!data?.items) return { ok: false, district, items: [], error: 'Broadcast notices are not published yet' };
  return { ok: true, district, items: markActive(data.items), fetched_at: data.fetched_at };
}
