/** Water conditions in the browser (port of water.py): NOAA CO-OPS tide/current stations, USGS gages,
 *  dams from OpenStreetMap (USACE CWMS has no CORS and cannot be reached from a web page), water
 *  temperature and NWS flood alerts. Same response shapes as the desktop endpoints.
 *
 *  Backup chain for tides: NOAA (requested station → ±1 day window → next-nearest station) → Open-Meteo Marine. */

import { getJson, qs, overpass, nominatimGet } from './http.js?v=2.0.7-4';
import { cached, MIN, HOUR, DAY } from './store.js?v=2.0.7-4';
import { validateCoords, haversineMi, inBbox, bboxAround, nearestK, nearest, toNumber, round, cToF, fToC, normalizePhone, todayIso, settle, METERS_PER_MILE, METERS_TO_FEET } from './util.js?v=2.0.7-4';
import { openMeteoGet, pointKey } from './weather.js?v=2.0.7-4';
import { reverseGeocode } from './poi.js?v=2.0.7-4';
import { staticJson } from './aids.js?v=2.0.7-4';

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
    const [temp, tempTime] = await noaaWaterTemp(code, day);
    return withBackup({ ok: true, date: day, predictions, water_temp_f: temp, water_temp_time: tempTime, datum: NOAA_TIDE_DATUM, source: SOURCE_NOAA, backup: false }, p, station);
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
  const [temp, tempTime] = marineSeaTemp(hourly);
  return { ok: true, poi: p, date: day, predictions: sameDay.length ? sameDay : predictions, water_temp_f: temp, water_temp_time: tempTime, datum: MARINE_DATUM, source: SOURCE_MARINE_BACKUP, backup: true, backup_station: false };
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
function usgsReadings(site) {
  const readings = {}; const times = {};
  for (const [param, tag] of Object.entries(TAG_FOR_PARAM)) {
    let [value, when] = site.latest[param] || [null, ''];
    if (value != null) value = param === P_TEMP ? cToF(value) : round(value, 2);
    readings[tag] = value; times[tag] = when;
  }
  return [readings, times];
}
function usgsPoi(site) {
  const [readings, times] = usgsReadings(site);
  const tags = Object.fromEntries(Object.entries(readings).filter(([, v]) => v != null));
  tags.times = Object.fromEntries(Object.entries(times).filter(([, v]) => v));
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
  const [readings, times] = usgsReadings(site);
  readings.times = times;
  const history = (site.series[P_GAGE] || []).map((p) => ({ time: p.time, value: round(p.value, 2) }));
  const values = history.map((h) => h.value);
  const stats = values.length ? { min_ft: round(Math.min(...values), 2), max_ft: round(Math.max(...values), 2), mean_ft: round(values.reduce((a, b) => a + b, 0) / values.length, 2) } : null;
  return { ok: true, poi: usgsPoi(site), readings, history_7d: history, stats_7d: stats };
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
async function osmDamDetail(stationId) {
  const [, osmType, osmId] = stationId.split(':');
  const data = await overpass(`[out:json][timeout:${OVERPASS_TIMEOUT}];${osmType}(${osmId});out center tags;`, OVERPASS_TIMEOUT);
  const p = (data.elements || []).map(osmDamPoi).find(Boolean);
  if (!p) return { ok: false, error: `Unknown dam '${stationId}'` };
  p.address = p.address || await reverseAddress(p.lat, p.lon);
  const detail = Object.fromEntries(DAM_DETAIL_KEYS.map((k) => [k, null]));
  return { ...detail, ok: true, poi: p, updated: '', office: '', phone: p.phone, address: p.address, website: p.website, data_available: false, note: 'Live pool and release data (USACE CWMS) is available in the desktop app.' };
}

/* ── Public API ── */
export async function stationsInBbox(bbox, types = STATION_TYPES) {
  const wanted = STATION_TYPES.filter((t) => types.includes(t));
  const fetchers = {
    tide: async () => (await noaaStations('tide')).filter((p) => inBbox(p.lat, p.lon, bbox)),
    current: async () => (await noaaStations('current')).filter((p) => inBbox(p.lat, p.lon, bbox)),
    gage: () => gagesInBbox(bbox),
    dam: () => osmDams(bbox),
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
  } catch (err) {
    console.warn('[lightkeeper] station detail failed:', err?.message);
    return { ok: false, error: `Data unavailable for ${stationId}` };
  }
  return { ok: false, error: `Unknown station id '${stationId}'` };
}

const tempRecord = (source, p, tempF, when) => ({ source, station_id: p.id, station_name: p.name, lat: p.lat, lon: p.lon, distance_mi: p.distance_mi, water_temp_f: tempF, water_temp_c: fToC(tempF), time: when });
async function usgsTempNear(lat, lon) {
  const sites = await usgsSitesInBbox(bboxAround(lat, lon, WATER_TEMP_RADIUS_MI * METERS_PER_MILE), P_TEMP, 'PT24H');
  const pois = Object.values(sites).filter((s) => s.latest[P_TEMP]).map(usgsPoi);
  const p = nearest(lat, lon, pois, WATER_TEMP_RADIUS_MI);
  return p ? tempRecord(SOURCE_USGS, p, p.tags.water_temp_f, p.tags.times?.water_temp_f || '') : null;
}
async function noaaTempNear(lat, lon) {
  const p = nearest(lat, lon, await noaaStations('tide'), WATER_TEMP_RADIUS_MI);
  if (!p) return null;
  const [temp, when] = await noaaWaterTemp(noaaCode(p), todayIso());
  return temp != null ? tempRecord(SOURCE_NOAA, p, temp, when) : null;
}
async function marineTempNear(lat, lon) {
  const [temp, when] = marineSeaTemp(await marineHourly(lat, lon));
  if (temp == null) return null;
  return tempRecord(SOURCE_MARINE, { id: 'open-meteo:marine', name: 'Open-Meteo Marine model', lat: round(lat, 4), lon: round(lon, 4), distance_mi: 0 }, temp, when);
}
export async function waterTempNear(lat, lon) {
  if (!validateCoords(lat, lon)) return { ok: false, error: 'Invalid coordinates', all: [] };
  const out = await settle({ usgs: () => usgsTempNear(lat, lon), noaa: () => noaaTempNear(lat, lon) }, null);
  let found = Object.values(out).filter(Boolean).sort((a, b) => a.distance_mi - b.distance_mi);
  if (!found.length) { try { const m = await marineTempNear(lat, lon); found = m ? [m] : []; } catch { found = []; } }
  if (!found.length) return { ok: false, error: 'No water temperature readings within 50 mi', all: [] };
  return { ok: true, primary: found[0], all: found };
}


export { haversineMi, nominatimGet, HOUR };
