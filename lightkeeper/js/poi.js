/** Places layers: boat ramps / marinas, lodging, parks with ramps. Toggled by the top-bar chips. */

import { api } from './api.js?v=2.0.7-3';
import { $$, toast, debounce, store } from './ui.js?v=2.0.7-3';
import { map, layers, poiIcon, viewportRadiusM } from './map.js?v=2.0.7-3';
import { showPoi } from './detail.js?v=2.0.7-3';

const LAYERS = {
  // capM caps the search radius, so a zoomed-out view never asks Overpass for a whole state.
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
    refresh(name);
  }
  store.set('poiLayers', Array.from(on));
  $$('#layer-chips .chip[data-layer]').forEach((c) => c.classList.toggle('on', on.has(c.dataset.layer)));
  changed();
}

/** Chip label shows what is happening: spinner while loading, then a count or "none here". */
function setCount(chip, n, progress = '') {
  if (!chip) return;
  let badge = chip.querySelector('.chip-count');
  if (!badge) { badge = document.createElement('span'); badge.className = 'chip-count'; chip.append(badge); }
  badge.textContent = progress ? ` · ${progress}` : n == null ? '' : n ? ` · ${n}` : ' · none here';
}

// The web edition queries Overpass straight from the browser (no 4 s server budget), so the percent runs on an
// 8 s scale and holds at 95% until the data actually arrives.
const PLACES_BUDGET_MS = 8000;

/** Show " · 37%" on the chip while its request is in flight. Returns a stop function. */
function startPercent(chip) {
  if (!chip) return () => {};
  const t0 = performance.now();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const pct = Math.min(95, Math.round(((performance.now() - t0) / PLACES_BUDGET_MS) * 100));
    setCount(chip, null, `${pct}%`);
    setTimeout(tick, 120);
  };
  tick();
  return () => { stopped = true; };
}

function refreshAll() { for (const name of on) refresh(name); }

async function refresh(name) {
  const chip = document.querySelector(`#layer-chips .chip[data-layer="${name}"]`);
  if (!on.has(name)) return;
  const gen = ++generation;
  const c = map.getCenter();
  chip?.classList.add('busy');
  const stopProgress = startPercent(chip);
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
    stopProgress();
    if (data.ok === false) { setCount(chip, null); if (chip) chip.title = data.error || 'Places unavailable right now'; return; }
    setCount(chip, (data.items || []).length);
  } catch (err) {
    toast(`${name}: ${err.message}`, 'warn');
  } finally {
    stopProgress();
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
