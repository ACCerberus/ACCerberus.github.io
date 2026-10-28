/** Places in the browser: boat ramps / marinas, lodging, parks, place search, geocoding (port of poi.py).
 *
 *  Every place is the shared POI record from ARCHITECTURE.md:
 *  {id, kind, name, name_source, lat, lon, address, phone, website, operator, tags, quality, distance_mi, source}.
 *  `name` is never empty: OSM names first, else derived (operator → nearby park → OSM street/city →
 *  reverse geocode road/town → water body → coordinates). Never hostels. Overpass answers are cached
 *  7 days, reverse geocodes forever, assembled place lists 5 minutes.
 */

import { getJson, qs, overpass, nominatimGet } from './http.js?v=2.0.9-3';
import { cached, idbGet, idbSet, DAY, MIN } from './store.js?v=2.0.9-3';
import { districts as districtList, manifest, staticJson } from './aids.js?v=2.0.9-3';
import { haversineMi, isInUs, validateCoords, normalizePhone, first, formatAddress, METERS_PER_MILE } from './util.js?v=2.0.9-3';

const SOURCE_OSM = 'OpenStreetMap';
const SOURCE_NOMINATIM = 'Nominatim';
export const LODGING_KINDS = ['hotel', 'motel', 'resort', 'campground'];
const RAMP_KINDS = ['ramp', 'marina'];
const QUALITY_RANK = { verified: 0, likely: 1, unverified: 2 };
const DASH = ' – ';
const PARK_RAMP_LINK_MI = 1.5;
const DEDUP_DISTANCE_MI = 0.06;
const POI_MIN_NAME_LEN = 3;
const NAME_COORD_DECIMALS = 3;
const QUALITY_VERIFIED_MIN = 7;
const QUALITY_LIKELY_MIN = 4;
const RESORT_MIN_STARS = 4;
const MAX_HOTELS_TOTAL = 60;
const MAX_LAUNCHES_TOTAL = 50;
const OVERPASS_RAMP_LIMIT = 150;
const OVERPASS_PARK_LIMIT = 300;
const OVERPASS_LODGING_LIMIT = 150;
const OVERPASS_TIMEOUT = 25;
const FETCH_GEOCODE_LOOKUPS = 10;
const ENRICH_MAX_LOOKUPS = 25;
const REVERSE_GEOCODE_ZOOM = 16;
const SEARCH_RESULT_LIMIT = 20;
const GEOCODE_RESULT_LIMIT = 8;
const SEARCH_MIN_QUERY_LEN = 2;
const SEARCH_BIAS_DEG = 2.0;
const POI_LIST_TTL = 5 * MIN;
const FOREVER = 3650 * DAY;
const HOTEL_RADIUS = [1000, 30000, 200000];
const LAUNCH_RADIUS = [5000, 50000, 200000];

const KIND_LABEL = { ramp: 'Boat Ramp', marina: 'Marina', hotel: 'Hotel', motel: 'Motel', resort: 'Resort', campground: 'Campground', park: 'Park', place: 'Place' };
const NAME_TAGS = ['name', 'official_name', 'alt_name', 'loc_name', 'seamark:name', 'ref'];
const TOURISM_TO_KIND = { hotel: 'hotel', motel: 'motel', resort: 'resort', camp_site: 'campground', caravan_site: 'campground', guest_house: 'hotel', bed_and_breakfast: 'hotel', inn: 'hotel', apartment: 'hotel', chalet: 'resort', cabin: 'resort' };
const NOMINATIM_KINDS = { 'leisure/slipway': 'ramp', 'amenity/boat_ramp': 'ramp', 'waterway/boat_ramp': 'ramp', 'leisure/marina': 'marina', 'leisure/park': 'park', 'boundary/national_park': 'park', 'boundary/protected_area': 'park', 'leisure/nature_reserve': 'park' };
const EXTRA_TAGS = {
  ramp: ['surface', 'fee', 'access', 'opening_hours', 'capacity', 'parking', 'tidal', 'description'],
  marina: ['surface', 'fee', 'access', 'opening_hours', 'capacity', 'fuel:diesel', 'fuel:gasoline', 'seamark:small_craft_facility:category', 'description'],
  hotel: ['stars', 'brand', 'rooms', 'opening_hours', 'internet_access', 'description'],
  motel: ['stars', 'brand', 'rooms', 'opening_hours', 'internet_access', 'description'],
  resort: ['stars', 'brand', 'rooms', 'opening_hours', 'internet_access', 'description'],
  campground: ['fee', 'opening_hours', 'capacity', 'tents', 'caravans', 'brand', 'description'],
  park: ['opening_hours', 'fee', 'access', 'description'],
  place: ['opening_hours', 'description'],
};
const MOTEL_WORDS = ['motel', 'motor inn', 'motor lodge', 'motor court', 'super 8', 'motel 6', 'red roof', 'econolodge', 'econo lodge', 'travelodge', 'days inn'];
const RESORT_WORDS = ['resort', 'spa ', ' spa', 'lodge', 'chalet', 'villa', 'retreat', 'plantation', 'ranch'];
const CAMPGROUND_WORDS = ['campground', 'rv park', 'rv resort', 'camp site', 'campsite'];
const HOTEL_CHAINS = ['holiday inn', 'best western', 'comfort inn', 'comfort suites', 'hampton inn', 'hilton', 'marriott', 'courtyard', 'fairfield', 'residence inn', 'springhill', 'hyatt', 'sheraton', 'westin', 'doubletree', 'embassy suites', 'la quinta', 'quality inn', 'days inn', 'super 8', 'motel 6', 'red roof', 'sleep inn', 'clarion', 'econolodge', 'econo lodge', 'ramada', 'wyndham', 'travelodge', 'microtel', 'candlewood', 'staybridge', 'homewood suites', 'towneplace', 'country inn', 'drury', 'four points', 'aloft', 'element', 'ac hotel'];
const PUBLIC_OPERATOR_WORDS = ['usace', 'corps of engineers', 'army corps', 'state', 'county', 'city of', 'department', 'parks', 'wildlife', 'fish and', 'port of', 'port authority', 'dnr', 'forest service', 'bureau of', 'national park'];
const CLOSED_NAME_WORDS = ['closed', 'demolished', 'decommissioned', 'under construction', 'coming soon', 'permanently closed', 'out of business', 'shut down'];
const LIFECYCLE_PREFIXES = ['disused:', 'abandoned:', 'demolished:', 'razed:', 'was:'];
const PRIVATE_ACCESS = ['private', 'no'];
const GENERIC_NAME_WORDS = new Set(['public', 'ramps', 'launches', 'boating', 'site', 'area', 'facility', 'a', 'boat', 'ramp', 'launch', 'launching', 'slipway', 'marina', 'dock', 'landing', 'access', 'hotel', 'motel', 'inn', 'suites', 'resort', 'lodge', 'campground', 'camp', 'park', 'rv', 'the', 'and', 'of', 'at', 'by', 'on']);

