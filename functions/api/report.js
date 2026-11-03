// "Something's wrong" reports from LightKeeper cards (web app and Windows app) -> Cloudflare KV.
//
// POST /api/report  {kind, id, name, lat, lon, text, version}   -> {ok:true}
// GET  /api/report?token=...                                    -> the newest 200 reports (for the developer)
//
// Setup (once, in the Cloudflare dashboard, Pages project > Settings):
//   1. Workers & Pages > KV > create a namespace, e.g. "lightkeeper-reports".
//   2. Pages project > Settings > Bindings > add a KV binding named REPORTS to that namespace.
//   3. Pages project > Settings > Variables > add a secret REPORTS_TOKEN (any long random string) to read reports.
// Until REPORTS is bound, POST answers 503 and the app tells the user to use "Report a bug" instead.
// Stored per report: what the user typed, the place or aid, the app version and the time. No IP or personal data is
// kept; the IP is used only (hashed, for one minute) to stop floods.

const MAX_TEXT = 2000;
const CORS = {
  'Access-Control-Allow-Origin': '*',          // the Windows app posts from its own local page
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const clip = (v, n) => String(v ?? '').slice(0, n);

async function hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.REPORTS) return json({ ok: false, error: 'reports are not set up yet' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad request' }, 400); }
  const text = clip(body.text, MAX_TEXT).trim();
  if (text.length < 4) return json({ ok: false, error: 'say what is wrong' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const who = await hash(`${ip}|${new Date().toISOString().slice(0, 16)}`);   // changes every minute
  const recent = Number(await env.REPORTS.get(`rate:${who}`)) || 0;
  if (recent >= 5) return json({ ok: false, error: 'too many reports, try again in a minute' }, 429);
  await env.REPORTS.put(`rate:${who}`, String(recent + 1), { expirationTtl: 120 });
  const at = new Date().toISOString();
  const report = {
    at, kind: clip(body.kind, 30), id: clip(body.id, 120), name: clip(body.name, 200),
    lat: Number.isFinite(body.lat) ? Math.round(body.lat * 1e5) / 1e5 : null,
    lon: Number.isFinite(body.lon) ? Math.round(body.lon * 1e5) / 1e5 : null,
    text, version: clip(body.version, 20), app: (request.headers.get('Origin') || '').includes('cerberusac.dev') ? 'web' : 'windows',
  };
  // Newest first when listed: keys sort by inverted time.
  const key = `report:${String(9e15 - Date.now()).padStart(16, '0')}:${crypto.randomUUID().slice(0, 8)}`;
  await env.REPORTS.put(key, JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 365 });
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get('token') || '';
  if (!env.REPORTS || !env.REPORTS_TOKEN || token !== env.REPORTS_TOKEN) return json({ ok: false, error: 'not allowed' }, 403);
  const list = await env.REPORTS.list({ prefix: 'report:', limit: 200 });
  const reports = await Promise.all(list.keys.map(async (k) => JSON.parse(await env.REPORTS.get(k.name) || 'null')));
  return json({ ok: true, count: reports.length, reports: reports.filter(Boolean) });
}
