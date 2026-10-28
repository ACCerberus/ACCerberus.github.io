/** Leaflet map setup: base layers (loaded straight from the public tile servers), NOAA ENC chart overlay,
 *  layer groups, icons. */

import { $$, store } from './ui.js?v=2.0.9-2';

const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 };

export const AID_COLORS = { light: '#f5c542', buoy: '#35c983', daybeacon: '#ff9a3c', bridge: '#94a3b8', other: '#64748b' };
export const DAY_COLORS = ['#4f9dff', '#35c983', '#ff9a3c', '#9b8cff', '#3ad0e8', '#ff5f6d', '#f5c542', '#f472b6', '#a3e635', '#fb7185'];
export const POI_GLYPH = { ramp: '⚓', marina: '⚓', hotel: '🛏', motel: '🛏', resort: '🛏', campground: '⛺', park: '🌲', dam: '▲', tide: '≋', current: '➤', gage: '◉' };

export let map;
export const layers = {};

// Street map is served natively to z19 and imagery to z19 in nearly all US coverage. The map allows
// zooming to z22 (street level); beyond the native zoom Leaflet upscales the last real tile.
export const MAX_ZOOM = 22;
const TILE_RETRIES = 3;
const TILE_OPTS = { maxZoom: MAX_ZOOM, crossOrigin: 'anonymous', updateWhenZooming: false, updateWhenIdle: false, keepBuffer: 4 };

