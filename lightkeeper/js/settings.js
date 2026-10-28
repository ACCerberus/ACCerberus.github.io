/** Settings (web edition): vessel, Light List data status, storage, about + device diagnostics.
 *  Offline map download, pre-cache, API keys and backup files live in the desktop app. */

import { api, VERSION } from './api.js?v=2.1.0-3';
import { $, el, fmt, toast, panelSkeleton, onPanelChange, dialog, showPanel } from './ui.js?v=2.1.0-3';
import { ENABLED as DISCREP_ON } from './discrepancies.js?v=2.1.0-3';
import { setBase, getBase } from './map.js?v=2.1.0-3';

export const DOWNLOAD_INFO = '/download.json';   // the site's download switch (see /download.js)
const state = { body: null, settings: {}, districtsEl: null };

export function getSettings() { return state.settings; }

export function init(view) {
  const { body } = panelSkeleton(view, 'Settings', `LightKeeper v${document.body.dataset.version} — web edition`);
  state.body = body;
  onPanelChange((name) => { if (name === 'settings') render(); });
  render();
}

/** Screen size, pixel ratio and input type — the only device facts a browser can read. */
export function deviceLine() {
  const touch = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
  return `${screen.width}×${screen.height} @ ${window.devicePixelRatio || 1}x · viewport ${innerWidth}×${innerHeight} · ${touch} · ${navigator.onLine ? 'online' : 'offline'}`;
}

async function render() {
  try { state.settings = await api.get('/api/settings'); } catch { /* keep defaults */ }
  const s = state.settings;
  const b = state.body;
  b.innerHTML = '';

  // Discrepancy tracker: first in More on phones (the rail has its own button on bigger screens).
  const reportEmail = el('input', { type: 'email', value: s.report_email || '', placeholder: 'you@example.com', autocomplete: 'email' });
  if (DISCREP_ON) b.append(section('Discrepancy tracker', [
    el('p', { class: 'muted small', style: 'margin:0', text: 'Log aids found extinguished, off station, missing, overgrown or vandalized; export to Excel or email the list to yourself.' }),
    el('button', { class: 'btn primary', text: 'Open discrepancy tracker', onclick: () => showPanel('discrep') }),
    el('div', { class: 'field' }, [el('label', { text: 'Your email (for Email from the tracker)' }), reportEmail]),
    el('button', { class: 'btn sm', text: 'Save email', onclick: () => saveSettings({ report_email: reportEmail.value.trim() }) }),
  ]));

  const speed = num('Cruise speed (mph)', s.speed_mph ?? 25, 3, 60);
  const gph = num('Fuel burn at cruise (gal/h)', s.fuel_gph ?? 12, 0, 100);
  const tank = num('Fuel tank (gal)', s.tank_gal ?? 100, 0, 1000);
  b.append(section('Vessel', [el('div', { class: 'grid-2' }, [speed.field, gph.field, tank.field]),
    el('button', { class: 'btn sm', text: 'Save vessel', onclick: () => saveSettings({ speed_mph: speed.value(), fuel_gph: gph.value(), tank_gal: tank.value() }) })], 'desktop-only'));

  // Phones hide the top-bar base map switch; offer it here instead.
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Base map' }, [['osm', 'Map'], ['sat', 'Satellite'], ['topo', 'Topo']].map(([name, label]) => el('button', {
    class: getBase() === name ? 'on' : '', text: label, style: 'flex:1;min-height:44px',
    onclick: (e) => { setBase(name); e.currentTarget.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); },
  })));
  b.append(section('Map', [seg], 'phone-only'));

  state.districtsEl = el('div', { class: 'list' });
  b.append(section('Light List data', [
    el('p', { class: 'muted small', style: 'margin:0', text: 'Official USCG NAVCEN Light List for all nine districts, rebuilt on this site every week and stored in your browser for offline use.' }),
    state.districtsEl,
  ]));
  renderDistricts();

  b.append(section('Desktop app', [
    el('p', { class: 'muted small', style: 'margin:0', text: 'The Windows app adds trip planning (ramp chaining, lodging, PDF work plans), USACE dam releases, offline map tiles and satellite imagery for whole districts, backups and optional routing keys. Everything is cached under AppData so it works with no connection.' }),
    windowsButton(),
  ]));

  b.append(section('Storage', [
    el('p', { class: 'muted small', style: 'margin:0', text: 'Light List tables, station lists, place lookups and the map tiles you have viewed are cached in this browser.' }),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn sm', text: 'Reset UI preferences', onclick: () => { Object.keys(localStorage).filter((k) => k.startsWith('lk2.') && !k.startsWith('lk2.web.')).forEach((k) => localStorage.removeItem(k)); toast('Preferences reset — reload to apply', 'ok'); } }),
      el('button', { class: 'btn sm danger', text: 'Clear cached data', onclick: clearCaches }),
    ]),
    el('div', { class: 'muted small', id: 'storage-line', text: 'Measuring storage…' }),
  ]));
  storageLine();

  b.append(section('About', [
    el('div', { class: 'small' }, [el('b', { text: `LightKeeper v${VERSION}` }), ' — USCG ATON trip planning tool by Evan Isakson. © 2026 ArsenalRX Dev. All rights reserved.']),
    el('div', { class: 'muted small', text: 'Data: USCG NAVCEN Light List · OpenStreetMap / Overpass / Nominatim · NOAA CO-OPS · NOAA ENC · USGS NWIS · National Weather Service · Open-Meteo · Esri World Imagery · OpenTopoMap.' }),
    el('div', { class: 'muted small', text: `Device: ${deviceLine()}` }),
    el('div', { class: 'row', style: 'margin-top:6px' }, [
      el('button', { class: 'btn sm', text: 'Report a bug', onclick: reportBug }),
      el('a', { href: './about', class: 'btn sm', text: 'Data sources & notices' }),
    ]),
  ]));
}

