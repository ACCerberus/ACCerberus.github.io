/** Water conditions in the browser (port of water.py): NOAA CO-OPS tide/current stations, USGS gages,
 *  dams from the USACE inventory and OpenStreetMap with live USACE CWMS readings (the CWMS Data API allows web pages), water
 *  temperature and NWS flood alerts. Same response shapes as the desktop endpoints.
 *
 *  Backup chain for tides: NOAA (requested station → ±1 day window → next-nearest station) → Open-Meteo Marine.
 *  River gauges add NOAA NWPS (flood stages, NWS forecast, a second observed stage); dams USACE has no readings for
 *  fall back to the Bureau of Reclamation's RISE API. Impossible readings are dropped first (util.js READING_LIMITS).
 *  Reclamation's PN Hydromet (used by the desktop for Grand Coulee & co.) sends no CORS header, so it is desktop-only. */

import { getJson, qs, overpass, nominatimGet } from './http.js?v=2.1.8-6';
import { cached, idbSet, MIN, HOUR, DAY } from './store.js?v=2.1.8-6';
import { nearestSaved } from './offline-store.js?v=2.1.8-6';
import { validateCoords, haversineMi, inBbox, bboxAround, nearestK, nearest, toNumber, round, cToF, fToC, normalizePhone, todayIso, settle, METERS_PER_MILE, METERS_TO_FEET, inRange, cleanStageSeries, OUT_OF_RANGE } from './util.js?v=2.1.8-6';
import { openMeteoGet, pointKey } from './weather.js?v=2.1.8-6';
import * as ndbc from './ndbc.js?v=2.1.8-6';
import { reverseGeocode } from './poi.js?v=2.1.8-6';
import { staticJson, manifest, districts as districtList } from './aids.js?v=2.1.8-6';

const NOAA_MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json';
const NOAA_DATAGETTER = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const NOAA_STATION_HOME = 'https://tidesandcurrents.noaa.gov/stationhome.html?id=';
const NOAA_CURRENT_HOME = 'https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=';
const NOAA_TIDE_DATUM = 'MLLW';
const NOAA_TIMEOUT = 12000;
const NOAA_STATION_TTL = DAY;
const USGS_IV_URL = 'https://waterservices.usgs.gov/nwis/iv/';
const USGS_SITE_HOME = 'https://waterdata.usgs.gov/monitoring-location/';
const USGS_TIMEOUT = 15000;
const P_TEMP = '00010'; const P_FLOW = '00060'; const P_GAGE = '00065';
const USGS_PARAMS = `${P_TEMP},${P_FLOW},${P_GAGE}`;
const USGS_BBOX_MAX_SQ_DEG = 25;
const OPEN_METEO_MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const OPEN_METEO_MARINE_DAYS = 2;
const WEATHER_CACHE_TTL = 30 * MIN;
const TIDE_STATION_MAX_MI = 50;
const BACKUP_STATION_TRIES = 2;
const WATER_TEMP_RADIUS_MI = 50;
const OVERPASS_TIMEOUT = 25;

export const STATION_TYPES = ['tide', 'gage', 'dam', 'current'];
const SOURCE_NOAA = 'NOAA CO-OPS';
const SOURCE_USGS = 'USGS NWIS';
const SOURCE_OSM = 'OpenStreetMap';
const SOURCE_MARINE = 'Open-Meteo Marine';
const SOURCE_MARINE_BACKUP = 'Open-Meteo Marine (backup)';
const MARINE_DATUM = 'MSL (Open-Meteo backup)';
const NOAA_PRODUCT_TYPE = { tide: 'tidepredictions', current: 'currentpredictions' };
const NOAA_PREFIX = { tide: 'noaa', current: 'noaa-cur' };
const OSM_NAME_TAGS = ['name', 'official_name', 'alt_name', 'loc_name', 'seamark:name'];
const DAM_DETAIL_KEYS = ['pool_elevation_ft', 'tailwater_ft', 'inflow_cfs', 'outflow_cfs', 'storage_acft'];

function poi(id, kind, name, lat, lon, source, { name_source = 'agency', address = '', phone = '', website = '', operator = '', tags = {}, quality = 'verified' } = {}) {
  return { id, kind, name, name_source, lat: round(Number(lat), 4), lon: round(Number(lon), 4), address, phone, website, operator, tags, quality, source };
}

