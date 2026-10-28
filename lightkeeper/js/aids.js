/** Aids to Navigation: load from the backend, cluster on the map, list + select in the panel. */

import { api } from './api.js?v=2.0.9-4';
import { $, el, fmt, toast, panelSkeleton, debounce, setStatus } from './ui.js?v=2.0.9-4';
import { map, layers, aidStyle, flyTo, AID_COLORS } from './map.js?v=2.0.9-4';
import { showDetail, aidRecord, hideDetail, currentDetail } from './detail.js?v=2.0.9-4';

const TYPES = ['light', 'buoy', 'daybeacon', 'bridge'];
const PAGE = 200;
const state = {
  all: [], byId: new Map(), markers: new Map(), selected: new Map(),
  types: new Set(TYPES), q: '', shown: PAGE, listEl: null, countEl: null, view: null,
  district: null, // district id to show, or null for all
};

/** Restrict the map and list to one district (null = all districts). */
export function setDistrict(id) {
  state.district = id || null;
  state.shown = PAGE;
  refreshMarkers();
  renderList();
  document.dispatchEvent(new CustomEvent('district-changed', { detail: state.district }));
}
export const getDistrict = () => state.district;
const inDistrict = (aid) => !state.district || aid.district_id === state.district;
const selectionListeners = new Set();
const GRID_DEG = 0.25;
const grid = new Map();           // "row,col" -> aids[]  (rebuilt on loadAll)
function indexAids() {
  grid.clear();
  for (const a of state.all) {
    const key = `${Math.floor(a.latitude / GRID_DEG)},${Math.floor(a.longitude / GRID_DEG)}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(a);
  }
}
/** District of the aid nearest to a point (searching up to maxDeg away), or null if no aid is that close.
 *  Places use it so picking a district hides other districts' ramps, hotels and parks. */
export function districtAt(lat, lon, maxDeg = 3) {
  if (!grid.size) return undefined;                          // aids not loaded yet: unknown
  const span = Math.ceil(maxDeg / GRID_DEG);
  const r0 = Math.floor(lat / GRID_DEG); const c0 = Math.floor(lon / GRID_DEG);
  let best = null; let bestD = Infinity;
  for (let ring = 0; ring <= span; ring++) {
    for (let r = r0 - ring; r <= r0 + ring; r++) for (let c = c0 - ring; c <= c0 + ring; c++) {
      if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;   // only the new ring
      for (const a of grid.get(`${r},${c}`) || []) {
        const d = (a.latitude - lat) ** 2 + ((a.longitude - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
        if (d < bestD) { bestD = d; best = a; }
      }
    }
    if (best && Math.sqrt(bestD) <= ring * GRID_DEG) break;   // nothing in a farther ring can be closer
  }
  return best && Math.sqrt(bestD) <= maxDeg ? best.district_id : null;
}

function aidsInBounds(b) {
  const r0 = Math.floor(b.getSouth() / GRID_DEG); const r1 = Math.floor(b.getNorth() / GRID_DEG);
  const c0 = Math.floor(b.getWest() / GRID_DEG); const c1 = Math.floor(b.getEast() / GRID_DEG);
  if ((r1 - r0) * (c1 - c0) > 4000) return state.all;      // zoomed way out: just scan everything
  const out = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const bucket = grid.get(`${r},${c}`); if (bucket) out.push(...bucket); }
  return out;
}

export const getSelected = () => Array.from(state.selected.values());
export const isSelected = (id) => state.selected.has(id);
export const getAid = (id) => state.byId.get(id);
export const allAids = () => state.all;
export function onSelectionChange(fn) { selectionListeners.add(fn); }

export function init(view) {
  state.view = view;
  const { body } = panelSkeleton(view, 'Aids <span class="count" id="aids-count"></span>', 'USCG Light List — click an aid for details, tick it to add to a trip.');
  state.countEl = $('#aids-count');
  const pills = el('div', { class: 'pills' }, TYPES.map((t) => el('button', {
    class: 'pill on', dataset: { type: t }, html: `<span class="dot" style="background:${AID_COLORS[t]}"></span>${fmt.title(t)}s`,
    onclick: (e) => { const b = e.currentTarget; b.classList.toggle('on'); b.classList.contains('on') ? state.types.add(t) : state.types.delete(t); refreshMarkers(); renderList(); },
  })));
  const tools = el('div', { class: 'row' }, [
    el('button', { class: 'btn sm', text: 'Select all in view', onclick: () => selectMany(visibleAids().map((a) => a.objectid), true) }),
    el('button', { class: 'btn sm', text: 'Clear selection', onclick: clearSelection }),
  ]);
  state.listEl = el('div', { class: 'list' });
  body.append(pills, tools, state.listEl);   // searching lives in the top bar (one search box for aids and places)
  map.on('moveend', debounce(() => { state.shown = PAGE; renderList(); }, 200));
  layers.aids.on('click', (e) => openAid(e.layer.options.aidId));
}

/** Load every aid (slim) from the backend and rebuild the cluster layer. */
export async function loadAll({ silent = false } = {}) {
  try {
    if (state.district && !state.all.length) {
      // Show the district you were looking at first; the rest of the country follows right after.
      const first = await api.get('/api/aids', { districts: state.district, limit: 100000 }, { timeoutMs: 60000 });
      state.all = first.aids || [];
      state.byId = new Map(state.all.map((a) => [a.objectid, a]));
      indexAids();
      refreshMarkers();
      renderList();
    }
    const data = await api.get('/api/aids', { limit: 100000 }, { timeoutMs: 120000 });
    state.all = data.aids || [];
    state.byId = new Map(state.all.map((a) => [a.objectid, a]));
    indexAids();
    for (const [id, aid] of state.selected) if (state.byId.has(id)) state.selected.set(id, state.byId.get(id)); else state.selected.delete(id);
    refreshMarkers();
    renderList();
    setStatus({ aids: `${fmt.int(state.all.length)} aids` });
    if (!silent) toast(`${fmt.int(state.all.length)} aids loaded`, 'ok');
  } catch (err) {
    console.error('aids.loadAll failed', err);
    if (!silent) toast(`Could not load aids: ${err.message}`, 'err');
  }
}

function refreshMarkers() {
  layers.aids.clearLayers();
  state.markers.clear();
  const markers = [];
  for (const aid of state.all) {
    if (!inDistrict(aid)) continue;
    if (!state.types.has(aid.aid_type) && !(aid.aid_type === 'other' && state.types.size === TYPES.length)) continue;
    const m = L.circleMarker([aid.latitude, aid.longitude], { ...aidStyle(aid, state.selected.has(aid.objectid)), aidId: aid.objectid });
    m.bindTooltip(aid.aidname, { direction: 'top', offset: [0, -8] });
    state.markers.set(aid.objectid, m);
    markers.push(m);
  }
  layers.aids.addLayers(markers);
}

function visibleAids() {
  const b = map.getBounds();
  const q = state.q;
  if (q) return state.all.filter((a) => inDistrict(a) && matches(a, q));   // anywhere on the map, but only in the picked district
  return aidsInBounds(b).filter((a) => inDistrict(a) && (state.types.has(a.aid_type) || a.aid_type === 'other')
    && b.contains([a.latitude, a.longitude])
    && (!q || matches(a, q)));
}
const matches = (a, q) => (a.aidname || '').toLowerCase().includes(q) || (a.aidname || '').toLowerCase().replace(/\./g, '').includes(q)
  || String(a.lightlistnumber || '').toLowerCase().startsWith(q) || String(a.intl_llnr || '').toLowerCase().startsWith(q)
  || (a.waterway || '').toLowerCase().includes(q);

function renderList() {
  if (!state.listEl) return;
  const visible = visibleAids().sort((a, b) => a.aidname.localeCompare(b.aidname));
  state.countEl.textContent = `${fmt.int(visible.length)} ${state.q ? (state.district ? `found in D${state.district}` : 'found in all districts') : 'in view'} · ${state.selected.size} selected`;
  state.listEl.innerHTML = '';
  if (!visible.length) {
    state.listEl.append(el('div', { class: 'empty' }, [el('b', { text: !state.all.length ? 'No aids loaded yet' : state.q ? 'No aids match' : 'No aids in view' }), state.all.length ? 'Zoom or pan the map, or pick a district above.' : 'The Light List downloads automatically on first run.']));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const aid of visible.slice(0, state.shown)) frag.append(row(aid));
  state.listEl.append(frag);
  if (visible.length > state.shown) state.listEl.append(el('button', { class: 'btn sm block', text: `Show ${Math.min(PAGE, visible.length - state.shown)} more`, onclick: () => { state.shown += PAGE; renderList(); } }));
}

function row(aid) {
  const sel = state.selected.has(aid.objectid);
  return el('div', { class: `item${sel ? ' sel' : ''}`, dataset: { id: aid.objectid }, onclick: () => openAid(aid.objectid, { fly: !!state.q }) }, [
    el('input', { type: 'checkbox', checked: sel, onclick: (e) => { e.stopPropagation(); toggleSelect(aid.objectid); } }),
    el('span', { class: 'ico', style: `background:${AID_COLORS[aid.aid_type] || AID_COLORS.other}` }),
    el('div', { class: 'main' }, [
      el('div', { class: 'title', text: aid.aidname }),
      el('div', { class: 'sub', text: [aid.lightlistnumber ? `LL# ${aid.lightlistnumber}` : '', aid.characteristics, aid.waterway].filter(Boolean).join(' · ') }),
    ]),
  ]);
}