const RAMP_SELECTORS = [
  '["leisure"="slipway"]', '["amenity"="boat_ramp"]', '["leisure"="marina"]', '["waterway"="slipway"]', '["waterway"="boat_ramp"]',
  '["sport"="boat_launching"]', '["highway"="service"]["boat"="yes"]',
  '["seamark:type"="small_craft_facility"]["seamark:small_craft_facility:category"~"slipway|launching"]',
  '["leisure"="fishing"]["boat"="yes"]', '["amenity"="boat_rental"]', '["man_made"="pier"]["boat"="yes"]',
];
const PARK_SELECTORS = [
  '["leisure"="park"]["name"]', '["tourism"="camp_site"]["name"]', '["tourism"="caravan_site"]["name"]',
  '["boundary"="national_park"]["name"]', '["leisure"="nature_reserve"]["name"]',
  '["boundary"="protected_area"]["protection_title"~"[Pp]ark|[Rr]ecreation"]["name"]',
];
const LODGING_SELECTORS = [
  '["tourism"~"^(hotel|motel|resort|guest_house|bed_and_breakfast|apartment|chalet|cabin|camp_site|caravan_site)$"]',
  '["building"~"^(hotel|motel)$"]',
];

/* ── Small helpers ── */
const clamp = (v, [lo, , hi]) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(Math.trunc(n), hi)) : lo; };
// A name made only of generic words ("Boat Ramp", "Public Boat Launch") is treated as no name, so a real one gets built.
const cleanName = (raw) => { const n = String(raw ?? '').trim(); return n.length < POI_MIN_NAME_LEN || /^\d+$/.test(n) || !nameTokens(n).size ? '' : n; };
const nameTokens = (name) => new Set(name.toLowerCase().replace(/[^a-z0-9 ]+/g, '').split(/\s+/).filter((w) => w && !GENERIC_NAME_WORDS.has(w)));
const coordName = (label, lat, lon) => `${label} (${lat.toFixed(NAME_COORD_DECIMALS)}, ${lon.toFixed(NAME_COORD_DECIMALS)})`;
const label = (kind) => KIND_LABEL[kind] || KIND_LABEL.place;
const town = (addr) => first(addr, 'city', 'town', 'village', 'hamlet', 'municipality');
const point = (item) => { const lat = Number(item?.lat); const lon = Number(item?.lon); return validateCoords(lat, lon) ? [lat, lon] : null; };
const nearestRec = (records, lat, lon, maxMi) => { let best = null; let bestD = maxMi; for (const r of records) { const d = haversineMi(lat, lon, r.lat, r.lon); if (d < bestD) { best = r; bestD = d; } } return best; };
const rankKey = (r) => [QUALITY_RANK[r.quality] ?? 3, r.name_source === 'osm' ? 0 : 1, r.distance_mi || 0];
const rank = (records) => records.slice().sort((a, b) => { const ka = rankKey(a); const kb = rankKey(b); for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return 0; });
// v2: entries cached before 2.0.8 could name a ramp after its street; the new prefix skips them.
const cacheKey = (prefix, lat, lon, radius) => `poi2:${prefix}:${lat.toFixed(2)},${lon.toFixed(2)}:${radius}`;