const dateText = (d) => d.replace(/-/g, '');
function parseDate(text) {
  if (!text) return todayIso();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function reverseAddress(lat, lon) {
  const geo = await reverseGeocode(lat, lon);
  return geo.address || '';
}

/* ── NOAA CO-OPS stations ── */
function noaaStationPoi(station, kind) {
  const lat = toNumber(station.lat); const lon = toNumber(station.lng);
  const sid = String(station.id || '').trim();
  if (!sid || lat == null || lon == null || !validateCoords(lat, lon)) return null;
  const tags = { state: station.state || '' };
  if (kind === 'tide') tags.reference = station.type === 'R';
  if (station.currbin != null) tags.bin = String(station.currbin);
  const name = String(station.name || '').trim() || `NOAA Station ${sid}`;
  return poi(`${NOAA_PREFIX[kind]}:${sid}`, kind, name, lat, lon, SOURCE_NOAA, { operator: 'NOAA', website: `${kind === 'tide' ? NOAA_STATION_HOME : NOAA_CURRENT_HOME}${sid}`, tags });
}
const noaaMemo = new Map();
/** NOAA station list of one kind: the copy shipped with the site (built weekly), else NOAA mdapi live, else the
 *  last copy in IndexedDB. */
async function noaaStations(kind) {
  if (noaaMemo.has(kind)) return noaaMemo.get(kind);
  const p = (async () => {
    try {
      const shipped = await staticJson(`stations-${kind}.json`, NOAA_STATION_TTL);
      if (shipped?.stations?.length) return shipped.stations.map((s) => noaaStationPoi(s, kind)).filter(Boolean);
    } catch (err) { console.debug(`[lightkeeper] shipped ${kind} station list unavailable:`, err?.message); }
    try {
      const { value } = await cached(`noaa:stations:${NOAA_PRODUCT_TYPE[kind]}`, NOAA_STATION_TTL, async () => {
        const data = await getJson(`${NOAA_MDAPI}?${qs({ type: NOAA_PRODUCT_TYPE[kind], units: 'english' })}`, { timeoutMs: 30000 });
        return (data.stations || []).map((s) => noaaStationPoi(s, kind)).filter(Boolean);
      });
      return value || [];
    } catch (err) { console.warn(`[lightkeeper] NOAA ${kind} station list unavailable:`, err?.message); noaaMemo.delete(kind); return []; }
  })();
  noaaMemo.set(kind, p);
  return p;
}
const noaaCode = (p) => p.id.split(':').slice(1).join(':');
async function stationAndBackups(p, kind) {
  return [p, ...nearestK(p.lat, p.lon, await noaaStations(kind), TIDE_STATION_MAX_MI, BACKUP_STATION_TRIES, p.id)];
}
function withBackup(detail, requested, used) {
  detail.poi = requested;
  detail.backup_station = used.id !== requested.id;
  if (detail.backup_station) detail.backup_poi = used;
  return detail;
}

/* ── NOAA products ── */
async function noaaProduct(stationId, product, begin, end, extra = {}) {
  const params = { begin_date: dateText(begin), end_date: dateText(end), station: stationId, product, units: 'english', time_zone: 'lst_ldt', format: 'json', ...extra };
  if (product === 'predictions') Object.assign(params, { datum: NOAA_TIDE_DATUM, interval: 'hilo' });
  const url = `${NOAA_DATAGETTER}?${qs(params)}`;
  const key = `noaa:${product}:${stationId}:${params.begin_date}:${params.end_date}:${JSON.stringify(extra)}`;
  const { value } = await cached(key, WEATHER_CACHE_TTL, async () => {
    const data = await getJson(url, { timeoutMs: NOAA_TIMEOUT });
    if (data.error) throw new Error(data.error.message || 'NOAA error');
    return data;
  });
  return value || {};
}
/** Offline download: one request for a station's tide highs/lows over several days, stored day by day under the
 *  same keys a card uses, so the tide chart works with no signal. Returns the number of days stored. */
export async function prefetchTides(station, startDay, days = 7) {
  const code = noaaCode(station);
  const end = shiftDate(startDay, days - 1);
  const params = { begin_date: dateText(startDay), end_date: dateText(end), station: code, product: 'predictions', units: 'english', time_zone: 'lst_ldt', format: 'json', datum: NOAA_TIDE_DATUM, interval: 'hilo' };
  const data = await getJson(`${NOAA_DATAGETTER}?${qs(params)}`, { timeoutMs: NOAA_TIMEOUT });
  if (data.error || !data.predictions) return 0;
  let stored = 0;
  for (let i = 0; i < days; i += 1) {
    const day = shiftDate(startDay, i);
    const preds = data.predictions.filter((x) => String(x.t || '').startsWith(day));
    if (!preds.length) continue;
    await idbSet(`noaa:predictions:${code}:${dateText(day)}:${dateText(day)}:{}`, { predictions: preds });
    stored += 1;
  }
  return stored;
}
export const tideStations = () => noaaStations('tide');

async function noaaWaterTemp(stationId, day) {
  try {
    const readings = (await noaaProduct(stationId, 'water_temperature', day, day)).data || [];
    for (let i = readings.length - 1; i >= 0; i--) { const v = toNumber(readings[i].v); if (v != null) return [round(v, 1), readings[i].t || '']; }
  } catch { /* most tide stations have no thermometer */ }
  return [null, ''];
}
async function tidePredictions(stationId, day) {
  let data;
  try { data = await noaaProduct(stationId, 'predictions', day, day); } catch { data = await noaaProduct(stationId, 'predictions', shiftDate(day, -1), shiftDate(day, 1)); }
  const predictions = (data.predictions || []).map((p) => ({ time: p.t || '', height_ft: round(toNumber(p.v) || 0, 1), type: p.type === 'H' ? 'High' : 'Low' }));
  const sameDay = predictions.filter((p) => p.time.startsWith(day));
  return sameDay.length ? sameDay : predictions;
}
async function tideDetail(p, day) {
  for (const station of await stationAndBackups(p, 'tide')) {
    const code = noaaCode(station);
    let predictions;
    try { predictions = await tidePredictions(code, day); } catch (err) { console.debug('[lightkeeper] NOAA tide failed for', station.id, err?.message); continue; }
    const [raw, tempTime] = await noaaWaterTemp(code, day);
    const temp = raw != null && inRange('water_temp_f', raw) ? raw : null;
    return withBackup({ ok: true, date: day, predictions, water_temp_f: temp, water_temp_time: tempTime, datum: NOAA_TIDE_DATUM, source: SOURCE_NOAA, backup: false,
      water_temp_note: raw != null && temp == null ? OUT_OF_RANGE : null }, p, station);
  }
  return marineTideDetail(p, day);
}
async function currentDetail(p, day) {
  for (const station of await stationAndBackups(p, 'current')) {
    const extra = { interval: 'MAX_SLACK' };
    if (station.tags?.bin) extra.bin = station.tags.bin;
    try {
      const data = await noaaProduct(noaaCode(station), 'currents_predictions', day, day, extra);
      const predictions = (data.current_predictions?.cp || []).map((c) => ({ time: c.Time || '', type: String(c.Type || '').toLowerCase(), velocity_kt: round(toNumber(c.Velocity_Major) || 0, 2) }));
      return withBackup({ ok: true, date: day, predictions, source: SOURCE_NOAA, backup: false }, p, station);
    } catch (err) { console.debug('[lightkeeper] NOAA currents failed for', station.id, err?.message); }
  }
  return { ok: false, error: 'NOAA current predictions unavailable', poi: p };
}

/* ── Open-Meteo Marine backup ── */
async function marineHourly(lat, lon) {
  const { value } = await cached(pointKey('open-meteo-marine', lat, lon), WEATHER_CACHE_TTL, async () => {
    const hourly = (await openMeteoGet(OPEN_METEO_MARINE_URL, lat, lon, { hourly: 'sea_level_height_msl,sea_surface_temperature,wave_height', forecast_days: OPEN_METEO_MARINE_DAYS })).hourly || {};
    if (!(hourly.sea_level_height_msl || []).some((v) => v != null)) throw new Error('No Open-Meteo marine data at this point');
    return hourly;
  });
  return value || {};
}
function marineExtrema(times, heights) {
  const out = [];
  for (let i = 1; i < Math.min(times.length, heights.length) - 1; i++) {
    const [prev, cur, nxt] = [heights[i - 1], heights[i], heights[i + 1]];
    if (prev == null || cur == null || nxt == null) continue;
    let kind;
    if (cur > prev && cur >= nxt) kind = 'High'; else if (cur < prev && cur <= nxt) kind = 'Low'; else continue;
    out.push({ time: times[i].replace('T', ' '), height_ft: round(cur * METERS_TO_FEET, 1), type: kind });
  }
  return out;
}
function marineSeaTemp(hourly) {
  const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const nowText = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const readings = (hourly.time || []).map((t, i) => [t, (hourly.sea_surface_temperature || [])[i]]).filter(([, v]) => v != null);
  if (!readings.length) return [null, ''];
  const past = readings.filter(([t]) => t <= nowText);
  const [when, c] = past.length ? past[past.length - 1] : readings[0];
  return [cToF(c), when.replace('T', ' ')];
}
async function marineTideDetail(p, day) {
  const hourly = await marineHourly(p.lat, p.lon);
  const predictions = marineExtrema(hourly.time || [], hourly.sea_level_height_msl || []);
  const sameDay = predictions.filter((x) => x.time.startsWith(day));
  const [raw, tempTime] = marineSeaTemp(hourly);
  const temp = raw != null && inRange('water_temp_f', raw) ? raw : null;
  return { ok: true, poi: p, date: day, predictions: sameDay.length ? sameDay : predictions, water_temp_f: temp, water_temp_time: tempTime, datum: MARINE_DATUM, source: SOURCE_MARINE_BACKUP, backup: true, backup_station: false,
    water_temp_note: raw != null && temp == null ? OUT_OF_RANGE : null };
}

/* ── USGS NWIS ── */
const usgsUrl = (params) => `${USGS_IV_URL}?${qs({ format: 'json', siteStatus: 'active', ...params })}`;
async function usgsFetch(key, url) {
  const { value } = await cached(key, WEATHER_CACHE_TTL, () => getJson(url, { timeoutMs: USGS_TIMEOUT }));
  return value || {};
}
function parseUsgs(data) {
  const sites = {};
  for (const ts of data.value?.timeSeries || []) {
    const info = ts.sourceInfo || {};
    const site = info.siteCode?.[0]?.value || '';
    const geo = info.geoLocation?.geogLocation || {};
    const lat = toNumber(geo.latitude); const lon = toNumber(geo.longitude);
    if (!site || lat == null || lon == null || !validateCoords(lat, lon)) continue;
    const entry = sites[site] || (sites[site] = { site, name: info.siteName || `USGS ${site}`, lat, lon, latest: {}, series: {} });
    const param = ts.variable?.variableCode?.[0]?.value || '';
    const points = ((ts.values || [{}])[0].value || []).map((v) => ({ time: v.dateTime || '', value: toNumber(v.value) })).filter((p) => p.value != null);
    if (param && points.length) { entry.series[param] = points; entry.latest[param] = [points[points.length - 1].value, points[points.length - 1].time]; }
  }
  return sites;
}
const TAG_FOR_PARAM = { [P_GAGE]: 'gage_height_ft', [P_FLOW]: 'discharge_cfs', [P_TEMP]: 'water_temp_f' };
const cleanStage = (site) => cleanStageSeries(site.series[P_GAGE] || []);
/** [readings, times, outOfRange]: impossible values dropped (a stage glitch falls back to the previous plausible stage). */
function usgsReadings(site) {
  const readings = {}; const times = {}; const dropped = [];
  for (const [param, tag] of Object.entries(TAG_FOR_PARAM)) {
    let [value, when] = site.latest[param] || [null, ''];
    if (value != null && param === P_GAGE) {
      const stage = cleanStage(site);
      if (!stage.length || stage[stage.length - 1].time !== when) dropped.push(tag);
      [value, when] = stage.length ? [round(stage[stage.length - 1].value, 2), stage[stage.length - 1].time] : [null, ''];
    } else if (value != null) {
      value = param === P_TEMP ? cToF(value) : round(value, 2);
      if (!inRange(param === P_TEMP ? 'water_temp_f' : 'flow_cfs', value)) { dropped.push(tag); value = null; when = ''; }
    }
    readings[tag] = value; times[tag] = when;
  }
  return [readings, times, dropped];
}
function usgsPoi(site) {
  const [readings, times, dropped] = usgsReadings(site);
  const tags = Object.fromEntries(Object.entries(readings).filter(([, v]) => v != null));
  tags.times = Object.fromEntries(Object.entries(times).filter(([, v]) => v));
  if (dropped.length) tags.out_of_range = dropped;
  return poi(`usgs:${site.site}`, 'gage', site.name, site.lat, site.lon, SOURCE_USGS, { operator: 'USGS', website: `${USGS_SITE_HOME}${site.site}/`, tags });
}
function usgsBboxParam([s, w, n, e]) {
  if ((n - s) * (e - w) > USGS_BBOX_MAX_SQ_DEG) return null;
  return `${w.toFixed(4)},${s.toFixed(4)},${e.toFixed(4)},${n.toFixed(4)}`;
}
async function usgsSitesInBbox(bbox, params, period) {
  const b = usgsBboxParam(bbox);
  if (!b) return {};
  return parseUsgs(await usgsFetch(`usgs:bbox:${b}:${params}:${period}`, usgsUrl({ parameterCd: params, bBox: b, period })));
}
async function gagesInBbox(bbox) { return Object.values(await usgsSitesInBbox(bbox, USGS_PARAMS, 'PT2H')).map(usgsPoi); }
async function gageDetail(siteCode) {
  const sites = parseUsgs(await usgsFetch(`usgs:site:${siteCode}:P7D`, usgsUrl({ sites: siteCode, parameterCd: USGS_PARAMS, period: 'P7D', siteStatus: 'all' })));
  const site = sites[siteCode];
  if (!site) return { ok: false, error: `USGS site ${siteCode} not found or offline` };
  const [readings, times, dropped] = usgsReadings(site);
  readings.times = times;
  readings.out_of_range = dropped;
  const history = cleanStage(site).map((p) => ({ time: p.time, value: round(p.value, 2) }));
  const values = history.map((h) => h.value);
  const stats = values.length ? { min_ft: round(Math.min(...values), 2), max_ft: round(Math.max(...values), 2), mean_ft: round(values.reduce((a, b) => a + b, 0) / values.length, 2) } : null;
  const detail = { ok: true, poi: usgsPoi(site), readings, history_7d: history, stats_7d: stats, note: null };
  let nwps = null; let late = false;
  try {
    nwps = await Promise.race([nwpsForSite(siteCode, site.name, site.lat, site.lon),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NWPS_BUDGET_MS))]);
  } catch (err) { late = err?.message === 'timeout'; console.debug('[lightkeeper] NWPS unavailable:', err?.message); }
  return attachNwps(detail, nwps, late, history);
}

