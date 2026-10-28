/** Boot: map, panels, top bar (search, district, base map, layer chips), status polling, shortcuts. */

import { api } from './api.js?v=2.1.3-2';
import { $, $$, el, fmt, toast, showPanel, currentPanel, setStatus, showProgress, hideProgress, debounce, store, dialog } from './ui.js?v=2.1.3-2';
import { locateMe, createMap, setBase, map, fitWSEN, flyTo, setCharts, chartsOn, setLiteTiles } from './map.js?v=2.1.3-2';
import { reportBug } from './settings.js?v=2.1.3-2';
import * as aids from './aids.js?v=2.1.3-2';
import * as poi from './poi.js?v=2.1.3-2';
import * as measure from './measure.js?v=2.1.3-2';
import * as trip from './trip.js?v=2.1.3-2';
import * as water from './water.js?v=2.1.3-2';
import * as weather from './weather.js?v=2.1.3-2';
import * as settings from './settings.js?v=2.1.3-2';
import * as hover from './hover.js?v=2.1.3-2';
import * as context from './context.js?v=2.1.3-2';
import * as places from './places.js?v=2.1.3-2';
import * as phone from './phone.js?v=2.1.3-2';
import * as whatsnew from './whatsnew.js?v=2.1.3-2';
import * as discrep from './discrepancies.js?v=2.1.3-2';
import * as notices from './notices.js?v=2.1.3-2';
import * as netcheck from './netcheck.js?v=2.1.3-2';
import { initUpdater } from './web/updater.js?v=2.1.3-2';
import { hideDetail, clearRoute } from './detail.js?v=2.1.3-2';

const state = { districts: [], syncWasRunning: false, lastAidsTotal: -1, statusTimer: null };

function boot() {
  netcheck.check();     // timed test download; slow link -> Lite mode (see netcheck.js)
  // No browser right-click menu (Back, Save as, Inspect...) over the app; text boxes keep theirs for copy/paste,
  // and the map's own right-click menu still opens.
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea, [contenteditable="true"]')) e.preventDefault(); });
  createMap();
  aids.init($('#view-aids'));
  trip.init($('#view-trip'));
  measure.init($('#view-measure'));
  water.init($('#view-water'));
  weather.init($('#view-weather'));
  settings.init($('#view-settings'));
  whatsnew.init($('#view-whatsnew'));
  notices.init($('#view-bnm'));
  if (discrep.ENABLED) {
    $('[data-panel="discrep"]').hidden = false;
    discrep.init($('#view-discrep'));
    discrep.onChange((n) => { const b = $('#discrep-count'); if (b) { b.hidden = !n; b.textContent = n; } });
  } else {
    $('[data-panel="discrep"]')?.remove();
  }
  places.init($('#view-places'));
  poi.init();
  hover.init();
  context.init();

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
  const damsChip = $('#chip-dams');
  damsChip.classList.toggle('on', water.damsOn());
  damsChip.addEventListener('click', () => damsChip.classList.toggle('on', water.setDams(!water.damsOn())));
  $('#chip-charts').addEventListener('click', () => setCharts(!chartsOn()));
  $('#rail-ver').textContent = document.body.dataset.version;
  showPanel(store.get('panel', 'aids'));
  $$('#rail button[data-panel]').forEach((b) => b.addEventListener('click', () => store.set('panel', b.dataset.panel)));

  map.on('mousemove', (e) => setStatus({ coords: fmt.coord(e.latlng.lat, e.latlng.lng, 4) }));
  map.on('moveend zoomend', updateViewStatus);
  updateViewStatus();

  initSearch();
  pollStatus();
  // District first (saved, or guessed from the connection's location on first launch), then the aids.
  initDistricts().finally(() => aids.loadAll({ silent: true }));
  initNetMode();
  initUpdater();        // checks for a newer website build every 2 minutes
  document.addEventListener('keydown', shortcuts);
  // Light List tables stream in from this site; the adapter reports progress through this event.
  window.addEventListener('lk:progress', (e) => (e.detail.done ? hideProgress() : showProgress(e.detail.text, e.detail.fraction)));
  phone.init();
  window.addEventListener('online', () => setStatus({ online: true }));
  window.addEventListener('offline', () => setStatus({ online: false }));
  window.lkBooted = true;      // the page's startup safety net checks this
  const splash = document.getElementById('boot-splash');   // web edition's loading screen
  if (splash) { splash.classList.add('done'); setTimeout(() => splash.remove(), 300); }
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
  // Computers: our own drop-down (some desktop browsers never open the native list here). Phones keep the native picker.
  if (!matchMedia('(pointer: coarse)').matches) pickerFor(sel);
  const saved = store.get('district', null);
  if (saved && state.districts.some((d) => String(d.id) === String(saved))) { sel.value = String(saved); aids.setDistrict(Number(saved)); }
  sel.refreshPicker?.();
  let following = false;              // true while the map itself moved us into a new district
  sel.addEventListener('change', () => {
    const d = state.districts.find((x) => String(x.id) === sel.value);
    store.set('district', sel.value);
    aids.setDistrict(d ? d.id : null);
    if (!following && d?.bounds?.length) { const [w, s, e, n] = d.bounds[0]; fitWSEN(w, s, e, n); }
  });
  // Follow the map: wherever you scroll (zoomed in to regional level), the district there is picked for you and its
  // aids, places and notices fill in. The map doesn't jump; zoomed far out, nothing changes.
  map.on('moveend', debounce(() => {
    if (map.getZoom() < 7) return;
    const c = map.getCenter();
    const inside = (d) => (d.bounds || []).some(([w, s, e, n]) => c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n);
    const cur = state.districts.find((x) => String(x.id) === sel.value);
    if (cur && inside(cur)) return;
    const next = state.districts.find(inside);
    if (!next) return;
    sel.value = String(next.id);
    following = true;
    sel.dispatchEvent(new Event('change'));
    following = false;
    toast(`Now showing D${next.id} ${next.name}`, 'info', 2500);
  }, 800));
  updateViewStatus();
  // First launch: ask which district to view (the aids wait for the answer). Every later launch opens on the
  // last district used - picked here, at the top, or scrolled into on the map.
  if (saved === null && state.districts.length) await askDistrict(sel);
}