const section = (title, children, extraClass = '') => el('div', { class: `box${extraClass ? ` ${extraClass}` : ''}` }, [el('h4', { text: title }), ...children]);
function num(label, value, min, max) {
  const input = el('input', { type: 'number', value, min, max, step: 'any' });
  return { field: el('div', { class: 'field' }, [el('label', { text: label }), input]), value: () => Number(input.value) };
}

async function saveSettings(patch) {
  try { await api.post('/api/settings', patch); Object.assign(state.settings, patch); toast('Saved', 'ok'); }
  catch (err) { toast(`Save failed: ${err.message}`, 'err'); }
}

export async function renderDistricts() {
  if (!state.districtsEl) return;
  try {
    const districts = await api.get('/api/districts');
    state.districtsEl.innerHTML = '';
    for (const d of districts) {
      state.districtsEl.append(el('div', { class: 'item', style: 'cursor:default' }, [
        el('div', { class: 'main' }, [el('div', { class: 'title', text: `D${d.id} ${d.name}` }), el('div', { class: 'sub', text: `${fmt.int(d.record_count || 0)} aids · Light List built ${fmt.ago(d.last_sync)}` })]),
      ]));
    }
  } catch { state.districtsEl.textContent = 'Could not load districts.'; }
}

async function storageLine() {
  const line = $('#storage-line');
  if (!line) return;
  try {
    const est = await navigator.storage?.estimate?.();
    line.textContent = est ? `Using ${(est.usage / 1e6).toFixed(1)} MB of browser storage` : 'Storage usage unavailable in this browser.';
  } catch { line.textContent = 'Storage usage unavailable in this browser.'; }
}

async function clearCaches() {
  try {
    if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
    await new Promise((resolve) => { const req = indexedDB.deleteDatabase('lightkeeper'); req.onsuccess = req.onerror = req.onblocked = () => resolve(); });
    toast('Cached data cleared — reloading', 'ok');
    setTimeout(() => location.reload(), 600);
  } catch (err) { toast(`Could not clear: ${err.message}`, 'err'); }
}

/** Small modal: how to report a problem (no address hard-coded). */
export function reportBug() {
  dialog('Found a bug?', [
    el('p', { text: 'Hit me up on Teams or send me an email with what happened and where, and I will get it fixed. — Evan R Isakson, BM2' }),
    el('p', { class: 'muted', text: `LightKeeper v${VERSION} web · ${deviceLine()} · include a screenshot if you can.` }),
    el('p', { class: 'muted small', text: "Donations aren't required, but they're nice and help offset server costs." }),
    el('p', { class: 'small', text: 'Venmo @ERI514 · CashApp @Eisak514' }),
  ], { okText: 'Aye aye 🫡' });
}

/** Kept for app.js compatibility; there is no tile download queue in the browser. */
export function renderTiles() {}

/** "Windows app" button: downloads the exe from this site when /download.json is enabled, otherwise says coming soon. */
function windowsButton() {
  const soon = () => dialog('Windows app coming soon', [el('p', { text: 'The desktop download is not available yet. The web edition here has the map, aids, places, tides and weather.' })], { okText: 'OK' });
  let info = null;
  const btn = el('button', { class: 'btn sm primary', text: 'Windows app — coming soon', onclick: () => {
    if (!info?.enabled) { soon(); return; }
    const a = el('a', { href: info.file, download: `LightKeeper-${info.version}.exe` });
    document.body.append(a); a.click(); a.remove();
  } });
  fetch(DOWNLOAD_INFO, { cache: 'no-store' }).then((r) => r.json()).then((d) => {
    info = d;
    if (d?.enabled) btn.textContent = `Download for Windows (v${d.version})`;
  }).catch(() => {});
  return btn;
}