/* ── Selection ── */
export function toggleSelect(id) { selectMany([id], !state.selected.has(id)); }
export function selectMany(ids, on) {
  for (const id of ids) {
    const aid = state.byId.get(id);
    if (!aid) continue;
    if (on) state.selected.set(id, aid); else state.selected.delete(id);
    const m = state.markers.get(id);
    if (m) m.setStyle(aidStyle(aid, on));
    const rowEl = state.listEl?.querySelector(`.item[data-id="${id}"]`);
    if (rowEl) { rowEl.classList.toggle('sel', on); rowEl.querySelector('input').checked = on; }
  }
  state.countEl && (state.countEl.textContent = `${fmt.int(visibleAids().length)} in view · ${state.selected.size} selected`);
  selectionListeners.forEach((fn) => fn(getSelected()));
}
export function clearSelection() { selectMany(Array.from(state.selected.keys()), false); }

/* ── Detail ── */
export async function openAid(id, { fly = false } = {}) {
  const slim = state.byId.get(id);
  if (!slim) return;
  if (fly) flyTo(slim.latitude, slim.longitude, 14);
  const actions = () => {
    if (document.body.classList.contains('phone')) return [];   // no trip planning on phones
    const sel = state.selected.has(id);
    return [{ label: sel ? 'Remove from trip' : 'Add to trip', primary: !sel, onClick: () => { toggleSelect(id); openAid(id); } }];
  };
  // Show the card immediately from the record already in memory; never wait on the network to open it.
  const cached = fullCache.get(id);
  showDetail(aidRecord(cached || slim, actions()));
  if (cached) return;
  try {
    const full = { ...slim, ...(await api.get(`/api/aids/${id}`)) };
    fullCache.set(id, full);
    if (currentDetail()?.title === slim.aidname) showDetail(aidRecord(full, actions()));
  } catch { /* the slim record is enough */ }
}
const fullCache = new Map();
export function closeDetail() { hideDetail(); }
