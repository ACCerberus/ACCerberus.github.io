/** Boot: map, panels, top bar (search, district, base map, layer chips), status polling, shortcuts. */

import { api } from './api.js?v=2.0.8';
import { $, $$, el, fmt, toast, showPanel, currentPanel, setStatus, showProgress, hideProgress, debounce, store, dialog } from './ui.js?v=2.0.8';
import { locateMe, createMap, setBase, map, fitWSEN, flyTo, setCharts, chartsOn } from './map.js?v=2.0.8';
import { reportBug } from './settings.js?v=2.0.8';
import * as aids from './aids.js?v=2.0.8';
import * as poi from './poi.js?v=2.0.8';
import * as measure from './measure.js?v=2.0.8';
import * as trip from './trip.js?v=2.0.8';
import * as water from './water.js?v=2.0.8';
import * as weather from './weather.js?v=2.0.8';
import * as settings from './settings.js?v=2.0.8';
import * as hover from './hover.js?v=2.0.8';
import * as context from './context.js?v=2.0.8';
import * as places from './places.js?v=2.0.8';
import * as phone from './phone.js?v=2.0.8';
import * as whatsnew from './whatsnew.js?v=2.0.8';
import { hideDetail, clearRoute } from './detail.js?v=2.0.8';

const state = { districts: [], syncWasRunning: false, lastAidsTotal: -1, statusTimer: null };

function boot() {
  createMap();
  aids.init($('#view-aids'));
  trip.init($('#view-trip'));
  measure.init($('#view-measure'));
  water.init($('#view-water'));
  weather.init($('#view-weather'));
  settings.init($('#view-settings'));
  whatsnew.init($('#view-whatsnew'));
  places.init($('#view-places'));
  poi.init();
  hover.init();
  context.init();

  let tripNoticeShown = false;
  $('#rail button[data-panel="trip"]').addEventListener('click', () => {
    if (tripNoticeShown) return;
    tripNoticeShown = true;
    dialog('Trip planner — work in progress', [
      el('p', { text: 'Still figuring out some stuff here. You can try it, but expect rough edges in the day splits, ramp and lodging picks.' }),
      el('p', { class: 'muted', text: 'Found something off? Use the Bug button and let me know.' }),
    ], { okText: 'Got it' });
  });
  $$('#rail button[data-panel]').forEach((b) => b.addEventListener('click', () => {
    if (currentPanel() === b.dataset.panel && !document.body.classList.contains('panel-hidden')) document.body.classList.add('panel-hidden');
    else showPanel(b.dataset.panel);
  }));
  $('#rail-collapse').addEventListener('click', () => document.body.classList.toggle('panel-hidden'));
  $('#rail-bug').addEventListener('click', reportBug);
  const locate = () => locateMe({ fallback: null, notify: (msg, kind) => toast(msg, kind, 4000) });
  $$('#rail-locate, #tab-locate').forEach((b) => b.addEventListener('click', locate));
  window.addEventListener('lk-locate', locate);
  $$('#basemap-seg button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
  $('#chip-charts').addEventListener('click', () => setCharts(!chartsOn()));
  $('#rail-ver').textContent = document.body.dataset.version;
  showPanel(store.get('panel', 'aids'));
  $$('#rail button[data-panel]').forEach((b) => b.addEventListener('click', () => store.set('panel', b.dataset.panel)));

  map.on('mousemove', (e) => setStatus({ coords: fmt.coord(e.latlng.lat, e.latlng.lng, 4) }));
  map.on('moveend zoomend', updateViewStatus);
  updateViewStatus();

  initSearch();
  initDistricts();
  pollStatus();
  aids.loadAll({ silent: true });
  document.addEventListener('keydown', shortcuts);
  // Light List tables stream in from this site; the adapter reports progress through this event.
  window.addEventListener('lk:progress', (e) => (e.detail.done ? hideProgress() : showProgress(e.detail.text, e.detail.fraction)));
  phone.init();
  window.addEventListener('online', () => setStatus({ online: true }));
  window.addEventListener('offline', () => setStatus({ online: false }));
}

function updateViewStatus() {
  const c = map.getCenter();
  const d = state.districts.find((x) => (x.bounds || []).some(([w, s, e, n]) => c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n));
  setStatus({ zoom: map.getZoom(), district: d ? `D${d.id} ${d.name}` : '' });
}

/* ── Districts ── */
async function initDistricts() {
  const sel = $('#district-select');
  sel.append(el('option', { value: '', text: 'All districts' }));
  try {
    state.districts = await api.get('/api/districts');
    for (const d of state.districts) sel.append(el('option', { value: d.id, text: `D${d.id} · ${d.name}` }));
  } catch { /* offline before first run */ }
  const saved = store.get('district', '');
  if (saved && state.districts.some((d) => String(d.id) === String(saved))) { sel.value = String(saved); aids.setDistrict(Number(saved)); }
  sel.addEventListener('change', () => {
    const d = state.districts.find((x) => String(x.id) === sel.value);
    store.set('district', sel.value);
    aids.setDistrict(d ? d.id : null);
    if (d?.bounds?.length) { const [w, s, e, n] = d.bounds[0]; fitWSEN(w, s, e, n); }
  });
  updateViewStatus();
}

/* ── Search (aids + places) ── */
function initSearch() {
  const input = $('#search');
  const list = $('#search-results');
  let items = [];
  let active = -1;
  const close = () => { list.hidden = true; active = -1; };
  const pick = (it) => {
    close(); input.value = '';
    if (it.type === 'aid') aids.openAid(it.aid.objectid, { fly: true });
    else { flyTo(it.poi.lat, it.poi.lon, 13); poi.showSearchResult(it.poi); }
  };
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    const c = map.getCenter();
    const [a, p] = await Promise.allSettled([
      api.get('/api/aids', { q, limit: 8 }),
      api.get('/api/poi/search', { q, lat: c.lat.toFixed(4), lon: c.lng.toFixed(4) }),
    ]);
    items = [];
    for (const aid of a.value?.aids || []) items.push({ type: 'aid', aid, label: aid.aidname, kind: aid.aid_type, sub: aid.lightlistnumber ? `LL# ${aid.lightlistnumber}` : aid.waterway });
    for (const place of p.value?.items || []) items.push({ type: 'poi', poi: place, label: place.name, kind: place.kind, sub: place.address });
    list.innerHTML = '';
    if (!items.length) { list.append(el('li', { class: 'muted', text: 'No matches' })); list.hidden = false; return; }
    items.forEach((it, i) => list.append(el('li', { onclick: () => pick(it), onmouseenter: () => { active = i; highlight(); } }, [
      el('span', { class: 'kind', text: fmt.title(it.kind || '') }), el('span', { text: it.label }), it.sub ? el('span', { class: 'sub', text: it.sub }) : null,
    ])));
    list.hidden = false;
  }, 250);
  const highlight = () => $$('li', list).forEach((li, i) => li.classList.toggle('active', i === active));
  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (items.length && input.value) list.hidden = false; });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); highlight(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[active >= 0 ? active : 0]) pick(items[active >= 0 ? active : 0]);
    else if (e.key === 'Escape') close();
  });
  document.addEventListener('click', (e) => { if (!$('#search-wrap').contains(e.target)) close(); });
}