/* ── NOAA National Water Prediction Service (second source for river gauges; the API sends CORS *) ── */
const NWPS = 'https://api.water.noaa.gov/nwps/v1';
const NWPS_PAGE = 'https://water.noaa.gov/gauges/';
const NWPS_SEARCH_DEG = 0.05;
const NWPS_MATCH_MI = 0.5;
const NWPS_NAME_MATCH_MI = 3;
const NWPS_BUDGET_MS = 8000;
const NWPS_DISAGREE_FT = 0.5;
const NWPS_DISAGREE_FRACTION = 0.1;
const NWPS_COMPARE_WINDOW_MS = 2 * HOUR;
const STALE_MS = DAY;
const NWPS_STOP = new Set(['river', 'r', 'creek', 'cr', 'at', 'near', 'nr', 'below', 'blw', 'above', 'abv', 'the', 'of', 'and']);
const nwpsWords = (name) => new Set(String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !NWPS_STOP.has(w)));
const nwpsValue = (v) => { const n = toNumber(v); return n == null || n <= -999 ? null : n; };
const isStale = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && Date.now() - t > STALE_MS; };
async function nwpsGaugesNear(lat, lon) {
  const clat = round(lat, 2); const clon = round(lon, 2);
  const { value } = await cached(`nwps:gauges:${clat.toFixed(2)},${clon.toFixed(2)}`, DAY, async () => {
    const q = qs({ 'bbox.xmin': (clon - NWPS_SEARCH_DEG).toFixed(3), 'bbox.ymin': (clat - NWPS_SEARCH_DEG).toFixed(3), 'bbox.xmax': (clon + NWPS_SEARCH_DEG).toFixed(3), 'bbox.ymax': (clat + NWPS_SEARCH_DEG).toFixed(3), srid: 'EPSG_4326' });
    const data = await getJson(`${NWPS}/gauges?${q}`, { timeoutMs: 10000 });
    return (data.gauges || []).filter((g) => g.lid && Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
      .map((g) => ({ lid: g.lid, name: g.name || g.lid, lat: g.latitude, lon: g.longitude }));
  });
  return value || [];
}
async function nwpsGauge(lid) {
  const { value } = await cached(`nwps:gauge:${lid}`, WEATHER_CACHE_TTL, () => getJson(`${NWPS}/gauges/${encodeURIComponent(lid)}`, { timeoutMs: 10000 }));
  return value || {};
}
/** The NWPS gauge that is this USGS gauge: same usgsId, else nearest within 0.5 mi, else within 3 mi with matching river + place words. */
async function nwpsMatch(siteCode, name, lat, lon) {
  const near = (await nwpsGaugesNear(lat, lon)).map((g) => ({ ...g, mi: haversineMi(lat, lon, g.lat, g.lon) }))
    .filter((g) => g.mi <= NWPS_NAME_MATCH_MI).sort((a, b) => a.mi - b.mi).slice(0, 3);
  if (!near.length) return null;
  const details = await Promise.all(near.map((g) => nwpsGauge(g.lid).catch(() => null)));
  const usgs = nwpsWords(name);
  const rules = [['usgs_id', (g, d) => String(d.usgsId || '').trim() === siteCode], ['distance', (g) => g.mi <= NWPS_MATCH_MI],
    ['name', (g) => { const w = nwpsWords(g.name); return w.size > 0 && [...w].every((x) => usgs.has(x)); }]];
  for (const [how, ok] of rules) {
    for (let i = 0; i < near.length; i += 1) if (details[i] && ok(near[i], details[i])) return { gauge: details[i], mi: near[i].mi, how };
  }
  return null;
}
async function nwpsForecastPeak(lid) {
  const { value: series } = await cached(`nwps:forecast:${lid}`, WEATHER_CACHE_TTL, () => getJson(`${NWPS}/gauges/${encodeURIComponent(lid)}/stageflow/forecast`, { timeoutMs: 10000 }));
  if (!series || String(series.primaryUnits || 'ft').toLowerCase() !== 'ft') return null;
  const now = Date.now();
  const pts = (series.data || []).map((d) => ({ t: Date.parse(d.validTime), v: nwpsValue(d.primary) })).filter((d) => Number.isFinite(d.t) && d.v != null && d.t >= now);
  if (!pts.length) return null;
  let i = 0;
  pts.forEach((d, j) => { if (d.v > pts[i].v) i = j; });
  return { peak_ft: round(pts[i].v, 2), peak_time: new Date(pts[i].t).toISOString(), rising_at_end: i === pts.length - 1, issued: series.issuedTime || '', until: new Date(pts[pts.length - 1].t).toISOString() };
}
async function nwpsForSite(siteCode, name, lat, lon) {
  const m = await nwpsMatch(siteCode, name, lat, lon);
  if (!m) return null;
  const g = m.gauge; const lid = g.lid || '';
  const flood = g.flood || {}; const cats = flood.categories || {};
  const ftUnits = String(flood.stageUnits || 'ft').toLowerCase() === 'ft';
  const stages = Object.fromEntries(['action', 'minor', 'moderate', 'major'].map((k) => [k, ftUnits ? nwpsValue(cats[k]?.stage) : null]));
  const obs = g.status?.observed || {};
  const stage = String(obs.primaryUnit || 'ft').toLowerCase() === 'ft' ? nwpsValue(obs.primary) : null;
  const obsTime = stage != null ? obs.validTime || '' : '';
  let forecast = null;
  if (g.pedts?.forecast && nwpsValue(g.status?.forecast?.primary) != null) {
    forecast = await nwpsForecastPeak(lid).catch(() => null);
    if (forecast) forecast.flood_category = g.status?.forecast?.floodCategory || '';
  }
  return { lid, name: g.name || lid, url: `${NWPS_PAGE}${lid}`, distance_mi: round(m.mi, 2), match: m.how, usgs_id: g.usgsId || '',
    flood_stages_ft: stages, flood_category: stage != null ? obs.floodCategory || '' : '',
    observed: { stage_ft: stage, time: obsTime, stale: isStale(obsTime) }, forecast, source: 'NOAA NWPS' };
}
/** NWPS observed stage vs the USGS reading closest in time (≤ 2 h apart). */
function stageComparison(obs, usgsPoints) {
  const t = Date.parse(obs.time || '');
  if (obs.stage_ft == null || !Number.isFinite(t)) return null;
  let best = null;
  for (const p of usgsPoints) { const gap = Math.abs(Date.parse(p.time) - t); if (Number.isFinite(gap) && (!best || gap < best.gap)) best = { gap, p }; }
  if (!best || best.gap > NWPS_COMPARE_WINDOW_MS) return null;
  const usgs = best.p.value;
  const diff = round(obs.stage_ft - usgs, 2);
  const limit = round(Math.max(NWPS_DISAGREE_FT, NWPS_DISAGREE_FRACTION * Math.abs(usgs)), 2);
  return { usgs_ft: usgs, usgs_time: best.p.time, nwps_ft: obs.stage_ft, nwps_time: obs.time, diff_ft: diff, limit_ft: limit, disagree: Math.abs(diff) > limit };
}
function attachNwps(detail, nwps, late, usgsPoints) {
  const r = detail.readings; const times = r.times || (r.times = {});
  const notes = detail.note ? [detail.note] : [];
  const stamps = Object.values(times).map((v) => Date.parse(v || '')).filter(Number.isFinite);
  detail.newest_time = stamps.length ? new Date(Math.max(...stamps)).toISOString() : '';
  detail.stale = stamps.length > 0 && isStale(detail.newest_time);
  if (detail.stale) notes.push('Newest reading is more than 24 hours old (USGS)');
  if (nwps) {
    const o = nwps.observed;
    if (r.gage_height_ft == null && o.stage_ft != null && !o.stale) {
      r.gage_height_ft = o.stage_ft; times.gage_height_ft = o.time; r.sources = { gage_height_ft: 'NOAA NWPS' };
      notes.push('Gauge height from NOAA NWPS: USGS has no plausible current stage');
    } else {
      nwps.comparison = stageComparison(o, usgsPoints);
      if (nwps.comparison?.disagree) notes.push(`NWPS and USGS stages disagree by ${Math.abs(nwps.comparison.diff_ft).toFixed(2)} ft`);
    }
    if (o.stale) notes.push('Newest reading is more than 24 hours old (NWPS)');
  } else if (late) notes.push('NOAA NWPS flood stages timed out');
  detail.nwps = nwps;
  detail.note = notes.join('; ') || null;
  return detail;
}

/* ── OpenStreetMap dams ── */
function osmDamPoi(el) {
  const tags = el.tags || {};
  const name = OSM_NAME_TAGS.map((k) => tags[k]).find(Boolean) || '';
  const operator = tags.operator || '';
  if (!name && !operator) return null;
  const center = el.center || el;
  const lat = toNumber(center.lat); const lon = toNumber(center.lon);
  if (lat == null || lon == null) return null;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const locality = [tags['addr:city'], tags['addr:state'], tags['addr:postcode']].filter(Boolean).join(' ');
  return poi(`osm:${el.type}:${el.id}`, 'dam', name || `${operator} Dam`, lat, lon, SOURCE_OSM, {
    name_source: name ? 'osm' : 'derived', address: [street, locality].filter(Boolean).join(', '),
    phone: normalizePhone(tags.phone || tags['contact:phone'] || ''), website: tags.website || tags['contact:website'] || '', operator,
    tags: { osm_id: `${el.type}/${el.id}`, waterway: tags['waterway:name'] || tags.river || '' }, quality: name ? 'verified' : 'likely',
  });
}
async function osmDams([s, w, n, e]) {
  const box = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
  const query = `[out:json][timeout:${OVERPASS_TIMEOUT}];(node["waterway"="dam"]${box};way["waterway"="dam"]${box};relation["waterway"="dam"]${box};);out center tags;`;
  return ((await overpass(query, OVERPASS_TIMEOUT)).elements || []).map(osmDamPoi).filter(Boolean);
}
/* Pre-crawled named dams per district (lightkeeper/data/DISTRICT_<id>_<Name>_Dams.json): instant, no Overpass.
   Districts without a published file still use the live Overpass query. */
const shippedDamMemo = new Map();
const shippedDamById = new Map();
function shippedDams(id, file) {
  if (!shippedDamMemo.has(id)) {
    shippedDamMemo.set(id, staticJson(file, DAY).then((list) => {
      const out = Array.isArray(list) ? list : [];
      for (const d of out) shippedDamById.set(d.id, d);
      return out;
    }).catch(() => { shippedDamMemo.delete(id); return []; }));
  }
  return shippedDamMemo.get(id);
}
/* National Inventory of Dams (USACE, public ArcGIS service with CORS, no key): fast and reliable, unlike the
   public Overpass servers. Only dams on rivers/streams and at least 10 ft high (skips ponds and lagoons). */
const NID_URL = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/NID_v1/FeatureServer/0/query';
const nidById = new Map();
async function nidDams(bbox) {
  const [s, w, n, e] = bbox;
  const q = new URLSearchParams({
    where: "NID_HEIGHT >= 10 AND RIVER_OR_STREAM <> 'Offstream'", geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope',
    inSR: 4326, outSR: 4326, spatialRel: 'esriSpatialRelIntersects', resultRecordCount: 2000, f: 'json',
    outFields: 'NIDID,NAME,OTHER_NAMES,PRIMARY_OWNER_TYPE,PRIMARY_PURPOSE,NID_HEIGHT,YEAR_COMPLETED,RIVER_OR_STREAM,CITY,STATE,NUMBER_OF_LOCKS',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const data = await (await fetch(`${NID_URL}?${q}`, { signal: ctrl.signal })).json();
    return (data.features || []).map(({ attributes: a = {}, geometry: g = {} }) => {
      const name = (a.NAME || a.OTHER_NAMES || '').trim();
      if (!name || !a.NIDID || !Number.isFinite(g.y) || !Number.isFinite(g.x)) return null;
      const tags = Object.fromEntries(Object.entries({
        nid_id: a.NIDID, river: a.RIVER_OR_STREAM, height_ft: a.NID_HEIGHT, year_completed: a.YEAR_COMPLETED,
        purpose: a.PRIMARY_PURPOSE, owner_type: a.PRIMARY_OWNER_TYPE, locks: a.NUMBER_OF_LOCKS,
      }).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0));
      let city = String(a.CITY || '').trim().replace(/^Within (.+?) City Limits$/i, '$1');
      if (/^(none|n\/a|unknown)$/i.test(city)) city = '';
      city = city.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      const p = poi(`nid:${a.NIDID}`, 'dam', name, g.y, g.x, 'USACE National Inventory of Dams', {
        address: [city, a.STATE].filter(Boolean).join(', '), tags,
      });
      nidById.set(p.id, p);
      return p;
    }).filter(Boolean);
  } catch { return []; } finally { clearTimeout(timer); }
}

async function damsInBbox(bbox) {
  const [s, w, n, e] = bbox;
  const all = await districtList().catch(() => []);
  const ids = all.filter((d) => (d.bounds || []).some(([W, S, E, N]) => !(e < W || w > E || n < S || s > N))).map((d) => d.id);
  const m = await manifest().catch(() => null);
  const published = ids.filter((id) => m?.dams?.[id]?.file);
  const shipped = (await Promise.all(published.map((id) => shippedDams(id, m.dams[id].file)))).flat()
    .filter((p) => inBbox(p.lat, p.lon, bbox));
  if (published.length && published.length === ids.length) return shipped;
  // Inventory first (always answers); OpenStreetMap adds named dams it knows when its servers respond in time.
  const osmSoon = Promise.race([osmDams(bbox).catch(() => []), new Promise((r) => setTimeout(() => r([]), 6000))]);
  const [nid, osm] = await Promise.all([nidDams(bbox), osmSoon]);
  const out = shipped.slice();
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.004 && Math.abs(a.lon - b.lon) < 0.004;
  for (const p of nid.concat(osm)) if (!out.some((q) => q.id === p.id || near(q, p))) out.push(p);
  return out;
}
/* ── USACE CWMS live readings (the CWMS Data API answers web pages directly) ──
   The project list (office + CWMS location for ~740 dams) ships as data/cwms-dams.json; a dam on the map is matched
   to the nearest project within 3 mi (preferring a shared name word), then its catalogued series are read. */
const CDA = 'https://cwms-data.usace.army.mil/cwms-data';
const CWMS_MATCH_MI = 3;
const CWMS_SKIP = ['FCST', 'FORECAST', 'RESSIM'];
const NAME_STOP = new Set(['dam', 'lock', 'locks', 'l', 'd', 'and', 'lake', 'reservoir', 'res', 'project', 'the', 'of', 'nr', 'near', 'at']);
const tokens = (...names) => new Set(names.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !NAME_STOP.has(w)));
const TO_EN = { m: (v) => v * 3.28084, cms: (v) => v * 35.3147, m3: (v) => v / 1233.48 };
let cwmsList = null;
const cwmsProjects = () => (cwmsList ||= staticJson('cwms-dams.json', DAY).catch(() => { cwmsList = null; return []; }));

