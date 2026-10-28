/** BNM tab: the current Broadcast Notices to Mariners for the district you're in (all nine districts). Tapping one
 *  flies to the light, opens its card and shows what's wrong at the top of the card. Any aid with an active notice
 *  shows the same banner when it's opened from the map or search, and gets a pulsing ring on the map. */

import { api } from './api.js?v=2.1.2-3';
import { el, panelSkeleton, onPanelChange, toast } from './ui.js?v=2.1.2-3';
import { map } from './map.js?v=2.1.2-3';
import { openAid, allAids, getDistrict } from './aids.js?v=2.1.2-3';
import { setAidNotices } from './detail.js?v=2.1.2-3';

const DISTRICTS = { 1: 'Northeast', 5: 'East', 7: 'Southeast', 8: 'Heartland', 9: 'Great Lakes', 11: 'Southwest', 13: 'Northwest', 14: 'Oceania', 17: 'Arctic' };
const REFRESH_MS = 15 * 60 * 1000;
let warnLayer = null;       // a warning ring over every aid with an active notice
const state = { body: null, byDistrict: new Map(), loading: new Map(), refreshing: false };
// byDistrict: id -> { items, msg, loadedAt }

const normLlnr = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? String(n) : String(v || '').trim(); };
const current = () => getDistrict() || null;
// Only notices about aids to navigation (not whale zones, launches or hazard operations).
const active = (d = current()) => (state.byDistrict.get(d)?.items || []).filter((b) => b.active && (b.aton || b.llnrs.length));

/** Active notices that name this aid (by Light List number, or by exact name when the notice gives no number). */
export function noticesFor(aid) {
  if (!aid?.district_id) return [];
  const ll = aid.lightlistnumber == null ? '' : normLlnr(aid.lightlistnumber);
  const name = (aid.aidname || '').toLowerCase();
  return active(aid.district_id).filter((b) => (b.llnrs.length ? b.llnrs.some((n) => normLlnr(n) === ll) : (b.aid_hint || '').toLowerCase() === name));
}

/** Light List aids a notice names, within the notice's district. */
function aidsFor(b, d) {
  const inD = allAids().filter((a) => a.district_id === d);
  if (b.llnrs.length) {
    const wanted = new Set(b.llnrs.map(normLlnr));
    return inD.filter((a) => wanted.has(normLlnr(a.lightlistnumber)));
  }
  const hint = (b.aid_hint || '').toLowerCase();
  return hint ? inD.filter((a) => (a.aidname || '').toLowerCase() === hint) : [];
}

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
  onPanelChange((name) => { if (name === 'bnm') load(current()); });
  document.addEventListener('district-changed', () => { render(); drawWarnings(); badges(); load(current()); });
  document.addEventListener('aids-loaded', () => { render(); drawWarnings(); });
  load(current());
  setInterval(() => load(current(), true), REFRESH_MS);
}

async function load(d, fetchNew = false, refresh = false) {
  if (!d || !DISTRICTS[d]) { render(); drawWarnings(); badges(); return null; }
  const have = state.byDistrict.get(d);
  if (have && !fetchNew && !refresh && Date.now() - have.loadedAt < REFRESH_MS) { render(); drawWarnings(); badges(); return null; }
  if (state.loading.has(d)) return state.loading.get(d);
  state.refreshing = refresh;
  render(!have);
  const job = (async () => {
    const entry = have ? { ...have } : { items: [], msg: '', loadedAt: 0 };
    try {
      const res = await api.get('/api/bnm', { district: d, ...(refresh ? { refresh: 1 } : {}) }, { timeoutMs: 45000 });
      if (res.ok === false) entry.msg = res.error || 'Notices are unavailable right now';
      else { entry.items = res.items || []; entry.msg = res.fetched_at ? `Updated ${new Date(res.fetched_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''; }
      entry.loadedAt = Date.now();
      if (refresh) toast(`Notices checked: ${entry.items.filter((b) => b.active && (b.aton || b.llnrs.length)).length} active`, 'ok');
    } catch (err) {
      entry.msg = `Could not load notices: ${err.message}`;
      if (refresh) toast(entry.msg, 'warn');
    } finally {
      state.loading.delete(d);
      state.refreshing = false;
    }
    state.byDistrict.set(d, entry);
    render();
    drawWarnings();
    badges();
  })();
  state.loading.set(d, job);
  return job;
}

function badges() {
  const n = active().length;
  for (const badge of document.querySelectorAll('#bnm-count, #bnm-count-tab')) { badge.hidden = !n; badge.textContent = n; }
}

function render(loading = false) {
  const body = state.body;
  if (!body) return;
  body.innerHTML = '';
  const d = current();
  if (!d) {
    body.append(el('div', { class: 'empty' }, [el('b', { text: 'Pick a district' }), 'Scroll in on the map or pick a district at the top to see its notices.']));
    return;
  }
  if (!DISTRICTS[d]) {
    body.append(el('div', { class: 'empty' }, [el('b', { text: 'No notices for this district' }), 'No broadcast notice feed is known for it.']));
    return;
  }
  const entry = state.byDistrict.get(d);
  const list = active(d);
  body.append(el('div', { class: 'row bnm-head' }, [
    el('span', { class: 'muted small', text: [`${DISTRICTS[d]} (D${d})`, entry ? `${list.length} active` : '', entry?.msg].filter(Boolean).join(' · ') }),
    state.refreshing
      ? el('button', { class: 'btn sm', disabled: true }, [el('span', { class: 'btn-spin' }), 'Refreshing'])
      : el('button', { class: 'btn sm', text: 'Refresh', onclick: () => load(d, true, true) }),
  ]));
  if (loading || !entry) { body.append(el('div', { class: 'empty loading-dots', text: 'Loading notices' })); return; }
  if (!list.length) {
    body.append(el('div', { class: 'empty' }, [el('b', { text: 'No active aid notices' }), 'Every aid in the district is reported watching properly.']));
    return;
  }
  const box = el('div', { class: 'list bnm-list' });
  for (const b of list) {
    const aids = aidsFor(b, d);
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

/** Warning markers on the map: an orange ring with "!" over each light in the picked district with an active notice. */
function drawWarnings() {
  if (!map) return;
  if (!warnLayer) warnLayer = L.layerGroup().addTo(map);
  warnLayer.clearLayers();
  const d = current();
  if (!d) return;
  const seen = new Set();
  for (const b of active(d)) {
    for (const aid of aidsFor(b, d)) {
      if (seen.has(aid.objectid)) continue;
      seen.add(aid.objectid);
      const icon = L.divIcon({ className: 'bnm-marker', html: '<span>!</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
      L.marker([aid.latitude, aid.longitude], { icon, zIndexOffset: 1000, keyboard: false, title: `${aid.aidname}: ${whatsWrong(b)}` })
        .on('click', () => openAid(aid.objectid))
        .addTo(warnLayer);
    }
  }
}
