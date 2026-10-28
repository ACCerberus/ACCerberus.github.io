/** Places layers: boat ramps / marinas, lodging, parks with ramps. Toggled by the top-bar chips. */

import { api } from './api.js?v=2.0.7';
import { $$, toast, debounce, store } from './ui.js?v=2.0.7';
import { map, layers, poiIcon, viewportRadiusM } from './map.js?v=2.0.7';
import { showPoi } from './detail.js?v=2.0.7';

const MIN_ZOOM = 8;
const LAYERS = {
  ramps: { path: '/api/poi/ramps', capM: 150000 },
  hotels: { path: '/api/poi/hotels', capM: 100000 },
  parks: { path: '/api/poi/parks', capM: 150000 },
};
const on = new Set((store.get('poiLayers', ['ramps', 'hotels', 'parks']) || []).filter((n) => n in LAYERS));   // all on by default
const items = { ramps: new Map(), hotels: new Map(), parks: new Map() };
let generation = 0;

export function init() {
  for (const chip of $$('#layer-chips .chip[data-layer]')) {
    chip.classList.toggle('on', on.has(chip.dataset.layer));
    chip.addEventListener('click', () => toggle(chip.dataset.layer));
  }
  map.on('moveend', debounce(refreshAll, 700));
  refreshAll();
}

/** Turn a places layer on (if off) and load it around the current view. */
export function enableLayer(name) {
  if (!on.has(name)) toggle(name); else refresh(name);
}
export const toggleLayer = (name) => toggle(name);
export const isOn = (name) => on.has(name);
export const loadedItems = (name) => Array.from(items[name].values(), (x) => x.poi);
const changed = () => window.dispatchEvent(new CustomEvent('lk:places'));

const LABEL = { ramps: 'boat ramps', hotels: 'hotels', parks: 'parks' };

function toggle(name) {
  if (!(name in LAYERS)) return;
  if (on.has(name)) { on.delete(name); layers[name].clearLayers(); items[name].clear(); setCount(document.querySelector(`#layer-chips .chip[data-layer="${name}"]`), null); }
  else {
    on.add(name);
    if (map.getZoom() < MIN_ZOOM) {
      // Places are loaded per view; zoom in so something can actually show up (moveend reloads).
      toast(`Zooming in to show ${LABEL[name]}`, 'info', 2000);
      map.setView(map.getCenter(), MIN_ZOOM + 1);
    } else refresh(name);
  }
  store.set('poiLayers', Array.from(on));
  $$('#layer-chips .chip[data-layer]').forEach((c) => c.classList.toggle('on', on.has(c.dataset.layer)));
  changed();
}

/** Chip label shows what is happening: spinner while loading, then a count or "none here". */
function setCount(chip, n) {
  if (!chip) return;
  let badge = chip.querySelector('.chip-count');
  if (!badge) { badge = document.createElement('span'); badge.className = 'chip-count'; chip.append(badge); }
  badge.textContent = n == null ? '' : n ? ` · ${n}` : ' · none here';
}

function refreshAll() { for (const name of on) refresh(name); }

async function refresh(name) {
  const chip = document.querySelector(`#layer-chips .chip[data-layer="${name}"]`);
  if (!on.has(name) || map.getZoom() < MIN_ZOOM) return;
  const gen = ++generation;
  const c = map.getCenter();
  chip?.classList.add('busy');
  setCount(chip, null);
  try {
    const data = await api.get(LAYERS[name].path, { lat: c.lat.toFixed(5), lon: c.lng.toFixed(5), radius_m: viewportRadiusM(LAYERS[name].capM), fast: 1 });
    if (gen !== generation && !on.has(name)) return;
    for (const poi of data.items || []) {
      if (items[name].has(poi.id)) continue;
      const m = L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.kind), title: poi.name });
      m.bindTooltip(poi.name, { direction: 'top', offset: [0, -12] });
      m.on('click', () => showPoi(poi));
      m.addTo(layers[name]);
      items[name].set(poi.id, { poi, marker: m });
    }
    if (data.ok === false) { setCount(chip, null); if (chip) chip.title = data.error || 'Places unavailable right now'; return; }
    setCount(chip, (data.items || []).length);
  } catch (err) {
    toast(`${name}: ${err.message}`, 'warn');
  } finally {
    chip?.classList.remove('busy');
    changed();
  }
}

/** Used by the search box: show a one-off place marker and open its detail. */
export function showSearchResult(poi) {
  layers.search.clearLayers();
  const m = L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.kind || 'park'), title: poi.name }).addTo(layers.search);
  m.on('click', () => showPoi(poi));
  showPoi(poi);
}