async function matchCwms(p) {
  const list = await cwmsProjects();
  const near = list.map((c) => ({ ...c, mi: haversineMi(p.lat, p.lon, c.lat, c.lon) })).filter((c) => c.mi <= CWMS_MATCH_MI).sort((a, b) => a.mi - b.mi);
  if (!near.length) return null;
  const want = tokens(p.name || '');
  return near.find((c) => [...tokens(c.n, c.l, c.c)].some((w) => want.has(w))) || near[0];
}

async function cda(path, params, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(`${CDA}/${path}?${new URLSearchParams({ format: 'json', ...params })}`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally { clearTimeout(timer); }
}

function classifyCwms(name) {
  const param = (name.split('.')[1] || '').toLowerCase();
  if (param.includes('tailwater') || param.startsWith('stage-tail')) return 'tailwater_ft';
  if (param.startsWith('elev')) return 'pool_elevation_ft';
  if (param.startsWith('stor')) return 'storage_acft';
  if (param.startsWith('flow-spill')) return 'spill_cfs';
  if (param.startsWith('flow-gen') || param.startsWith('flow-power') || param.includes('turbine')) return 'generation_cfs';
  if (param.startsWith('flow-out') || param.startsWith('flow-total') || param.includes('outflow') || param === 'flow-res out') return 'outflow_cfs';
  if (param.startsWith('flow-in') || param.includes('inflow')) return 'inflow_cfs';
  return null;
}
function seriesRank(name) {
  const parts = name.split('.');
  const interval = (parts[3] || '').replace(/^~/, '').toLowerCase();
  const version = (parts[5] || '').toUpperCase();
  const i = interval.endsWith('minutes') || interval === '1hour' ? 0 : interval.includes('hour') ? 1 : 2;
  return [i, version.includes('REV') ? 0 : 1];
}

async function cwmsLatest(name, office) {
  const end = new Date();
  const begin = new Date(end - 72 * 3600 * 1000);
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
  const data = await cda('timeseries', { name, office, unit: 'EN', begin: iso(begin), end: iso(end), 'page-size': 1000 }, 8000);
  const conv = TO_EN[String(data.units || '').toLowerCase()] || ((v) => v);
  const rows = data.values || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const [stamp, value] = Array.isArray(row) ? row : [row['date-time'] ?? row.time, row.value];
    if (value != null && Number.isFinite(Number(value))) return { value: conv(Number(value)), time: typeof stamp === 'number' ? new Date(stamp).toISOString() : String(stamp) };
  }
  return null;
}

