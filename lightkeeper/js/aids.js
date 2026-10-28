/** Aids to Navigation: load from the backend, cluster on the map, list + select in the panel. */

import { api } from './api.js';
import { $, el, fmt, toast, panelSkeleton, debounce, setStatus } from './ui.js';
import { map, layers, aidIcon, flyTo, AID_COLORS } from './map.js';
import { showDetail, aidRecord, hideDetail } from './detail.js';

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
}
export const getDistrict = () => state.district;
const inDistrict = (aid) => !state.district || aid.district_id === state.district;
const selectionListeners = new Set();

export const getSelected = () => Array.from(state.selected.values());
export const isSelected = (id) => state.selected.has(id);
export const getAid = (id) => state.byId.get(id);
export const allAids = () => state.all;
export function onSelectionChange(fn) { selectionListeners.add(fn); }

export function init(view) {
  state.view = view;
  const { body } = panelSkeleton(view, 'Aids <span class="count" id="aids-count"></span>', 'USCG Light List — click an aid for details, tick it to add to a trip.');
  state.countEl = $('#aids-count');
  const search = el('input', { type: 'search', placeholder: 'Filter aids in view by name, LL#, waterway…', oninput: debounce((e) => { state.q = e.target.value.trim().toLowerCase(); state.shown = PAGE; renderList(); }, 150) });
  const pills = el('div', { class: 'pills' }, TYPES.map((t) => el('button', {
    class: 'pill on', dataset: { type: t }, html: `<span class="dot" style="background:${AID_COLORS[t]}"></span>${fmt.title(t)}s`,
    onclick: (e) => { const b = e.currentTarget; b.classList.toggle('on'); b.classList.contains('on') ? state.types.add(t) : state.types.delete(t); refreshMarkers(); renderList(); },
  })));
  const tools = el('div', { class: 'row' }, [
    el('button', { class: 'btn sm', text: 'Select all in view', onclick: () => selectMany(visibleAids().map((a) => a.objectid), true) }),
    el('button', { class: 'btn sm', text: 'Clear selection', onclick: clearSelection }),
  ]);
  state.listEl = el('div', { class: 'list' });
  body.append(el('div', { class: 'field' }, [search]), pills, tools, state.listEl);
  map.on('moveend', debounce(() => { state.shown = PAGE; renderList(); }, 200));
  layers.aids.on('click', (e) => openAid(e.layer.options.aidId));
}

/** Load every aid (slim) from the backend and rebuild the cluster layer. */
export async function loadAll({ silent = false } = {}) {
  try {
    const data = await api.get('/api/aids', { limit: 100000 }, { timeoutMs: 120000 });
    state.all = data.aids || [];
    state.byId = new Map(state.all.map((a) => [a.objectid, a]));
    for (const [id, aid] of state.selected) if (state.byId.has(id)) state.selected.set(id, state.byId.get(id)); else state.selected.delete(id);
    refreshMarkers();
    renderList();
    setStatus({ aids: `${fmt.int(state.all.length)} aids` });
    if (!silent) toast(`${fmt.int(state.all.length)} aids loaded`, 'ok');
  } catch (err) {
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
    const m = L.marker([aid.latitude, aid.longitude], { icon: aidIcon(aid, state.selected.has(aid.objectid)), aidId: aid.objectid, title: aid.aidname });
    state.markers.set(aid.objectid, m);
    markers.push(m);
  }
  layers.aids.addLayers(markers);
}

function visibleAids() {
  const b = map.getBounds();
  const q = state.q;
  return state.all.filter((a) => inDistrict(a) && (state.types.has(a.aid_type) || a.aid_type === 'other')
    && b.contains([a.latitude, a.longitude])
    && (!q || matches(a, q)));
}
const matches = (a, q) => (a.aidname || '').toLowerCase().includes(q) || (a.aidname || '').toLowerCase().replace(/\./g, '').includes(q)
  || String(a.lightlistnumber || '').startsWith(q) || (a.waterway || '').toLowerCase().includes(q);

function renderList() {
  if (!state.listEl) return;
  const visible = visibleAids().sort((a, b) => a.aidname.localeCompare(b.aidname));
  state.countEl.textContent = `${fmt.int(visible.length)} in view · ${state.selected.size} selected`;
  state.listEl.innerHTML = '';
  if (!visible.length) {
    state.listEl.append(el('div', { class: 'empty' }, [el('b', { text: state.all.length ? 'No aids in view' : 'No aids loaded yet' }), state.all.length ? 'Zoom or pan the map, or pick a district above.' : 'The Light List downloads automatically on first run.']));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const aid of visible.slice(0, state.shown)) frag.append(row(aid));
  state.listEl.append(frag);
  if (visible.length > state.shown) state.listEl.append(el('button', { class: 'btn sm block', text: `Show ${Math.min(PAGE, visible.length - state.shown)} more`, onclick: () => { state.shown += PAGE; renderList(); } }));
}

function row(aid) {
  const sel = state.selected.has(aid.objectid);
  return el('div', { class: `item${sel ? ' sel' : ''}`, dataset: { id: aid.objectid }, onclick: () => openAid(aid.objectid) }, [
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
    if (m) m.setIcon(aidIcon(aid, on));
    const rowEl = state.listEl?.querySelector(`.item[data-id="${id}"]`);
    if (rowEl) { rowEl.classList.toggle('sel', on); rowEl.querySelector('input').checked = on; }
  }
  state.countEl && (state.countEl.textContent = `${fmt.int(visibleAids().length)} in view · ${state.selected.size} selected`);
  selectionListeners.forEach((fn) => fn(getSelected()));
}
export function clearSelection() { selectMany(Array.from(state.selected.keys()), false); }

/* ── Detail ── */
export async function openAid(id, { fly = false } = {}) {
  let aid = state.byId.get(id);
  try { aid = { ...aid, ...(await api.get(`/api/aids/${id}`)) }; } catch { /* slim record is enough */ }
  if (!aid) return;
  if (fly) flyTo(aid.latitude, aid.longitude, 14);
  const sel = state.selected.has(id);
  const actions = document.body.classList.contains('phone') ? [] : [{ label: sel ? 'Remove from trip' : 'Add to trip', primary: !sel, onClick: () => { toggleSelect(id); openAid(id); } }];
  showDetail(aidRecord(aid, actions));
}
export function closeDetail() { hideDetail(); }
