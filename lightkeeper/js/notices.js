/** BNM tab: the current Broadcast Notices to Mariners for the picked district. Tapping one flies to the light,
 *  opens its card and shows what's wrong at the top of the card. Any aid with an active notice shows the same
 *  banner when it's opened from the map or search. Northwest (D13) only for now; other districts are on the To do. */

import { api } from './api.js?v=2.1.1';
import { el, panelSkeleton, onPanelChange, toast } from './ui.js?v=2.1.1';
import { map } from './map.js?v=2.1.1';
import { openAid, allAids, getDistrict } from './aids.js?v=2.1.1';
import { setAidNotices } from './detail.js?v=2.1.1';

const DISTRICTS = { 13: 'Northwest' };         // districts with BNM feeds so far
const REFRESH_MS = 15 * 60 * 1000;
let warnLayer = null;       // a warning ring over every aid with an active notice
const state = { body: null, items: [], district: 13, msg: '', loadedAt: 0, loading: null, refreshing: false, checkedAt: 0 };

const normLlnr = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? String(n) : String(v || '').trim(); };
const active = () => state.items.filter((b) => b.active);

/** Active notices that name this aid by Light List number (within the notice's district). */
export function noticesFor(aid) {
  if (!aid || aid.district_id !== state.district) return [];
  const ll = aid.lightlistnumber == null ? '' : normLlnr(aid.lightlistnumber);
  const name = (aid.aidname || '').toLowerCase();
  return active().filter((b) => (b.llnrs.length ? b.llnrs.some((n) => normLlnr(n) === ll) : (b.aid_hint || '').toLowerCase() === name));
}

/** Light List aids a notice names: by LLNR, or by exact name when the notice gives no number. */
function aidsFor(b) {
  const inD = allAids().filter((a) => a.district_id === state.district);
  if (b.llnrs.length) {
    const wanted = new Set(b.llnrs.map(normLlnr));
    return inD.filter((a) => wanted.has(normLlnr(a.lightlistnumber)));
  }
  const hint = (b.aid_hint || '').toLowerCase();
  return hint ? inD.filter((a) => (a.aidname || '').toLowerCase() === hint) : [];
}
const aidFor = (b) => aidsFor(b)[0] || null;

/** "Extinguished" etc., or the first sentence about the aid when the type isn't recognized. */
export function whatsWrong(b) {
  if (b.discrepancy) return b.discrepancy;
  const s = (b.text || '').split(/\n|\. /).find((t) => /LLNR/i.test(t)) || '';
  return s.replace(/^.*?\(LLNR[^)]*\)\s*/i, '').replace(/\.$/, '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) || 'See notice';
}

export function init(view) {
  const { body } = panelSkeleton(view, 'Broadcast Notices', 'Current USCG notices for aids in your district. Tap one to go to the light.');
  state.body = body;
  setAidNotices(noticesFor, noticeBanner);
  onPanelChange((name) => { if (name === 'bnm') load(Date.now() - state.loadedAt > REFRESH_MS); });
  document.addEventListener('district-changed', () => { render(); drawWarnings(); });
  document.addEventListener('aids-loaded', () => { if (state.loadedAt) { render(); drawWarnings(); } });
  load(true);
  setInterval(() => load(true), REFRESH_MS);
}