/** Fill a dam detail with the newest CWMS readings of its matched project (best effort, ~10 s budget). */
const FLOW_KEYS = new Set(['inflow_cfs', 'outflow_cfs', 'spill_cfs', 'generation_cfs']);
const DAM_LABELS = { pool_elevation_ft: 'pool elevation', tailwater_ft: 'tailwater', inflow_cfs: 'inflow', outflow_cfs: 'outflow', storage_acft: 'storage', spill_cfs: 'spill', generation_cfs: 'generation' };
const outOfRangeNote = (keys) => (keys.length ? `${keys.map((k) => DAM_LABELS[k]).join(', ')}: ${OUT_OF_RANGE}` : '');
/** USACE readings first; when USACE has none for this dam, the Bureau of Reclamation's. */
async function withCwms(detail, p) {
  const usace = await withUsace(detail, p);
  if (usace.data_available) return usace;
  const usbr = await withReclamation(usace, p).catch((err) => { console.debug('[lightkeeper] Reclamation unavailable:', err?.message); return null; });
  return usbr || usace;
}
async function withUsace(detail, p) {
  const c = await matchCwms(p).catch(() => null);
  if (!c) return { ...detail, note: 'No data available: this dam has no USACE readings.' };
  try {
    const cat = await cda('catalog/TIMESERIES', { office: c.o, like: `^${c.c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\..*`, 'page-size': 1000 });
    const entries = cat.entries || cat.entry || [];
    const byKey = {};
    for (const e of entries) {
      const name = e?.name || '';
      const key = classifyCwms(name);
      if (!key || CWMS_SKIP.some((w) => name.toUpperCase().includes(w))) continue;
      (byKey[key] ||= []).push(name);
    }
    const jobs = [];
    for (const [key, names] of Object.entries(byKey)) {
      names.sort((a, b) => { const x = seriesRank(a); const y = seriesRank(b); return x[0] - y[0] || x[1] - y[1] || a.localeCompare(b); });
      for (const name of names.slice(0, 3)) jobs.push(cwmsLatest(name, c.o).then((r) => (r ? { key, ...r } : null)).catch(() => null));
    }
    const got = {}; const bad = new Set();
    for (const r of await Promise.all(jobs)) {
      if (r && FLOW_KEYS.has(r.key) && !inRange('flow_cfs', r.value)) { bad.add(r.key); continue; }   // another series answers
      if (r && (!got[r.key] || r.time > got[r.key].time)) got[r.key] = r;
    }
    if (!got.outflow_cfs && got.spill_cfs && got.generation_cfs) got.outflow_cfs = { value: got.spill_cfs.value + got.generation_cfs.value, time: got.spill_cfs.time };
    const out = { ...detail, office: c.o, location: c.c };
    let updated = '';
    for (const k of DAM_DETAIL_KEYS) if (got[k]) { out[k] = Math.round(got[k].value * 100) / 100; if (got[k].time > updated) updated = got[k].time; }
    out.updated = updated;
    out.data_available = DAM_DETAIL_KEYS.some((k) => out[k] != null);
    out.out_of_range = [...bad].filter((k) => !got[k]).sort();
    out.source = out.data_available ? 'USACE CWMS' : '';
    out.note = [out.data_available ? '' : 'No data available: no recent USACE readings for this dam.', outOfRangeNote(out.out_of_range)].filter(Boolean).join('; ');
    return out;
  } catch {
    return { ...detail, office: c.o, note: 'No data available right now (USACE data service did not answer).' };
  }
}

