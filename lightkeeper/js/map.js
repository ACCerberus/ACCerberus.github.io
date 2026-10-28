/** Leaflet map setup: base layers (loaded straight from the public tile servers), NOAA ENC chart overlay,
 *  layer groups, icons. */

import { $$, store } from './ui.js';

const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 };

export const AID_COLORS = { light: '#f5c542', buoy: '#35c983', daybeacon: '#ff9a3c', bridge: '#94a3b8', other: '#64748b' };
export const DAY_COLORS = ['#4f9dff', '#35c983', '#ff9a3c', '#9b8cff', '#3ad0e8', '#ff5f6d', '#f5c542', '#f472b6', '#a3e635', '#fb7185'];
export const POI_GLYPH = { ramp: '⚓', marina: '⚓', hotel: '🛏', motel: '🛏', resort: '🛏', campground: '⛺', park: '🌲', dam: '▲', tide: '≋', current: '➤', gage: '◉' };

export let map;
export const layers = {};

// Street map is served natively to z19 and imagery to z19 in nearly all US coverage. The map allows
// zooming to z22 (street level); beyond the native zoom Leaflet upscales the last real tile.
export const MAX_ZOOM = 22;
const TILE_OPTS = { maxZoom: MAX_ZOOM, crossOrigin: 'anonymous' };
const bases = {
  osm: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { ...TILE_OPTS, maxNativeZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }),
  // Imagery + Esri reference overlays (roads, place names). No baked-in business pins, so only our clickable markers show.
  sat: () => L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { ...TILE_OPTS, maxNativeZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { ...TILE_OPTS, maxNativeZoom: 19, opacity: 0.9 }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { ...TILE_OPTS, maxNativeZoom: 19, opacity: 0.95, attribution: 'Esri' }),
  ]),
  topo: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { ...TILE_OPTS, subdomains: 'abc', maxNativeZoom: 17, attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' }),
};
// NOAA ENC charts via the Maritime Chart Service WMS (the desktop app shows the same service through its proxy).
export const ENC_WMS_URL = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer';
let currentBase = null;
let currentBaseName = 'osm';
let charts = null;

/** Create the map once and restore the last view. */
export function createMap() {
  const saved = store.get('view', DEFAULT_VIEW);
  map = L.map('map', { zoomControl: true, preferCanvas: true, worldCopyJump: true, attributionControl: true, maxZoom: MAX_ZOOM })
    .setView(saved.center, saved.zoom);
  map.zoomControl.setPosition('topright');
  setBase(store.get('base', 'osm'));
  if (store.get('charts', false)) setCharts(true);

  layers.aids = L.markerClusterGroup({
    chunkedLoading: true, chunkInterval: 80, maxClusterRadius: 44, disableClusteringAtZoom: 12,
    spiderfyOnMaxZoom: false, showCoverageOnHover: false, removeOutsideVisibleBounds: true,
  }).addTo(map);
  for (const name of ['ramps', 'hotels', 'parks', 'water', 'trip', 'measure', 'search']) {
    layers[name] = L.layerGroup().addTo(map);
  }
  map.on('moveend', () => store.set('view', { center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }));
  // The grid shell can settle after Leaflet measures its container; keep the map in sync with its box.
  new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(document.getElementById('map'));
  setTimeout(() => map.invalidateSize({ animate: false }), 50);
  return map;
}

export function setBase(name) {
  if (!bases[name]) name = 'osm';
  if (currentBase) map.removeLayer(currentBase);
  currentBase = bases[name]().addTo(map);
  currentBase.eachLayer ? currentBase.eachLayer((l) => l.bringToBack()) : currentBase.bringToBack();
  currentBaseName = name;
  store.set('base', name);
  $$('#basemap-seg button').forEach((b) => b.classList.toggle('on', b.dataset.base === name));
}
export const getBase = () => currentBaseName;

/** Toggle the NOAA ENC chart overlay. */
export function setCharts(on) {
  if (on && !charts) {
    charts = L.tileLayer.wms(ENC_WMS_URL, {
      layers: '0,1,2,3,4,5,6,7', format: 'image/png', transparent: true, opacity: 0.85, version: '1.3.0',
      maxZoom: MAX_ZOOM, maxNativeZoom: 19, attribution: 'Charts: NOAA ENC', crossOrigin: 'anonymous',
    }).addTo(map);
    charts.on('tileerror', () => { if (!charts.__warned) { charts.__warned = true; console.warn('[lightkeeper] NOAA ENC chart tiles failed to load'); } });
  } else if (!on && charts) { map.removeLayer(charts); charts = null; }
  store.set('charts', Boolean(on));
  $$('[data-overlay="charts"]').forEach((b) => b.classList.toggle('on', Boolean(on)));
}
export const chartsOn = () => Boolean(charts);

/* ── Icons ── */
export function aidIcon(aid, selected = false) {
  const type = AID_COLORS[aid.aid_type] ? aid.aid_type : 'other';
  return L.divIcon({ className: '', html: `<div class="m ${type}${selected ? ' sel' : ''}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
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