async function load(fetchNew = false, refresh = false) {
  if (!fetchNew && state.loadedAt) { render(); return; }
  if (state.loading) return state.loading;
  state.refreshing = refresh;
  if (!state.items.length) render(true);
  else if (refresh) render();             // show the spinning Refresh button
  state.loading = (async () => {
    try {
      const res = await api.get('/api/bnm', { district: state.district, ...(refresh ? { refresh: 1 } : {}) }, { timeoutMs: 30000 });
      if (res.ok === false) state.msg = res.error || 'Notices are unavailable right now';
      else { state.items = res.items || []; state.msg = res.fetched_at ? `Updated ${new Date(res.fetched_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''; }
      state.loadedAt = Date.now();
      if (refresh) toast(`Notices checked: ${active().length} active`, 'ok');
    } catch (err) {
      state.msg = `Could not load notices: ${err.message}`;
      if (refresh) toast(state.msg, 'warn');
    } finally {
      state.loading = null;
      state.refreshing = false;
    }
    render();
    drawWarnings();
    const n = active().length;
    for (const badge of document.querySelectorAll('#bnm-count, #bnm-count-tab')) { badge.hidden = !n; badge.textContent = n; }
  })();
  return state.loading;
}

function render(loading = false) {
  const body = state.body;
  if (!body) return;
  body.innerHTML = '';
  const picked = getDistrict();
  if (picked && !DISTRICTS[picked]) {
    body.append(el('div', { class: 'empty' }, [el('b', { text: 'Not available for this district yet' }),
      'Broadcast Notices are live for the Northwest (D13) so far. The other districts are coming.']));
    return;
  }
  body.append(el('div', { class: 'row bnm-head' }, [
    el('span', { class: 'muted small', text: [`${DISTRICTS[state.district]} (D${state.district})`, `${active().length} active`, state.msg].filter(Boolean).join(' · ') }),
    state.refreshing
      ? el('button', { class: 'btn sm', disabled: true }, [el('span', { class: 'btn-spin' }), 'Refreshing'])
      : el('button', { class: 'btn sm', text: 'Refresh', onclick: () => load(true, true) }),
  ]));
  if (loading) { body.append(el('div', { class: 'empty loading-dots', text: 'Loading notices' })); return; }
  const list = active();
  if (!list.length) {
    body.append(el('div', { class: 'empty' }, [el('b', { text: 'No active aid notices' }), 'Every aid in the district is reported watching properly.']));
    return;
  }
  const box = el('div', { class: 'list bnm-list' });
  for (const b of list) {
    const aids = aidsFor(b);
    const aid = aids[0] || null;
    const name = (aid?.aidname || b.aid_hint || b.area || b.id) + (b.llnrs.length > 1 ? ` + ${b.llnrs.length - 1} more` : '');
    box.append(el('button', { type: 'button', class: 'item bnm-item', title: aid ? 'Go to this light' : 'This notice names no aid in the Light List', onclick: () => go(b, aid) }, [
      el('div', { class: 'main' }, [
        el('div', { class: 'title' }, [el('span', { class: 'badge warn', text: whatsWrong(b) }), ` ${name}`]),
        el('div', { class: 'sub', text: [aid?.lightlistnumber != null ? `LLNR ${normLlnr(aid.lightlistnumber)}` : (b.llnrs[0] ? `LLNR ${b.llnrs[0]}` : ''), b.area, b.dtg].filter(Boolean).join(' · ') }),
        el('div', { class: 'sub muted', text: b.id }),
      ]),
    ]));
  }
  body.append(box);
}

function go(b, aid) {
  if (!aid) {
    toast(`${b.id}: no matching aid in the Light List (${b.aid_hint || b.area || 'no LLNR given'})`, 'warn');
    return;
  }
  openAid(aid.objectid);
  // Fly so the light lands in the part of the map the card doesn't cover (bottom sheet on a phone, side card on desktop).
  requestAnimationFrame(() => {
    const zoom = Math.max(map.getZoom(), 15);
    const mapBox = map.getContainer().getBoundingClientRect();
    const card = document.getElementById('detail');
    const r = card && !card.hidden ? card.getBoundingClientRect() : null;
    let dx = 0;
    let dy = 0;
    if (r && r.width && r.height) {
      if (r.width > mapBox.width * 0.8) dy = Math.max(0, mapBox.bottom - r.top) / 2;      // sheet along the bottom
      else if (r.left > mapBox.left + mapBox.width / 2) dx = Math.max(0, mapBox.right - r.left) / 2;   // card on the right
    }
    const center = map.unproject(map.project([aid.latitude, aid.longitude], zoom).add([dx, dy]), zoom);
    map.flyTo(center, zoom, { duration: 0.7 });
  });
}

/** Banner(s) for the top of an aid card. */
export function noticeBanner(list) {
  return el('div', { class: 'bnm-banner' }, list.map((b) => el('div', { class: 'bnm-note' }, [
    el('div', { class: 'bnm-what' }, [el('b', { text: whatsWrong(b) }), el('span', { class: 'muted small', text: ` · ${b.id}${b.dtg ? ` · ${b.dtg}` : ''}` })]),
    el('div', { class: 'bnm-text small', text: b.text }),
  ])));
}

/** Warning markers on the map: an orange ring with "!" over each light that has an active notice. */
function drawWarnings() {
  if (!map) return;
  if (!warnLayer) warnLayer = L.layerGroup().addTo(map);
  warnLayer.clearLayers();
  const picked = getDistrict();
  if (picked && picked !== state.district) return;
  const seen = new Set();
  for (const b of active()) {
    for (const aid of aidsFor(b)) {
    if (seen.has(aid.objectid)) continue;
    seen.add(aid.objectid);
    const icon = L.divIcon({ className: 'bnm-marker', html: '<span>!</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
    L.marker([aid.latitude, aid.longitude], { icon, zIndexOffset: 1000, keyboard: false, title: `${aid.aidname}: ${whatsWrong(b)}` })
      .on('click', () => openAid(aid.objectid))
      .addTo(warnLayer);
    }
  }
}
