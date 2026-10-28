/* LightKeeper web edition — service worker.
 *
 * App shell: network first, cached copy when offline.      Data files (./data/*.json): stale-while-revalidate.
 * Map tiles (OSM, Esri, OpenTopoMap, NOAA ENC): cache first, capped.   Live APIs (NOAA, USGS, NWS, Overpass,
 * Nominatim, Open-Meteo): never cached here — the page keeps those in IndexedDB with their own TTLs.
 */

const VERSION = 'lk-2.0.0-3';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const TILES = 'lk-tiles';
const TILE_LIMIT = 4000;
const BASE = new URL('./', self.location).pathname;

const SHELL_FILES = [
  './', './index.html', './about.html', './manifest.webmanifest', './changelog.json', './img/lighthouse.png',
  './css/app.css', './css/web.css', './css/landing.css',
  './js/app.js', './js/api.js', './js/ui.js', './js/map.js', './js/aids.js', './js/poi.js', './js/places.js', './js/measure.js',
  './js/trip.js', './js/water.js', './js/weather.js', './js/settings.js', './js/detail.js', './js/hover.js', './js/context.js',
  './js/geo.js', './js/chart.js', './js/whatsnew.js', './js/phone.js',
  './js/web/util.js', './js/web/store.js', './js/web/http.js', './js/web/aids.js', './js/web/poi.js', './js/web/water.js', './js/web/weather.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css', './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png', './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './vendor/markercluster/leaflet.markercluster.js', './vendor/markercluster/MarkerCluster.css', './vendor/markercluster/MarkerCluster.Default.css',
  './vendor/fonts/inter-400.woff2', './vendor/fonts/inter-500.woff2', './vendor/fonts/inter-600.woff2', './vendor/fonts/inter-700.woff2',
  './data/manifest.json', './data/districts.json', './data/stations-tide.json', './data/stations-current.json',
];
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com', 'tile.opentopomap.org', 'gis.charttools.noaa.gov'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map((f) => cache.add(new Request(f, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== DATA && key !== TILES) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => { if (event.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(BASE)) {
    event.respondWith(url.pathname.startsWith(`${BASE}data/`) ? staleWhileRevalidate(req, DATA) : networkFirst(req, SHELL));
  } else if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(cacheFirstTile(req));
  }
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((resp) => { if (resp.ok) cache.put(req, resp.clone()); return resp; }).catch(() => null);
  if (hit) { refresh.catch(() => {}); return hit; }
  const resp = await refresh;
  if (resp) return resp;
  return new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
}

let tileCount = null;
async function cacheFirstTile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok) {
    cache.put(req, resp.clone());
    trimTiles(cache).catch(() => {});
  }
  return resp;
}

async function trimTiles(cache) {
  if (tileCount == null) tileCount = (await cache.keys()).length;
  tileCount += 1;
  if (tileCount <= TILE_LIMIT) return;
  const keys = await cache.keys();
  const excess = keys.length - Math.round(TILE_LIMIT * 0.9);
  for (const key of keys.slice(0, Math.max(0, excess))) await cache.delete(key);
  tileCount = (await cache.keys()).length;
}