/* ── Bureau of Reclamation RISE (keyless JSON:API; reflects the page's Origin for CORS) ──
   Locations with reservoir elevation / storage / release data (~230, three pages) are cached for a week; a dam is matched to
   the nearest within 3 mi (preferring a shared name word), then the newest plausible reading per value is read. */
const RISE = 'https://data.usbr.gov/rise/api';
const RISE_MATCH_MI = 3;
const RISE_LOOKBACK_DAYS = 10;
const RISE_PARAMS = { pool_elevation_ft: [1748, 2, 1834], storage_acft: [1739, 3], outflow_cfs: [1814, 1830, 18], inflow_cfs: [1749, 12] };
const RISE_GROUPS = [1, 2, 10];
const riseUrl = (path, params) => `${RISE}/${path}?${Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`)).join('&')}`;
let riseList = null;
function riseLocations() {
  riseList ||= cached('rise:locations', 7 * DAY, async () => {
    const found = [];
    for (let page = 1; page <= 5; page += 1) {
      const data = await getJson(riseUrl('location', { 'parameterGroupId[]': RISE_GROUPS, itemsPerPage: 100, page }), { timeoutMs: 15000 });
      const items = data.data || [];
      for (const it of items) {
        const a = it.attributes || {}; const c = a.locationCoordinates || {};
        if (c.type !== 'Point' || a._id == null) continue;
        const [lon, lat] = (c.coordinates || []).map(Number);
        if (!validateCoords(lat, lon)) continue;
        found.push({ id: a._id, name: a.locationName || '', lat, lon, url: `https://data.usbr.gov/location/${a._id}` });
      }
      if (!items.length || page * 100 >= Number(data.meta?.totalItems || 0)) break;
    }
    return found;
  }).then((r) => r.value || []).catch(() => { riseList = null; return []; });
  return riseList;
}
async function riseMatch(p) {
  const near = (await riseLocations()).map((r) => ({ ...r, mi: haversineMi(p.lat, p.lon, r.lat, r.lon) })).filter((r) => r.mi <= RISE_MATCH_MI).sort((a, b) => a.mi - b.mi);
  if (!near.length) return null;
  const want = tokens(p.name || '');
  return near.find((r) => [...tokens(r.name)].some((w) => want.has(w))) || near[0];
}
/** Newest plausible {value, time} for one key; {value: null} when every reading in the window was impossible. */
async function riseLatest(locationId, key) {
  const after = new Date(Date.now() - RISE_LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  const { value: data } = await cached(`rise:result:${locationId}:${key}:${after}`, HOUR, () => getJson(riseUrl('result', {
    locationId, 'parameterId[]': RISE_PARAMS[key], 'dateTime[after]': after, 'order[dateTime]': 'desc', itemsPerPage: 50 }), { timeoutMs: 15000 }));
  const rank = new Map(RISE_PARAMS[key].map((pid, i) => [pid, i]));
  let best = null; let impossible = null;
  for (const row of data?.data || []) {
    const a = row.attributes || {}; const v = toNumber(a.result);
    if (v == null || !rank.has(a.parameterId)) continue;
    if (FLOW_KEYS.has(key) && !inRange('flow_cfs', v)) { impossible ||= { value: null, time: a.dateTime }; continue; }
    const cand = { value: v, time: a.dateTime || '', rank: rank.get(a.parameterId), pid: a.parameterId };
    if (!best || cand.time > best.time || (cand.time === best.time && cand.rank < best.rank)) best = cand;
  }
  return best || impossible;
}
async function withReclamation(detail, p) {
  if (!p.lat && !p.lon) return null;
  const loc = await riseMatch(p);
  if (!loc) return null;
  const keys = Object.keys(RISE_PARAMS);
  const got = await Promise.all(keys.map((k) => riseLatest(loc.id, k).catch(() => null)));
  const out = { ...detail, series: {} };
  const bad = [];
  let updated = '';
  keys.forEach((k, i) => {
    const r = got[i];
    if (!r) return;
    if (r.value == null) { bad.push(k); return; }
    out[k] = Math.round(r.value * 100) / 100;
    out.series[k] = { series: `RISE location ${loc.id} parameter ${r.pid}`, time: r.time };
    if (r.time > updated) updated = r.time;
  });
  if (!DAM_DETAIL_KEYS.some((k) => out[k] != null)) return null;
  const wanted = ['pool_elevation_ft', 'storage_acft', 'outflow_cfs'].filter((k) => out[k] == null && !bad.includes(k));
  Object.assign(out, { updated, data_available: true, source: 'Bureau of Reclamation', office: '', out_of_range: bad.sort(),
    usbr_location: { id: loc.id, name: loc.name, url: loc.url, distance_mi: round(loc.mi, 2) },
    note: [wanted.length ? `No recent Reclamation readings for: ${wanted.map((k) => DAM_LABELS[k]).join(', ')}` : '', outOfRangeNote(bad)].filter(Boolean).join('; ') });
  if (!out.website) { out.website = loc.url; out.poi = { ...out.poi, website: loc.url }; }
  return out;
}

async function nidDamDetail(stationId) {
  const p = nidById.get(stationId);
  if (!p) return { ok: false, error: `Unknown dam '${stationId}'` };
  const detail = Object.fromEntries(DAM_DETAIL_KEYS.map((k) => [k, null]));
  return withCwms({ ...detail, ok: true, poi: { ...p }, updated: '', office: '', phone: p.phone, address: p.address, website: p.website, data_available: false, note: '' }, p);
}

async function osmDamDetail(stationId) {
  const known = shippedDamById.get(stationId);
  if (known) {
    const p = { ...known, address: known.address || await reverseAddress(known.lat, known.lon) };
    const detail = Object.fromEntries(DAM_DETAIL_KEYS.map((k) => [k, null]));
    return withCwms({ ...detail, ok: true, poi: p, updated: '', office: '', phone: p.phone, address: p.address, website: p.website, data_available: false, note: '' }, p);
  }
  const [, osmType, osmId] = stationId.split(':');
  const data = await overpass(`[out:json][timeout:${OVERPASS_TIMEOUT}];${osmType}(${osmId});out center tags;`, OVERPASS_TIMEOUT);
  const p = (data.elements || []).map(osmDamPoi).find(Boolean);
  if (!p) return { ok: false, error: `Unknown dam '${stationId}'` };
  p.address = p.address || await reverseAddress(p.lat, p.lon);
  const detail = Object.fromEntries(DAM_DETAIL_KEYS.map((k) => [k, null]));
  return withCwms({ ...detail, ok: true, poi: p, updated: '', office: '', phone: p.phone, address: p.address, website: p.website, data_available: false, note: '' }, p);
}

/* ── Public API ── */
export async function stationsInBbox(bbox, types = STATION_TYPES) {
  const wanted = STATION_TYPES.filter((t) => types.includes(t));
  const fetchers = {
    tide: async () => (await noaaStations('tide')).filter((p) => inBbox(p.lat, p.lon, bbox)),
    current: async () => (await noaaStations('current')).filter((p) => inBbox(p.lat, p.lon, bbox)),
    gage: () => gagesInBbox(bbox),
    dam: () => damsInBbox(bbox),
  };
  const results = await settle(Object.fromEntries(wanted.map((t) => [t, fetchers[t]])), []);
  return wanted.flatMap((t) => results[t]);
}

export async function stationDetail(stationId, dateArg) {
  const day = parseDate(dateArg);
  if (!day) return { ok: false, error: 'date must be YYYY-MM-DD' };
  const [prefix, ...rest] = String(stationId).split(':');
  const code = rest.join(':');
  if (!code) return { ok: false, error: `Unknown station id '${stationId}'` };
  try {
    if (prefix === 'noaa' || prefix === 'noaa-cur') {
      const kind = prefix === 'noaa' ? 'tide' : 'current';
      const p = (await noaaStations(kind)).find((s) => s.id === stationId) || poi(stationId, kind, `NOAA Station ${code}`, 0, 0, SOURCE_NOAA, { name_source: 'derived', quality: 'unverified' });
      return kind === 'tide' ? tideDetail(p, day) : currentDetail(p, day);
    }
    if (prefix === 'usgs') return gageDetail(code);
    if (prefix === 'osm') return osmDamDetail(stationId);
    if (prefix === 'nid') return nidDamDetail(stationId);
  } catch (err) {
    console.warn('[lightkeeper] station detail failed:', err?.message);
    return { ok: false, error: `Data unavailable for ${stationId}` };
  }
  return { ok: false, error: `Unknown station id '${stationId}'` };
}

const tempRecord = (source, p, tempF, when) => ({ source, station_id: p.id, station_name: p.name, lat: p.lat, lon: p.lon, distance_mi: p.distance_mi, water_temp_f: tempF, water_temp_c: fToC(tempF), time: when });
// Water temperature, same approach as the desktop app: USGS area searches are slow (7-40 s), so each ring's list of
// temperature sites is remembered for a day and later visits fetch readings by site id (about 0.3 s).
const TEMP_RINGS_MI = [15, 50, 120];          // 120 mi keeps the USGS box under its 25 square-degree limit
const TEMP_NOAA_MAX_MI = 300;
const TEMP_DEADLINE_MS = 9000;
const USGS_AREA_TIMEOUT = 45000;
async function usgsTempSites(lat, lon, radiusMi) {
  const key = `usgs:tempsites:${lat.toFixed(2)},${lon.toFixed(2)}:${radiusMi}`;
  const { value } = await cached(key, DAY, async () => {
    const b = usgsBboxParam(bboxAround(lat, lon, radiusMi * METERS_PER_MILE));
    if (!b) return [];
    const data = await getJson(usgsUrl({ parameterCd: P_TEMP, bBox: b, period: 'PT6H' }), { timeoutMs: USGS_AREA_TIMEOUT });
    return Object.values(parseUsgs(data)).filter((x) => x.latest[P_TEMP]).map((x) => ({ site: x.site, name: x.name, lat: x.lat, lon: x.lon }));
  });
  return value || [];
}
async function usgsTempRing(lat, lon, radiusMi) {
  const sites = (await usgsTempSites(lat, lon, radiusMi))
    .map((x) => ({ ...x, d: haversineMi(lat, lon, x.lat, x.lon) })).sort((x, y) => x.d - y.d).slice(0, 10);
  if (!sites.length) return null;
  const ids = sites.map((x) => x.site).join(',');
  const parsed = parseUsgs(await usgsFetch(`usgs:temp:${ids}:PT6H`, usgsUrl({ sites: ids, parameterCd: P_TEMP, period: 'PT6H' })));
  const reporting = Object.values(parsed).filter((x) => x.latest[P_TEMP] && x.latest[P_TEMP][0] > -999)
    .map(usgsPoi).map((x) => ({ ...x, distance_mi: round(haversineMi(lat, lon, x.lat, x.lon), 1) }))
    .sort((x, y) => x.distance_mi - y.distance_mi);
  const pois = reporting.filter((x) => x.tags.water_temp_f != null);           // impossible values were dropped
  const p = pois[0];
  if (!p) return null;
  const rec = tempRecord(SOURCE_USGS, p, p.tags.water_temp_f, p.tags.times?.water_temp_f || '');
  const skipped = reporting.filter((x) => x.tags.water_temp_f == null && x.distance_mi < p.distance_mi).map((x) => x.name);
  if (skipped.length) rec.skipped = skipped;
  return rec;
}
async function noaaTempNear(lat, lon) {
  const skipped = [];
  for (const p of nearestK(lat, lon, await noaaStations('tide'), TEMP_NOAA_MAX_MI, 3)) {
    const [temp, when] = await noaaWaterTemp(noaaCode(p), todayIso());
    if (temp != null && !inRange('water_temp_f', temp)) { skipped.push(p.name); continue; }   // impossible: next station
    if (temp != null) return { ...tempRecord(SOURCE_NOAA, p, temp, when), ...(skipped.length ? { skipped } : {}) };
  }
  return null;
}
async function marineTempNear(lat, lon) {
  const [temp, when] = marineSeaTemp(await marineHourly(lat, lon));
  if (temp == null || !inRange('water_temp_f', temp)) return null;
  return tempRecord(SOURCE_MARINE, { id: 'open-meteo:marine', name: 'Open-Meteo Marine model', lat: round(lat, 4), lon: round(lon, 4), distance_mi: 0 }, temp, when);
}
async function ndbcTempNear(lat, lon) {
  const s = await ndbc.nearest(lat, lon, 'water_c', 300);
  if (!s) return null;
  return tempRecord('NOAA buoys (NDBC)', { id: `ndbc:${s.id}`, name: `NOAA buoy ${s.id}`, lat: s.lat, lon: s.lon, distance_mi: s.distance_mi },
    Math.round((s.water_c * 9 / 5 + 32) * 10) / 10, s.time);
}

export async function waterTempNear(lat, lon) {
  if (!validateCoords(lat, lon)) return { ok: false, error: 'Invalid coordinates', all: [] };
  const found = [];
  let usgsPending = TEMP_RINGS_MI.length;
  const keep = (rec) => { if (rec && !found.some((f) => f.station_id === rec.station_id)) found.push(rec); };
  const jobs = [
    ...TEMP_RINGS_MI.map((r) => usgsTempRing(lat, lon, r).then(keep).catch(() => {}).finally(() => { usgsPending -= 1; })),
    noaaTempNear(lat, lon).then(keep).catch(() => {}),
    ndbcTempNear(lat, lon).then(keep).catch(() => {}),
  ];
  // Answer as soon as a reading within the first ring is in hand, or when everything settles, or at the deadline.
  // Searches still running keep going in the background and seed the cache for the next visit.
  await new Promise((done) => {
    const all = Promise.all(jobs).then(done);
    const timer = setTimeout(done, TEMP_DEADLINE_MS);
    const tick = setInterval(() => { if (found.some((f) => f.distance_mi <= TEMP_RINGS_MI[0])) done(); }, 100);
    all.finally(() => { clearTimeout(timer); clearInterval(tick); });
    setTimeout(() => clearInterval(tick), TEMP_DEADLINE_MS);
  });
  found.sort((x, y) => x.distance_mi - y.distance_mi);
  const nearestRec = found[0] || null;
  const result = await waterTempAnswer(lat, lon, found, nearestRec, usgsPending);
  const skipped = [...new Set(found.filter((f) => result.primary && (f === result.primary || f.distance_mi <= result.primary.distance_mi)).flatMap((f) => f.skipped || []))].sort();
  if (skipped.length && result.ok && !result.offline_saved) {
    result.out_of_range = skipped;
    result.note = [result.note, `${skipped.join(', ')}: ${OUT_OF_RANGE}`].filter(Boolean).join('; ');
  }
  return result;
}
async function waterTempAnswer(lat, lon, found, nearestRec, usgsPending) {
  // A reading saved for offline use near here beats a far one (or none): use it when it's closer.
  if (!nearestRec || nearestRec.distance_mi > WATER_TEMP_RADIUS_MI) {
    const saved = await nearestSaved('temp', lat, lon, 40);
    const savedMi = saved?.value?.primary ? saved.distance_mi + (saved.value.primary.distance_mi || 0) : Infinity;
    if (saved && savedMi < (nearestRec?.distance_mi ?? Infinity)) {
      return { ...saved.value, offline_saved: true, note: [saved.value.note, `Saved reading${navigator.onLine ? '' : ' (offline)'}`].filter(Boolean).join(' · ') };
    }
  }
  if (nearestRec && nearestRec.distance_mi <= WATER_TEMP_RADIUS_MI) {
    return { ok: true, primary: nearestRec, all: found, nearest_mi: nearestRec.distance_mi, note: null };
  }
  let marine = null;
  try { marine = await marineTempNear(lat, lon); } catch { marine = null; }
  if (marine) {
    return { ok: true, primary: marine, all: [marine, ...found], nearest_mi: 0,
      note: `No water temperature station within ${WATER_TEMP_RADIUS_MI} mi of this spot; showing Open-Meteo Marine model sea surface temperature` };
  }
  if (nearestRec) {
    return { ok: true, primary: nearestRec, all: found, nearest_mi: nearestRec.distance_mi,
      note: `No water temperature station within ${WATER_TEMP_RADIUS_MI} mi of this spot; nearest reading is ${nearestRec.station_name}, ${Math.round(nearestRec.distance_mi)} mi away` };
  }
  const saved = await nearestSaved('temp', lat, lon, 40);   // offline: the last reading saved for this area
  if (saved?.value?.primary) return { ...saved.value, offline_saved: true, note: [saved.value.note, 'Offline: saved reading'].filter(Boolean).join(' · ') };
  return { ok: false, all: [], usgs_pending: usgsPending > 0,
    error: usgsPending > 0 ? 'Still looking up river gauges for this area; try again in a moment' : 'No water temperature source answered' };
}


export { haversineMi, nominatimGet, HOUR };