/* ── OSM tag interpretation ── */
const osmName = (tags) => { for (const k of NAME_TAGS) { const n = cleanName(tags[k]); if (n) return n; } return ''; };
const osmAddress = (tags) => formatAddress(tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:state'], tags['addr:postcode']);
const cleanPhone = (raw) => { const f = String(raw ?? '').split(';')[0].trim(); return normalizePhone(f) || f; };
const osmPhone = (tags) => cleanPhone(first(tags, 'phone', 'contact:phone', 'contact:mobile'));
const osmWebsite = (tags) => first(tags, 'website', 'contact:website', 'url');
const extraTags = (kind, tags) => Object.fromEntries((EXTRA_TAGS[kind] || []).filter((k) => tags[k]).map((k) => [k, String(tags[k])]));
const isClosed = (tags, name) => Object.keys(tags).some((k) => LIFECYCLE_PREFIXES.some((p) => k.startsWith(p)))
  || ['closed', 'off'].includes(String(tags.opening_hours || '').trim().toLowerCase())
  || CLOSED_NAME_WORDS.some((w) => name.toLowerCase().includes(w));
const isHostel = (name, tags) => tags.tourism === 'hostel' || name.toLowerCase().includes('hostel');
const isPublicOperator = (op) => PUBLIC_OPERATOR_WORDS.some((w) => op.toLowerCase().includes(w));

function lodgingKind(name, tags) {
  const lower = name.toLowerCase();
  const tourism = tags.tourism || '';
  if (['camp_site', 'caravan_site'].includes(tourism) || CAMPGROUND_WORDS.some((w) => lower.includes(w))) return 'campground';
  const stars = Number(tags.stars) || 0;
  if (tourism === 'resort' || stars >= RESORT_MIN_STARS || RESORT_WORDS.some((w) => lower.includes(w))) return 'resort';
  if (tourism === 'motel' || tags.building === 'motel' || MOTEL_WORDS.some((w) => lower.includes(w))) return 'motel';
  return TOURISM_TO_KIND[tourism] || 'hotel';
}

export function qualityScore(kind, tags) {
  const name = tags.name || '';
  const phone = Boolean(tags.phone || tags['contact:phone']);
  const website = Boolean(tags.website || tags['contact:website']);
  const hasAddr = Boolean(tags['addr:full'] || (tags['addr:street'] && tags['addr:city']));
  const operator = tags.operator || '';
  let score = name ? 1 : 0;
  if (LODGING_KINDS.includes(kind)) {
    const chain = HOTEL_CHAINS.some((c) => name.toLowerCase().includes(c));
    score += 2 * phone + 2 * hasAddr + 2 * website + 2 * chain;
    score += Number(Boolean(operator || tags.brand)) + Number(Boolean(tags.rooms || tags.stars)) + Number(Boolean(tags.opening_hours));
    if (!(phone || website || chain)) score = Math.max(0, score - 2);
  } else if (RAMP_KINDS.includes(kind)) {
    const surface = String(tags.surface || '').toLowerCase();
    score += 2 * Boolean(operator) + 2 * isPublicOperator(operator);
    score += ['concrete', 'paved', 'asphalt'].includes(surface) ? 2 : Number(['gravel', 'compacted'].includes(surface));
    score += Number(Boolean(tags.fee)) + Number(['public', 'yes'].includes(String(tags.access || '').toLowerCase()));
    score += Number(Boolean(tags.opening_hours)) + Number(Boolean(tags.capacity || tags.parking));
    score += Number(phone) + Number(website);
    if (kind === 'marina') score += 1 + Number(Boolean(tags['fuel:diesel'] || tags['fuel:gasoline']));
  } else {
    score += 2 * Boolean(operator) + 2 * isPublicOperator(operator) + 2 * hasAddr;
    score += Number(phone) + Number(website) + Number(Boolean(tags.opening_hours));
  }
  if (score >= QUALITY_VERIFIED_MIN) return 'verified';
  return score >= QUALITY_LIKELY_MIN ? 'likely' : 'unverified';
}

/* ── Record construction ── */
function newRecord(id, kind, name, nameSource, lat, lon, { address = '', phone = '', website = '', operator = '', tags = {}, quality = 'unverified', source = SOURCE_OSM, origin = null } = {}) {
  const rec = { id, kind, name, name_source: nameSource, lat, lon, address: address || '', phone: phone || '', website: website || '', operator: operator || '', tags, quality, source };
  if (origin) rec.distance_mi = Math.round(haversineMi(origin[0], origin[1], lat, lon) * 10) / 10;
  return rec;
}

function derivedName(lbl, tags, lat, lon, parks) {
  const operator = String(tags.operator || '').trim();
  if (operator) return `${operator} ${lbl}`;
  const park = nearestRec(parks, lat, lon, PARK_RAMP_LINK_MI);
  if (park) return `${park.name} ${lbl}`;
  const street = String(tags['addr:street'] || '').trim(); const city = String(tags['addr:city'] || '').trim();
  if (street && city) return `${lbl}${DASH}${street}, ${city}`;
  return coordName(lbl, lat, lon);
}

function elementPoint(el) {
  const center = el.lat != null ? el : (el.center || {});
  const pt = point(center);
  return pt && isInUs(...pt) ? pt : null;
}

function osmRecord(el, kind, origin, parks) {
  const tags = el.tags || {};
  const pt = elementPoint(el);
  if (!pt) return null;
  const [lat, lon] = pt;
  let name = osmName(tags);
  const nameSource = name ? 'osm' : 'derived';
  if (!name) name = derivedName(label(kind), tags, lat, lon, parks);
  return newRecord(`osm:${el.type}:${el.id}`, kind, name, nameSource, lat, lon, {
    address: osmAddress(tags), phone: osmPhone(tags), website: osmWebsite(tags), operator: tags.operator || '',
    tags: extraTags(kind, tags), quality: qualityScore(kind, tags), origin,
  });
}

function rampRecord(el, origin, parks) {
  const tags = el.tags || {};
  const kind = tags.leisure === 'marina' || tags.amenity === 'boat_rental' ? 'marina' : 'ramp';
  const name = osmName(tags);
  if (isClosed(tags, name)) return null;
  if (kind === 'ramp' && (PRIVATE_ACCESS.includes(String(tags.access || '').toLowerCase()) || name.toLowerCase().includes('private'))) return null;
  return osmRecord(el, kind, origin, parks);
}
function lodgingRecord(el, origin) {
  const tags = el.tags || {};
  const name = osmName(tags);
  if (isHostel(name, tags) || isClosed(tags, name)) return null;
  return osmRecord(el, lodgingKind(name, tags), origin, []);
}
function parkRecord(el, origin) {
  const tags = el.tags || {};
  if (isClosed(tags, osmName(tags))) return null;
  const rec = osmRecord(el, 'park', origin, []);
  if (rec) rec.tags.type = ['camp_site', 'caravan_site'].includes(tags.tourism) ? 'campground' : (first(tags, 'boundary', 'leisure') || 'park');
  return rec;
}

/* ── Dedup / linking ── */
function namesMatch(a, b) {
  const ta = nameTokens(a); const tb = nameTokens(b);
  if (!ta.size || !tb.size) return false;
  const sub = (x, y) => [...x].every((w) => y.has(w));
  return sub(ta, tb) || sub(tb, ta);
}
function samePlace(a, b) {
  if (a.id === b.id) return true;
  if (haversineMi(a.lat, a.lon, b.lat, b.lon) >= DEDUP_DISTANCE_MI) return false;
  if (a.name_source !== 'osm' || b.name_source !== 'osm') return true;
  return namesMatch(a.name, b.name);
}
function mergeInto(keep, dup) {
  for (const f of ['address', 'phone', 'website', 'operator']) if (!keep[f] && dup[f]) keep[f] = dup[f];
  for (const [k, v] of Object.entries(dup.tags || {})) if (!(k in keep.tags)) keep.tags[k] = v;
}
export function dedup(records) {
  const kept = [];
  for (const rec of rank(records)) {
    const dup = kept.find((k) => samePlace(k, rec));
    if (dup) mergeInto(dup, rec); else kept.push(rec);
  }
  return kept;
}
function linkParks(ramps, parks) {
  for (const ramp of ramps) { const park = nearestRec(parks, ramp.lat, ramp.lon, PARK_RAMP_LINK_MI); if (park) ramp.tags.park = park.name; }
  const linked = [];
  for (const park of parks) { const ramp = nearestRec(ramps, park.lat, park.lon, PARK_RAMP_LINK_MI); if (ramp) { park.tags.ramp_name = ramp.name; linked.push(park); } }
  return linked;
}

/* ── Overpass ── */
async function overpassElements(selectors, lat, lon, radiusM, limit) {
  const around = `(around:${Math.trunc(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const body = selectors.map((s) => `  nwr${s}${around};`).join('\n');
  const query = `[out:json][timeout:${OVERPASS_TIMEOUT}];\n(\n${body}\n);\nout center ${limit};`;
  const res = await overpass(query, OVERPASS_TIMEOUT);
  // A failed query must not read as "nothing here": let the caller report it (nothing is cached for it).
  if (res.unavailable) throw new Error('OpenStreetMap servers are busy — try again in a minute');
  return res.elements || [];
}

/* ── Geocoding ── */
const REVERSE_FIELDS = ['road', 'town', 'county', 'state', 'water', 'postcode', 'address'];
const emptyReverse = () => Object.fromEntries(REVERSE_FIELDS.map((f) => [f, '']));

function parseReverse(data) {
  const result = emptyReverse();
  if (!data || typeof data !== 'object' || data.error) return result;
  const addr = data.address || {};
  result.road = first(addr, 'road', 'pedestrian', 'footway', 'path', 'track');
  result.town = town(addr);
  result.county = addr.county || '';
  result.state = addr.state || '';
  result.postcode = addr.postcode || '';
  result.water = first(addr, 'water', 'bay', 'river', 'strait', 'reservoir', 'lake', 'sea');
  if (!result.water && data.category === 'natural' && data.type === 'water') result.water = data.name || '';
  result.address = formatAddress(addr.house_number, result.road, result.town, result.state, result.postcode);
  return result;
}

/** Reverse geocode once per coordinate (4 dp) via Nominatim; cached forever. Failures are not cached. */
export async function reverseGeocode(lat, lon) {
  if (!validateCoords(lat, lon)) return emptyReverse();
  const key = `reverse:${lat.toFixed(4)},${lon.toFixed(4)}`;
  try {
    const { value } = await cached(key, FOREVER, async () => parseReverse(await nominatimGet('reverse', { lat, lon, format: 'jsonv2', zoom: REVERSE_GEOCODE_ZOOM, addressdetails: 1 })));
    return { ...emptyReverse(), ...value };
  } catch (err) {
    console.debug('[lightkeeper] reverse geocode failed:', err?.message);
    return emptyReverse();
  }
}

/** US cities/towns by name → [{name, lat, lon, type}], cached forever. */
export async function geocode(q) {
  q = String(q || '').trim().slice(0, 200);
  if (q.length < SEARCH_MIN_QUERY_LEN) return [];
  const key = `geocode:${q.toLowerCase()}`;
  try {
    const { value } = await cached(key, FOREVER, async () => {
      const rows = await nominatimGet('search', { q, format: 'jsonv2', limit: GEOCODE_RESULT_LIMIT, countrycodes: 'us', featureType: 'settlement', addressdetails: 1 });
      const out = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        const pt = point(row);
        if (!pt || !isInUs(...pt)) continue;
        const name = row.name || String(row.display_name || '').split(',')[0].trim();
        const st = row.address?.state || '';
        out.push({ name: st ? `${name}, ${st}` : name, lat: pt[0], lon: pt[1], type: row.addresstype || row.type || '' });
      }
      return out;
    });
    return value;
  } catch { return []; }
}

/* ── Nominatim place search ── */
function nominatimKind(cls, typ, name) {
  if (cls === 'tourism' && TOURISM_TO_KIND[typ]) return lodgingKind(name, { tourism: typ });
  return NOMINATIM_KINDS[`${cls}/${typ}`] || 'place';
}
const PARK_ADDRESS_KEYS = ['leisure', 'park', 'nature_reserve', 'national_park', 'protected_area', 'tourism'];
const PARK_WORDS_RE = /\b(park|recreation|campground|reserve|refuge|wildlife area|access area|marina)\b/i;
function enclosingPark(addr) {
  for (const k of PARK_ADDRESS_KEYS) { const v = String(addr?.[k] || '').trim(); if (v && PARK_WORDS_RE.test(v)) return v; }
  return '';
}

function nominatimRecord(row, origin) {
  const pt = point(row);
  if (!pt || !isInUs(...pt)) return null;
  const cls = row.class || ''; const typ = row.type || '';
  const extratags = row.extratags || {};
  const addr = row.address || {};
  // Only the feature's own name counts: display_name starts with the street for unnamed features.
  let name = cleanName(row.name || extratags.name || '');
  if (isHostel(name, { tourism: cls === 'tourism' ? typ : '' })) return null;
  const kind = nominatimKind(cls, typ, name);
  const nameSource = name ? 'osm' : 'derived';
  if (!name) {
    // A ramp inside a park is named after the park, not after the nearest road or trail.
    const park = enclosingPark(addr);
    name = derivedName(label(kind), { ...extratags, 'addr:street': addr.road || '', 'addr:city': town(addr) }, ...pt, park ? [{ name: park, lat: pt[0], lon: pt[1] }] : []);
  }
  const tags = { ...extratags, name, 'addr:street': addr.road || '', 'addr:city': town(addr) };
  return newRecord(`nominatim:${row.osm_type}:${row.osm_id}`, kind, name, nameSource, pt[0], pt[1], {
    address: formatAddress(addr.house_number, addr.road, town(addr), addr.state, addr.postcode),
    phone: osmPhone(extratags), website: osmWebsite(extratags), operator: extratags.operator || '',
    tags: extraTags(kind, extratags), quality: qualityScore(kind, tags), source: SOURCE_NOMINATIM, origin,
  });
}

export async function searchPlaces(q, lat, lon) {
  q = String(q || '').trim().slice(0, 200);
  if (q.length < SEARCH_MIN_QUERY_LEN) return [];
  const origin = validateCoords(lat, lon) ? [lat, lon] : null;
  const key = `poi2:search:${q.toLowerCase()}:${origin ? `${lat.toFixed(2)},${lon.toFixed(2)}` : '0,0'}`;
  try {
    const { value } = await cached(key, POI_LIST_TTL, async () => {
      const params = { q, format: 'jsonv2', limit: SEARCH_RESULT_LIMIT, addressdetails: 1, extratags: 1, countrycodes: 'us' };
      if (origin) { params.viewbox = `${lon - SEARCH_BIAS_DEG},${lat + SEARCH_BIAS_DEG},${lon + SEARCH_BIAS_DEG},${lat - SEARCH_BIAS_DEG}`; params.bounded = 0; }
      const rows = await nominatimGet('search', params);
      const records = (Array.isArray(rows) ? rows : []).map((r) => nominatimRecord(r, origin)).filter(Boolean);
      return rank(dedup(records));
    });
    return value;
  } catch (err) { console.warn('[lightkeeper] place search failed:', err?.message); return []; }
}

/* ── Enrichment ── */
const hasPlaceholderName = (item) => item.name === coordName(label(item.kind || ''), item.lat, item.lon);
function normalizeItem(item, pt) {
  [item.lat, item.lon] = pt;
  for (const f of ['address', 'phone', 'website', 'operator']) item[f] = String(item[f] || '');
  item.tags = item.tags && typeof item.tags === 'object' ? item.tags : {};
  item.phone = cleanPhone(item.phone);
  if (!cleanName(item.name)) { item.name = coordName(label(item.kind || ''), ...pt); item.name_source = 'derived'; }
  if (!item.name_source) item.name_source = 'osm';
}
function applyGeocode(item, geo) {
  if (!item.address && geo.address) item.address = geo.address;
  if (hasPlaceholderName(item)) {
    const lbl = label(item.kind || '');
    if (geo.road) { item.name = `${lbl}${DASH}${geo.road}${geo.town ? `, ${geo.town}` : ''}`; item.name_source = 'geocode'; }
    else if (geo.water) { item.name = `${lbl}${DASH}${geo.water}`; item.name_source = 'geocode'; }
  }
}

/** Fill missing name/address in place (placeholder-named items first, ≤ maxLookups reverse geocodes). */
export async function enrich(items, maxLookups = ENRICH_MAX_LOOKUPS) {
  const pending = [];
  for (const item of items) {
    const pt = item && typeof item === 'object' ? point(item) : null;
    if (!pt) continue;
    normalizeItem(item, pt);
    if (!item.address || hasPlaceholderName(item)) pending.push(item);
  }
  pending.sort((a, b) => Number(!hasPlaceholderName(a)) - Number(!hasPlaceholderName(b)));
  const todo = pending.slice(0, Math.max(0, maxLookups));
  const geos = await Promise.all(todo.map((it) => reverseGeocode(it.lat, it.lon)));
  todo.forEach((item, i) => applyGeocode(item, geos[i]));
  return items;
}

/* ── Shipped places (lightkeeper/data/DISTRICT_<id>_<Name>_Places.json, crawled weekly by tools/build_pois.py) ── */
const SHIPPED_TTL = DAY;
const shippedMemo = new Map();
async function shippedDistrict(id) {
  if (!shippedMemo.has(id)) {
    shippedMemo.set(id, (async () => {
      const m = await manifest().catch(() => null);
      const entry = m?.places?.[id];
      if (!entry?.file) return [];       // not published for this district (yet)
      const list = await staticJson(entry.file, SHIPPED_TTL).catch(() => []);
      return Array.isArray(list) ? list : [];
    })());
  }
  return shippedMemo.get(id);
}
/** Pre-crawled places of every district whose bounds contain the point ([] when none are published yet). */
async function shippedPlaces(lat, lon) {
  const all = await districtList().catch(() => []);
  const ids = all.filter((d) => (d.bounds || []).some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n)).map((d) => d.id);
  return (await Promise.all(ids.map(shippedDistrict))).flat();
}
function withinRadius(records, lat, lon, radiusM) {
  const limitMi = radiusM / METERS_PER_MILE;
  const out = [];
  for (const r of records) {
    const d = haversineMi(lat, lon, r.lat, r.lon);
    if (d <= limitMi) out.push({ ...r, tags: { ...(r.tags || {}) }, address: r.address || '', phone: r.phone || '', website: r.website || '', operator: r.operator || '', distance_mi: Math.round(d * 10) / 10 });
  }
  return out;
}

/* ── Fallback sources when Overpass is busy (same order as the desktop poi.py) ── */
const PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_TIMEOUT_MS = 3000;
const PHOTON_TAGS = {
  ramp: ['leisure:slipway'], marina: ['leisure:marina'],
  hotel: ['tourism:hotel', 'tourism:guest_house'], motel: ['tourism:motel'], resort: ['tourism:resort'],
  campground: ['tourism:camp_site'], park: ['leisure:park', 'boundary:national_park'],
};
const TYPE_KIND = {
  hotel: 'hotel', motel: 'motel', resort: 'resort', guest_house: 'hotel', camp_site: 'campground', caravan_site: 'campground',
  slipway: 'ramp', boat_ramp: 'ramp', marina: 'marina', park: 'park', national_park: 'park',
};
const NOMINATIM_TERMS = { ramp: 'boat ramp', marina: 'marina', hotel: 'hotel', motel: 'motel', campground: 'campground', park: 'park' };
const OSM_TYPE = { N: 'node', W: 'way', R: 'relation' };

/** Photon (komoot): OSM search with tag filters, every tag query in parallel, 3 s each. Throws only if all fail. */
async function photonPlaces(kinds, lat, lon, radiusM) {
  const deg = radiusM / 111320;
  const bbox = `${lon - deg},${lat - deg},${lon + deg},${lat + deg}`;
  const jobs = [];
  for (const kind of kinds) {
    for (const tag of PHOTON_TAGS[kind] || []) {
      jobs.push(getJson(`${PHOTON_URL}?${qs({ q: kind, osm_tag: tag, bbox, limit: 50, lat: lat.toFixed(4), lon: lon.toFixed(4) })}`, { timeoutMs: PHOTON_TIMEOUT_MS }));
    }
  }
  const results = await Promise.allSettled(jobs);
  if (!results.some((r) => r.status === 'fulfilled')) throw new Error('Photon unavailable');
  const found = [];
  for (const r of results) {
    for (const f of r.status === 'fulfilled' ? r.value?.features || [] : []) {
      const pr = f.properties || {};
      const [plon, plat] = f.geometry?.coordinates || [];
      const name = cleanName(pr.name);
      if (!name || !validateCoords(plat, plon) || !isInUs(plat, plon) || isHostel(name, { tourism: pr.osm_value || '' })) continue;
      const kind = TYPE_KIND[pr.osm_value];   // the place's own tag decides its kind
      if (!kind || !kinds.includes(kind)) continue;
      const address = formatAddress(pr.housenumber, pr.street, pr.city || pr.town || pr.village || pr.locality, pr.state, pr.postcode);
      found.push(newRecord(`osm:${OSM_TYPE[pr.osm_type] || 'node'}:${pr.osm_id}`, kind, name, 'osm', plat, plon,
        { address, quality: address ? 'likely' : 'unverified', source: 'OpenStreetMap (Photon)', origin: [lat, lon] }));
    }
  }
  return withinRadius(found, lat, lon, radiusM);
}

const categoryMemo = new Map();   // "term|viewbox" -> request: hotels and parks share "campground", reloads share all
function nominatimCategory(q, viewbox) {
  const key = `${q}|${viewbox}`;
  if (!categoryMemo.has(key)) {
    const req = nominatimGet('search', { q, format: 'jsonv2', bounded: 1, viewbox, limit: 40, countrycodes: 'us', addressdetails: 1, extratags: 1 });
    categoryMemo.set(key, req);
    req.then(() => setTimeout(() => categoryMemo.delete(key), POI_LIST_TTL), () => categoryMemo.delete(key));
  }
  return categoryMemo.get(key);
}

/** Nominatim bounded category search ("boat ramp", "hotel", …) — 1 request per second through the shared queue. */
async function nominatimPlaces(kinds, lat, lon, radiusM) {
  const deg = radiusM / 111320;
  const viewbox = `${lon - deg},${lat + deg},${lon + deg},${lat - deg}`;
  const terms = [...new Set(kinds.map((k) => NOMINATIM_TERMS[k]).filter(Boolean))];
  const results = await Promise.allSettled(terms.map((q) => nominatimCategory(q, viewbox)));
  if (!results.some((r) => r.status === 'fulfilled')) throw new Error('Nominatim unavailable');
  const found = [];
  for (const r of results) {
    for (const row of r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []) {
      // nominatimRecord names an unnamed feature "Boat Ramp – <road>, <town>", never after the bare street.
      const rec = nominatimRecord(row, [lat, lon]);
      if (!rec) continue;
      const kind = TYPE_KIND[row.type] || rec.kind;
      if (!kinds.includes(kind)) continue;
      if (rec.name_source !== 'osm' && rec.name.startsWith(KIND_LABEL.place)) rec.name = label(kind) + rec.name.slice(KIND_LABEL.place.length);
      rec.kind = kind;
      found.push(rec);
    }
  }
  return withinRadius(found, lat, lon, radiusM);
}

/* ── Live Overpass loads (full naming, dedup, park linking) ── */
async function liveRampsAndParks(lat, lon, radiusM) {
  const origin = [lat, lon];
  const [rampEls, parkEls] = await Promise.all([
    overpassElements(RAMP_SELECTORS, lat, lon, radiusM, OVERPASS_RAMP_LIMIT),
    overpassElements(PARK_SELECTORS, lat, lon, radiusM, OVERPASS_PARK_LIMIT),
  ]);
  const parkRecs = dedup(parkEls.map((el) => parkRecord(el, origin)).filter(Boolean));
  let rampRecs = dedup(rampEls.map((el) => rampRecord(el, origin, parkRecs)).filter(Boolean));
  const linked = rank(linkParks(rampRecs, parkRecs)).slice(0, MAX_LAUNCHES_TOTAL);
  rampRecs = rank(rampRecs).slice(0, MAX_LAUNCHES_TOTAL);
  await enrich(rampRecs, FETCH_GEOCODE_LOOKUPS);
  return { ramps: rampRecs, parks: linked };
}
async function liveHotels(lat, lon, radius) {
  const origin = [lat, lon];
  const elements = await overpassElements(LODGING_SELECTORS, lat, lon, radius, OVERPASS_LODGING_LIMIT);
  const hotels = rank(dedup(elements.map((el) => lodgingRecord(el, origin)).filter(Boolean)));
  await enrich(hotels.slice(0, MAX_HOTELS_TOTAL), FETCH_GEOCODE_LOOKUPS);
  return hotels;
}

/* ── One answer within PLACES_BUDGET_MS: first non-empty source wins, Overpass keeps refreshing the cache ── */
const PLACES_BUDGET_MS = 6000;
const PLACES_GRACE_MS = 10000;
const LIVE_TTL = 7 * DAY;
const QUICK_TTL = POI_LIST_TTL;
const liveRuns = new Map();          // key -> the running Overpass load for an area (one at a time)

/** Start (or join) the Overpass load for an area; its result lands in IndexedDB for the next request. */
function startLive(key, loader) {
  if (!liveRuns.has(key)) {
    const run = loader().then(async (v) => { await idbSet(key, v); return v; });
    run.catch(() => {}).finally(() => liveRuns.delete(key));
    liveRuns.set(key, run);
  }
  return liveRuns.get(key);
}

/** Resolve with the first non-empty list, or once every source settled. If the budget runs out while sources are
 *  still working and none has answered, keep waiting up to `graceMs` more rather than calling it unavailable. */
function firstNonEmpty(sources, budgetMs, graceMs) {
  return new Promise((resolve) => {
    let pending = sources.length;
    let anyOk = false;
    let finished = false;
    const finish = (items) => { if (!finished) { finished = true; clearTimeout(timer); resolve({ items, anyOk }); } };
    let timer = setTimeout(function onBudget() {
      if (anyOk || pending === 0) finish([]);                // a source answered "nothing here" in time
      else timer = setTimeout(() => finish([]), graceMs);   // all still working (e.g. the Nominatim queue): wait a bit more
    }, budgetMs);
    for (const p of sources) {
      p.then((items) => {
        anyOk = true;
        if (items?.length) finish(items);
      }, () => {}).finally(() => { if (--pending === 0) finish([]); });
    }
  });
}

/**
 * Places of `kinds` around a point.
 *   1. pre-built district file (instant), merged with the last Overpass answer — Overpass refreshes in the background
 *   2. otherwise Overpass, Photon and Nominatim at once; the first non-empty answer inside the budget wins
 *   3. otherwise the last cached answer for the area, or [] when a source answered "nothing here"
 * Throws (→ the chip shows "unavailable") only when every source failed and nothing is cached.
 */
async function gather({ kinds, lat, lon, radiusM, liveKey, live, pick }) {
  const fromLive = (v) => rank((pick(v) || []).filter((r) => kinds.includes(r.kind)));
  const shipped = rank(withinRadius(await shippedPlaces(lat, lon), lat, lon, radiusM).filter((r) => kinds.includes(r.kind)));
  const cachedLive = await idbGet(liveKey);
  const liveFresh = Boolean(cachedLive && Date.now() - cachedLive.at < LIVE_TTL);
  const livePromise = liveFresh ? null : startLive(liveKey, live);
  if (shipped.length) return rank(dedup(shipped.concat(cachedLive ? fromLive(cachedLive.value) : [])));
  if (liveFresh) return fromLive(cachedLive.value);

  const quickKey = `quick:${liveKey}:${kinds.join(',')}`;
  const quickHit = await idbGet(quickKey);
  if (quickHit && Date.now() - quickHit.at < QUICK_TTL && quickHit.value.length) return quickHit.value;

  const answer = await firstNonEmpty([
    livePromise.then(fromLive),
    photonPlaces(kinds, lat, lon, radiusM),
    nominatimPlaces(kinds, lat, lon, radiusM),
  ], PLACES_BUDGET_MS, PLACES_GRACE_MS);
  if (answer.items.length) {
    const items = rank(dedup(answer.items));
    await idbSet(quickKey, items);
    return items;
  }
  const stale = cachedLive ? fromLive(cachedLive.value) : (quickHit?.value || []);
  if (stale.length) return stale;
  if (answer.anyOk) return [];
  throw new Error('Map data sources are not responding; showing cached places if any');
}

export async function fetchRamps(lat, lon, radiusM) {
  const r = clamp(radiusM ?? LAUNCH_RADIUS[1], LAUNCH_RADIUS);
  const items = await gather({ kinds: RAMP_KINDS, lat, lon, radiusM: r, liveKey: `live:${cacheKey('ramps+parks', lat, lon, r)}`, live: () => liveRampsAndParks(lat, lon, r), pick: (v) => v?.ramps });
  return items.slice(0, MAX_LAUNCHES_TOTAL);
}
export async function fetchParks(lat, lon, radiusM) {
  const r = clamp(radiusM ?? LAUNCH_RADIUS[1], LAUNCH_RADIUS);
  const items = await gather({ kinds: ['park', 'campground'], lat, lon, radiusM: r, liveKey: `live:${cacheKey('ramps+parks', lat, lon, r)}`, live: () => liveRampsAndParks(lat, lon, r), pick: (v) => v?.parks });
  return items.map((p) => ({ ...p, kind: 'park' })).slice(0, MAX_LAUNCHES_TOTAL);
}
export async function fetchHotels(lat, lon, radiusM, types) {
  const r = clamp(radiusM ?? HOTEL_RADIUS[1], HOTEL_RADIUS);
  const wanted = new Set((types || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  const items = await gather({ kinds: LODGING_KINDS, lat, lon, radiusM: r, liveKey: `live:${cacheKey('hotels', lat, lon, r)}`, live: () => liveHotels(lat, lon, r), pick: (v) => v });
  return items.filter((h) => (wanted.size ? wanted.has(h.kind) : LODGING_KINDS.includes(h.kind))).slice(0, MAX_HOTELS_TOTAL);
}

export { METERS_PER_MILE };
