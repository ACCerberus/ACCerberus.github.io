/** Web edition of /api/bnm: the hourly-published lightkeeper/data/bnm-D<id>.json (tools/build_bnm.py), with
 *  "active" recomputed here so notices expire on time between updates. All nine districts. */

import { staticJson } from './aids.js?v=2.1.3';

const DISTRICTS = [1, 5, 7, 8, 9, 11, 13, 14, 17];
const TTL = 10 * 60 * 1000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dtgToDate(dtg) {
  const m = /^(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{2})/.exec(String(dtg || '').toUpperCase());
  if (!m || !MONTHS.includes(m[4])) return null;
  return new Date(Date.UTC(2000 + Number(m[5]), MONTHS.indexOf(m[4]), Number(m[1]), Number(m[2]), Number(m[3])));
}

const MAX_OPEN_DAYS = 180;   // same rule as tools/bnm.py mark_active
function markActive(items, now = new Date()) {
  const cancelled = new Set();
  for (const i of items) if (i.category === 'CANCELLATION') { cancelled.add(i.id); if (i.cancels) cancelled.add(i.cancels); }
  for (const i of items) {
    let expires = i.cancel_at ? dtgToDate(i.cancel_at) : null;
    if (!expires && i.published && (now - new Date(i.published)) / 864e5 > MAX_OPEN_DAYS) expires = now;
    i.active = ['SAFETY', 'UPDATE'].includes(i.category) && !cancelled.has(i.id) && (!expires || expires > now);
  }
  return items;
}

export async function list(params = {}) {
  const district = Number(params.district);
  if (!DISTRICTS.includes(district)) {
    return { ok: false, district, items: [], error: `No broadcast notice feeds known for district ${params.district ?? "(none)"}` };
  }
  const data = await staticJson(`bnm-D${district}.json`, TTL, { fresh: !!params.refresh }).catch(() => null);
  if (!data?.items) return { ok: false, district, items: [], error: 'Broadcast notices are not published yet' };
  return { ok: true, district, items: markActive(data.items), fetched_at: data.fetched_at };
}
