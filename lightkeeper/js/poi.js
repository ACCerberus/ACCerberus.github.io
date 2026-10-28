/** Places layers: boat ramps / marinas, lodging, parks with ramps. Toggled by the top-bar chips. */

import { api } from './api.js?v=2.1.2-4';
import { $$, toast, debounce, store } from './ui.js?v=2.1.2-4';
import { map, layers, poiIcon, viewportRadiusM } from './map.js?v=2.1.2-4';
import { showPoi } from './detail.js?v=2.1.2-4';
import { getDistrict, districtAt } from './aids.js?v=2.1.2-4';

const LAYERS = {
  ramps: { path: '/api/poi/ramps', capM: 150000 },
  hotels: { path: '/api/poi/hotels', capM: 100000 },
  parks: { path: '/api/poi/parks', capM: 150000 },
};
const on = new Set((store.get('poiLayers', ['ramps', 'hotels', 'parks']) || []).filter((n) => n in LAYERS));   // all on by default
const items = { ramps: new Map(), hotels: new Map(), parks: new Map() };
// With one district picked, only that district's places show (the district of the nearest aid decides).
const inPickedDistrict = (p) => {
  const d = getDistrict(); if (!d) return true;
  const at = districtAt(p.lat, p.lon);
  return at === undefined || at === d;          // undefined: aids still loading, keep it for now
};
let generation = 0;

export function init() {
  for (const chip of $$('#layer-chips .chip[data-layer]')) {
    chip.classList.toggle('on', on.has(chip.dataset.layer));
    chip.addEventListener('click', () => toggle(chip.dataset.layer));
  }
  map.on('moveend', debounce(refreshAll, 700));
  document.addEventListener('district-changed', () => { for (const n of on) { layers[n].clearLayers(); items[n].clear(); } refreshAll(); });
  document.addEventListener('places-updated', () => { for (const n of on) { layers[n].clearLayers(); items[n].clear(); } refreshAll(); });
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

// The web edition answers within its own 6 s budget (pre-built data, Overpass, Photon, Nominatim — first non-empty
// wins), so the percent runs on that scale and holds at 95% until the answer arrives.
const PLACES_BUDGET_MS = 6000;
const UNAVAILABLE_TIP = 'Map data sources are not responding; showing cached places if any';
const RETRY_UNAVAILABLE_MS = 15000;
const retryTimers = {};

/** Show " · 37%" on the chip while its request is in flight. Returns a stop function. */
function startPercent(chip) {
  if (!chip) return () => {};
  const t0 = performance.now();
  let stopped = false;
  let shown = 0;
  const tick = () => {
    if (stopped) return;
    shown = Math.max(shown, Math.min(95, Math.round(((performance.now() - t0) / PLACES_BUDGET_MS) * 100)));  // never goes backwards
    setCount(chip, null, `${shown}%`);
    setTimeout(tick, 120);
  };
  tick();
  return () => { stopped = true; };
}

function refreshAll() { for (const name of on) refresh(name); }

const inflight = {};      // layer -> true while a request is running
const again = {};         // layer -> the map moved during that request; run once more afterwards

async function refresh(name) {
  const chip = document.querySelector(`#layer-chips .chip[data-layer="${name}"]`);
  if (!on.has(name)) return;
  if (inflight[name]) { again[name] = true; return; }   // one request per layer; keeps the percent steady
  inflight[name] = true;
  const gen = ++generation;
  const c = map.getCenter();
  chip?.classList.add('busy');
  const stopProgress = startPercent(chip);
  try {
    const data = await api.get(LAYERS[name].path, { lat: c.lat.toFixed(5), lon: c.lng.toFixed(5), radius_m: viewportRadiusM(LAYERS[name].capM), fast: 1 });
    if (gen !== generation && !on.has(name)) return;
    const shown = (data.items || []).filter(inPickedDistrict);
    for (const poi of shown) {
      if (items[name].has(poi.id)) continue;
      const m = L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.kind), title: poi.name });
      m.bindTooltip(poi.name, { direction: 'top', offset: [0, -12] });
      m.on('click', () => showPoi(poi));
      m.addTo(layers[name]);
      items[name].set(poi.id, { poi, marker: m });
    }
    stopProgress();
    if (chip && !chip.dataset.tip) chip.dataset.tip = chip.title;
    if (data.ok === false) {
      setCount(chip, null, 'unavailable');
      if (chip) chip.title = UNAVAILABLE_TIP;
      clearTimeout(retryTimers[name]);   // keep trying quietly in the background
      retryTimers[name] = setTimeout(() => { if (on.has(name)) refresh(name); }, RETRY_UNAVAILABLE_MS);
      return;
    }
    if (chip) chip.title = chip.dataset.tip;
    setCount(chip, shown.length);
  } catch (err) {
    toast(`${name}: ${err.message}`, 'warn');
  } finally {
    stopProgress();
    chip?.classList.remove('busy');
    inflight[name] = false;
    changed();
    if (again[name]) { again[name] = false; refresh(name); }
  }
}

/** Used by the search box: show a one-off place marker and open its detail. */
export function showSearchResult(poi) {
  layers.search.clearLayers();
  const m = L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.kind || 'park'), title: poi.name }).addTo(layers.search);
  m.on('click', () => showPoi(poi));
  showPoi(poi);
}