/* ── Status polling: drives the progress strip for downloads ── */
async function pollStatus() {
  let delay = 30000;
  try {
    const s = await api.get('/api/status');
    setStatus({ online: s.online, aids: `${fmt.int(s.aids_total)} aids` });
    const sync = s.sync || {};
    if (sync.running) {
      delay = 1500;
      const frac = sync.total ? sync.progress / sync.total : null;
      showProgress(`Downloading Light List — ${sync.message || sync.district_name || ''}${sync.total ? ` (${sync.progress}/${sync.total} files)` : ''}`, frac);
      state.syncWasRunning = true;
      if (s.aids_total !== state.lastAidsTotal && s.aids_total > 0) { state.lastAidsTotal = s.aids_total; aids.loadAll({ silent: true }); }
    } else if (state.syncWasRunning) {
      state.syncWasRunning = false;
      hideProgress();
      const ch = sync.changes || {};
      const changed = (ch.added || 0) + (ch.removed || 0) + (ch.moved || 0) + (ch.changed || 0);
      toast(changed ? `Light List updated: ${ch.added} added, ${ch.removed} removed, ${ch.moved} moved, ${ch.changed} changed` : (sync.message || 'Light List is up to date'), 'ok', 6000);
      aids.loadAll({ silent: true });
      settings.renderDistricts();
      state.districts = s.districts || state.districts;
    }
    if (!sync.running) {
      const [t, w] = await Promise.all([api.get('/api/tiles/status').catch(() => null), api.get('/api/warm/status').catch(() => null)]);
      const text = $('#progress-text').textContent;
      if (t?.active) { delay = Math.min(delay, 2000); showProgress(`Downloading map tiles ${t.done}/${t.total} (${t.cache_mb} MB cached)`, t.total ? t.done / t.total : null); settings.renderTiles(); }
      else if (w?.running) { delay = Math.min(delay, 2500); showProgress(w.message || 'Preparing offline cache…', w.total ? w.done / w.total : null); state.warmWasRunning = true; }
      else if (state.warmWasRunning) { state.warmWasRunning = false; hideProgress(); toast('Offline cache ready', 'ok'); settings.renderTiles(); }
      else if (t && (text.startsWith('Downloading map tiles') || text.startsWith('Caching'))) hideProgress();
    }
  } catch { setStatus({ online: false }); delay = 5000; }
  clearTimeout(state.statusTimer);
  state.statusTimer = setTimeout(pollStatus, delay);
}

/* ── Keyboard ── */
function shortcuts(e) {
  if (e.target.matches('input, textarea, select')) return;
  const keys = { a: 'aids', t: 'trip', m: 'measure', s: 'settings' };
  if (keys[e.key]) showPanel(keys[e.key]);
  else if (e.key === 'l') window.dispatchEvent(new Event('lk-locate'));
  else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'Escape') { hideDetail(); clearRoute(); }
}

boot();