/** Retry a failed tile a few times with a growing delay instead of leaving a blank square. */
function withRetry(layer) {
  layer.on('tileerror', ({ tile, coords }) => {
    const tries = Number(tile.dataset.tries || 0);
    if (tries >= TILE_RETRIES) return;
    tile.dataset.tries = String(tries + 1);
    setTimeout(() => { tile.src = `${layer.getTileUrl(coords)}${layer.getTileUrl(coords).includes('?') ? '&' : '?'}r=${tries + 1}`; }, 600 * (tries + 1));
  });
  return layer;
}
const xyz = (url, opts) => withRetry(L.tileLayer(url, { ...TILE_OPTS, ...opts }));
const bases = {
  osm: () => xyz('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }),
  // Imagery + Esri reference overlays (roads, place names). No baked-in business pins, so only our clickable markers show.
  sat: () => L.layerGroup([
    xyz('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' }),
    xyz('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, opacity: 0.9 }),
    xyz('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, opacity: 0.95, attribution: 'Esri' }),
  ]),
  topo: () => xyz('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { subdomains: 'abc', maxNativeZoom: 17, attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' }),
};
// NOAA ENC charts via the Maritime Chart Service WMS (the desktop app shows the same service through its proxy).
export const ENC_WMS_URL = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer';
let currentBase = null;
let currentBaseName = 'osm';
let charts = null;

/** Create the map once and restore the last view. */
export function createMap() {
  const saved = store.get('view', DEFAULT_VIEW);
  map = L.map('map', { zoomControl: true, preferCanvas: true, renderer: L.canvas({ tolerance: TAP_TOLERANCE }), worldCopyJump: true, attributionControl: true, maxZoom: MAX_ZOOM })
    .setView(saved.center, saved.zoom);
  map.zoomControl.setPosition('topright');
  setBase(store.get('base', 'osm'));
  if (store.get('charts', false)) setCharts(true);

  layers.aids = L.markerClusterGroup({
    chunkedLoading: true, chunkInterval: 80, maxClusterRadius: 44, disableClusteringAtZoom: 12,
    spiderfyOnMaxZoom: false, showCoverageOnHover: false, removeOutsideVisibleBounds: true,
  }).addTo(map);
  for (const name of ['ramps', 'hotels', 'parks', 'water', 'trip', 'measure', 'search', 'route']) {
    layers[name] = L.layerGroup().addTo(map);
  }
  map.on('moveend', () => store.set('view', { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }));
  // The grid shell can settle after Leaflet measures its container; keep the map in sync with its box.
  const fix = () => map.invalidateSize({ animate: false });
  new ResizeObserver(fix).observe(document.getElementById('map'));
  window.addEventListener('resize', fix);
  window.addEventListener('load', fix);
  for (const ms of [50, 300, 1000, 2500]) setTimeout(fix, ms);   // the grid can settle after first paint
  return map;
}

// "Loading map" overlay: shown only when tiles take longer than 250 ms (e.g. after a fast zoom), never stuck past 12 s.
let pendingLayers = 0; let veilTimer = null; let veilCap = null;
function veil(show) {
  const el = document.getElementById('map-veil'); if (!el) return;
  clearTimeout(veilTimer);
  if (show) { veilTimer = setTimeout(() => { el.hidden = false; }, 250); clearTimeout(veilCap); veilCap = setTimeout(() => { el.hidden = true; }, 12000); }
  else el.hidden = true;
}
function trackLoading(layer) {
  const list = layer instanceof L.LayerGroup ? layer.getLayers() : [layer];
  for (const l of list) {
    l.on('loading', () => { pendingLayers += 1; veil(true); });
    l.on('load', () => { pendingLayers = Math.max(0, pendingLayers - 1); if (!pendingLayers) veil(false); });
  }
}
export function setBase(name) {
  if (!bases[name]) name = 'osm';
  if (currentBase) map.removeLayer(currentBase);
  pendingLayers = 0; veil(false);
  currentBase = bases[name]();
  trackLoading(currentBase);
  currentBase.addTo(map);
  // Fixed stacking: imagery at the bottom, then roads, then place names; the chart overlay sits above all of them.
  // (Sending each layer to the back one by one reversed this and hid the road names under the satellite photo.)
  (currentBase.getLayers ? currentBase.getLayers() : [currentBase]).forEach((l, i) => l.setZIndex(i));
  currentBaseName = name;
  store.set('base', name);
  $$('#basemap-seg button').forEach((b) => b.classList.toggle('on', b.dataset.base === name));
}
export const getBase = () => currentBaseName;

/** Toggle the NOAA ENC chart overlay. */
export function setCharts(on) {
  if (on && !charts) {
    charts = withRetry(L.tileLayer.wms(ENC_WMS_URL, {
      layers: '0,1,2,3,4,5,6,7', format: 'image/png', transparent: true, opacity: 0.85, version: '1.3.0',
      // No crossOrigin: the chart service does not send CORS headers on every response, and the pixels are never read.
      maxZoom: MAX_ZOOM, maxNativeZoom: 19, attribution: 'Charts: NOAA ENC', zIndex: 10,
      updateWhenZooming: false, keepBuffer: 4,
    })).addTo(map);
    charts.on('tileerror', () => { if (!charts.__warned) { charts.__warned = true; console.warn('[lightkeeper] NOAA ENC chart tiles failed to load'); } });
  } else if (!on && charts) { map.removeLayer(charts); charts = null; }
  store.set('charts', Boolean(on));
  $$('[data-overlay="charts"]').forEach((b) => b.classList.toggle('on', Boolean(on)));
}
export const chartsOn = () => Boolean(charts);
/** Desktop-compatible toggle: flips (or forces) the chart overlay and returns the new state. */
export function toggleCharts(force) { setCharts(force ?? !charts); return Boolean(charts); }

/* ── Icons ── */
export function aidIcon(aid, selected = false) {
  const type = AID_COLORS[aid.aid_type] ? aid.aid_type : 'other';
  return L.divIcon({ className: '', html: `<div class="m ${type}${selected ? ' sel' : ''}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
}
/** Canvas circle style for aid markers — far cheaper than DOM icons for tens of thousands of aids. */
// Touch screens get bigger dots and an invisible tap margin, so one tap opens the aid.
const TOUCH = matchMedia('(pointer: coarse)').matches;
const AID_R = TOUCH ? 8 : 5;
const TAP_TOLERANCE = TOUCH ? 14 : 3;
export function aidStyle(aid, selected = false) {
  const color = AID_COLORS[aid.aid_type] || AID_COLORS.other;
  return selected
    ? { radius: AID_R + 2, color: '#4f9dff', weight: 3, fillColor: color, fillOpacity: 1 }
    : { radius: AID_R, color: 'rgba(255,255,255,.8)', weight: TOUCH ? 2 : 1.5, fillColor: color, fillOpacity: 1 };
}
export function poiIcon(kind) {
  return L.divIcon({ className: '', html: `<div class="m-poi ${kind}">${POI_GLYPH[kind] || '•'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}
export function dayIcon(dayIndex, label) {
  const color = DAY_COLORS[dayIndex % DAY_COLORS.length];
  return L.divIcon({ className: '', html: `<div class="m-day" style="background:${color}">${label}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
}
export function wpIcon(label) {
  return L.divIcon({ className: '', html: `<div class="m-poi wp">${label}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}

/* ── Helpers ── */
export function viewportBbox() {
  const b = map.getBounds();
  return `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
}
/** Radius in meters that covers the current viewport from its center (capped). */
export function viewportRadiusM(capM = 200000) {
  const b = map.getBounds();
  return Math.min(capM, Math.round(map.distance(b.getNorthWest(), b.getSouthEast()) / 2));
}
export function flyTo(lat, lon, zoom = 14) { map.flyTo([lat, lon], Math.max(map.getZoom(), zoom), { duration: 0.6 }); }
export function fitBounds(latlngs, pad = 40) { if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs), { padding: [pad, pad], maxZoom: 16 }); }
export function fitWSEN(w, s, e, n) { map.fitBounds([[s, w], [n, e]], { padding: [20, 20] }); }

/* ── My location ── */
const LOCATE_ZOOM = 14;
let locateLayer = null;
/** Center the map on the user's position and mark it. fallback() may return an approximate {lat, lon} (desktop: by IP). */
export function locateMe({ fallback = null, notify = () => {} } = {}) {
  if (!locateLayer) locateLayer = L.layerGroup().addTo(map);
  const show = (lat, lon, accuracyM, approx) => {
    locateLayer.clearLayers();
    if (accuracyM) L.circle([lat, lon], { radius: accuracyM, color: '#4f9dff', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(locateLayer);
    L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#4f9dff', fillOpacity: 1 })
      .bindTooltip(approx ? 'Approximate location' : 'You are here', { direction: 'top', offset: [0, -10] }).addTo(locateLayer);
    map.flyTo([lat, lon], approx ? Math.min(LOCATE_ZOOM, 11) : Math.max(map.getZoom(), LOCATE_ZOOM), { duration: 0.8 });
    if (approx) notify('Showing your approximate location (turn on location services for an exact fix)', 'info');
  };
  const tryFallback = async (why) => {
    const p = fallback ? await fallback().catch(() => null) : null;
    if (p?.lat != null) show(p.lat, p.lon, p.accuracy_m || 0, true);
    else notify(why, 'err');
  };
  if (!navigator.geolocation) { tryFallback('Location is not available on this device'); return; }
  notify('Finding your location…', 'info');
  navigator.geolocation.getCurrentPosition(
    (pos) => show(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, false),
    (err) => tryFallback(err.code === 1 ? 'Location permission is off — allow it in your browser or device settings' : 'Could not get your location'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}