function askDistrict(sel) {
  return new Promise((resolve) => {
    let close = () => {};
    const pick = (id) => { close(); sel.value = String(id); sel.dispatchEvent(new Event('change')); resolve(); };
    const grid = el('div', { class: 'district-pick' }, [
      ...state.districts.map((d) => el('button', { type: 'button', class: 'btn', onclick: () => pick(d.id) }, [
        el('b', { text: `D${d.id} · ${d.name}` }), d.desc ? el('span', { class: 'muted small', text: d.desc }) : null,
      ])),
      el('button', { type: 'button', class: 'btn all', text: 'All districts', onclick: () => pick('') }),
    ]);
    close = dialog('Which district do you want to view?', [
      el('p', { class: 'muted small', style: 'margin:0', text: 'You can change it any time at the top. LightKeeper opens on the last district you used.' }), grid,
    ], { okText: 'Not now' });
    // "Not now" or a click outside: carry on with all districts and ask again next time.
    const overlay = document.querySelector('.modal-overlay:last-of-type');
    new MutationObserver((_, obs) => { if (!overlay.isConnected) { obs.disconnect(); resolve(); } }).observe(document.body, { childList: true });
  });
}

/** A drop-down drawn by the page (button + list) that drives a hidden <select>. */
function pickerFor(sel) {
  const btn = el('button', { type: 'button', class: 'dsel-btn', title: sel.title, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const menu = el('ul', { class: 'dsel-menu', role: 'listbox', hidden: true });
  const wrap = el('div', { class: 'dsel' }, [btn, menu]);
  sel.hidden = true;
  sel.after(wrap);
  const label = () => { btn.textContent = sel.selectedOptions[0]?.text || 'All districts'; };
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    menu.innerHTML = '';
    for (const o of sel.options) {
      menu.append(el('li', { role: 'option', 'aria-selected': String(o.value === sel.value) }, [el('button', {
        type: 'button', class: o.value === sel.value ? 'on' : '', text: o.text,
        onclick: () => { close(); if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change')); } },
      })]));
    }
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelector('.on')?.focus();
  };
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) close(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  sel.addEventListener('change', label);
  sel.refreshPicker = label;          // for code that sets sel.value without a change event
  label();
}

/** Lite mode: on a slow link only the picked district's aids load and the map keeps fewer tiles. */
function initNetMode() {
  const apply = () => setLiteTiles(netcheck.lite());
  document.addEventListener('net-checked', () => {
    apply();
    if (netcheck.lite() && netcheck.net.mode === 'auto') toast('Slow connection: Lite mode is on to save data. Change it in Settings > Connection.', 'warn', 7000);
  });
  document.addEventListener('net-mode', apply);
}

/* ── Search (aids + places) ── */
const AID_RESULTS = 20;
const TYPE_RANK = { light: 0, daybeacon: 1, buoy: 2 };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Exact Light List number, then names starting with the query, then lights, daybeacons, buoys; "Buoy 2" before "Buoy 10". */
function rankAids(rows, q) {
  const lq = q.toLowerCase();
  const score = (a) => [
    String(a.lightlistnumber || '').toLowerCase() === lq ? 0 : 1,
    (a.aidname || '').toLowerCase().startsWith(lq) ? 0 : 1,
    TYPE_RANK[a.aid_type] ?? 3,
  ];
  return rows.map((a) => ({ a, s: score(a) })).sort((x, y) => {
    for (let i = 0; i < x.s.length; i++) if (x.s[i] !== y.s[i]) return x.s[i] - y.s[i];
    return natural.compare(x.a.aidname || '', y.a.aidname || '');
  }).map((x) => x.a);
}
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
  let seq = 0;
  const render = (aidRows, placeRows, placesPending) => {
    items = [
      ...aidRows.map((aid) => ({ type: 'aid', aid, label: aid.aidname, kind: aid.aid_type, sub: aid.lightlistnumber ? `LL# ${aid.lightlistnumber}` : aid.waterway })),
      ...placeRows.map((place) => ({ type: 'poi', poi: place, label: place.name, kind: place.kind, sub: place.address })),
    ];
    list.innerHTML = '';
    items.forEach((it, i) => list.append(el('li', { onclick: () => pick(it), onmouseenter: () => { active = i; highlight(); } }, [
      el('span', { class: 'kind', text: fmt.title(it.kind || '') }), el('span', { text: it.label }), it.sub ? el('span', { class: 'sub', text: it.sub }) : null,
    ])));
    if (placesPending) list.append(el('li', { class: 'muted loading-dots', text: 'Searching places' }));
    else if (!items.length) list.append(el('li', { class: 'muted', text: 'No matches' }));
    list.hidden = false;
  };
  // Aids answer from the local list in milliseconds, so they show at once; places are added when they arrive.
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    const my = ++seq;
    const c = map.getCenter();
    const placesP = api.get('/api/poi/search', { q, lat: c.lat.toFixed(4), lon: c.lng.toFixed(4) }).then((r) => r.items || []).catch(() => []);
    // Pull plenty of matches (the list is local and fast), then rank: exact LL#, lights first, numbers in natural order.
    const aidRows = await api.get('/api/aids', { q, limit: 400, ...(aids.getDistrict() ? { districts: aids.getDistrict() } : {}) })
      .then((r) => rankAids(r.aids || [], q).slice(0, AID_RESULTS)).catch(() => []);
    if (my !== seq) return;
    render(aidRows, [], true);
    const placeRows = await placesP;
    if (my !== seq) return;
    render(aidRows, placeRows, false);
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
  const keys = { a: 'aids', t: 'trip', m: 'measure', s: 'settings', b: 'bnm', ...(discrep.ENABLED ? { d: 'discrep' } : {}) };
  if (keys[e.key]) showPanel(keys[e.key]);
  else if (e.key === 'l') window.dispatchEvent(new Event('lk-locate'));
  else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'Escape') { hideDetail(); clearRoute(); }
}

boot();
