/** Trip planner: selected aids → plan request → per-day results on the panel and the map. */

import { api } from './api.js';
import { $, el, fmt, toast, panelSkeleton, debounce, store, showProgress, hideProgress } from './ui.js';
import { map, layers, dayIcon, poiIcon, fitBounds, DAY_COLORS } from './map.js';
import { showPoi, showDetail, aidRecord } from './detail.js';
import { getSelected, onSelectionChange, toggleSelect, openAid } from './aids.js';

const LODGING = ['hotel', 'motel', 'resort', 'campground'];
const state = { body: null, selEl: null, form: {}, plan: null, savedId: null, depart: null, resultEl: null, savedEl: null };

export function init(view) {
  const { body, foot } = panelSkeleton(view, 'Trip planner', 'Tick aids in the Aids panel, set the trip, then plan.');
  state.body = body;
  body.append(webNotice());
  const defaults = store.get('tripForm', { days: 3, speed: 25, max_hours: 10, lodging: ['hotel', 'motel'] });
  state.selEl = el('div', { class: 'list' });
  const f = state.form;
  f.name = el('input', { placeholder: 'e.g. FDR Lake spring run', value: defaults.name || '' });
  f.start = el('input', { type: 'date', value: defaults.start_date || new Date().toISOString().slice(0, 10) });
  f.days = el('input', { type: 'number', min: 1, max: 30, value: defaults.days });
  f.speed = el('input', { type: 'number', min: 3, max: 60, value: defaults.speed });
  f.hours = el('input', { type: 'number', min: 4, max: 16, step: 0.5, value: defaults.max_hours });
  f.depart = el('input', { placeholder: 'Departure city (e.g. Spokane, WA)', value: defaults.depart?.name || '' });
  state.depart = defaults.depart || null;
  f.depart.addEventListener('input', debounce(geocodeDepart, 500));
  const lodging = el('div', { class: 'pills' }, LODGING.map((t) => el('button', { class: `pill${(defaults.lodging || []).includes(t) ? ' on' : ''}`, text: fmt.title(t), dataset: { t }, onclick: (e) => e.currentTarget.classList.toggle('on') })));
  f.lodging = lodging;

  body.append(
    el('div', { class: 'box' }, [el('h4', { html: 'Selected aids <span id="trip-sel-count"></span>' }), state.selEl]),
    el('div', { class: 'field' }, [el('label', { text: 'Trip name' }), f.name]),
    el('div', { class: 'grid-2' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Start date' }), f.start]),
      el('div', { class: 'field' }, [el('label', { text: 'Days' }), f.days]),
      el('div', { class: 'field' }, [el('label', { text: 'Boat speed (mph)' }), f.speed]),
      el('div', { class: 'field' }, [el('label', { text: 'Max hours / day' }), f.hours]),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Departure city' }), f.depart, el('div', { class: 'muted small', id: 'trip-depart-hint', text: state.depart ? `✓ ${state.depart.name}` : 'Optional — used to order days and pick the first ramp' })]),
    el('div', { class: 'field' }, [el('label', { text: 'Lodging' }), lodging]),
  );
  state.resultEl = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  state.savedEl = el('div', { class: 'box' }, [el('h4', { text: 'Saved trips' })]);
  body.append(state.resultEl, state.savedEl);
  foot.hidden = false;
  foot.append(
    el('button', { class: 'btn primary', style: 'flex:1', text: 'Plan trip', onclick: plan }),
    el('button', { class: 'btn', text: 'Clear', onclick: clearPlan }),
  );
  onSelectionChange(renderSelected);
  renderSelected(getSelected());
  loadSaved();
}

/** Web edition: the planning engine (routing, ramp chaining, lodging, PDF) runs in the Windows app. */
function webNotice() {
  return el('div', { class: 'box notice' }, [
    el('h4', { text: 'Desktop feature' }),
    el('div', { class: 'small', text: 'Trip planning runs in the desktop app — download it from the LightKeeper page. You can still tick aids here and save the selection; the Windows app plans the days, ramps and lodging and exports the PDF.' }),
    el('a', { class: 'btn sm primary', style: 'margin-top:8px', href: 'https://github.com/ArsenalRX/lightkeeper-releases/releases/latest', target: '_blank', rel: 'noopener', text: 'Download for Windows (works offline)' }),
  ]);
}

function renderSelected(aids) {
  $('#trip-sel-count').textContent = aids.length ? `(${aids.length})` : '';
  state.selEl.innerHTML = '';
  if (!aids.length) { state.selEl.append(el('div', { class: 'muted small', text: 'None yet — tick aids in the Aids panel or click an aid and choose "Add to trip".' })); return; }
  for (const a of aids.slice(0, 60)) {
    state.selEl.append(el('div', { class: 'item', onclick: () => openAid(a.objectid, { fly: true }) }, [
      el('div', { class: 'main' }, [el('div', { class: 'title', text: a.aidname }), el('div', { class: 'sub', text: a.waterway || a.characteristics || '' })]),
      el('button', { class: 'btn sm', html: '&times;', title: 'Remove', onclick: (e) => { e.stopPropagation(); toggleSelect(a.objectid); } }),
    ]));
  }
  if (aids.length > 60) state.selEl.append(el('div', { class: 'muted small', text: `…and ${aids.length - 60} more` }));
}

async function geocodeDepart() {
  const q = state.form.depart.value.trim();
  const hint = $('#trip-depart-hint');
  if (q.length < 3) { state.depart = null; hint.textContent = 'Optional'; return; }
  try {
    const res = await api.get('/api/geocode', { q });
    const hit = Array.isArray(res) ? res[0] : res.items?.[0];
    if (hit) { state.depart = { name: hit.name, lat: hit.lat, lon: hit.lon }; hint.textContent = `✓ ${hit.name}`; }
    else { state.depart = null; hint.textContent = 'Not found'; }
  } catch { hint.textContent = 'Geocoding unavailable (offline)'; }
}

function readForm() {
  const f = state.form;
  const lodging = Array.from(f.lodging.querySelectorAll('.pill.on')).map((p) => p.dataset.t);
  const req = {
    name: f.name.value.trim() || 'Untitled trip',
    aid_ids: getSelected().map((a) => a.objectid),
    days: Number(f.days.value) || 1,
    start_date: f.start.value,
    speed_mph: Number(f.speed.value) || 25,
    max_hours: Number(f.hours.value) || 10,
    depart: state.depart,
    lodging: lodging.length ? lodging : ['hotel', 'motel'],
  };
  store.set('tripForm', { name: req.name, days: req.days, speed: req.speed_mph, max_hours: req.max_hours, start_date: req.start_date, depart: state.depart, lodging: req.lodging });
  return req;
}

async function plan() {
  const req = readForm();
  if (!req.aid_ids.length) { toast('Select at least one aid first', 'warn'); return; }
  showProgress(`Planning ${req.days}-day trip for ${req.aid_ids.length} aids…`);
  try {
    const res = await api.post('/api/trip/plan', req, { timeoutMs: 180000 });
    if (res.ok === false) { toast(res.error || 'Planning failed', res.desktop_only ? 'info' : 'err', 6000); return; }
    state.plan = res; state.savedId = null;
    renderPlan(res);
    drawPlan(res);
    toast('Trip planned', 'ok');
  } catch (err) { toast(`Planning failed: ${err.message}`, 'err'); } finally { hideProgress(); }
}

function clearPlan() { state.plan = null; state.savedId = null; state.resultEl.innerHTML = ''; layers.trip.clearLayers(); }

function renderPlan(p) {
  const r = state.resultEl;
  r.innerHTML = '';
  const t = p.totals || {};
  r.append(el('div', { class: 'stat-row' }, [
    stat(fmt.int(t.aids), 'Aids'), stat(String(t.days ?? p.days?.length ?? 0), 'Days'), stat(fmt.mi(t.water_mi, 0), 'On water'), stat(fmt.hrs(t.hours), 'Hours'),
  ]));
  if (p.warnings?.length) r.append(el('ul', { class: 'warn-list' }, p.warnings.map((w) => el('li', { text: w }))));
  (p.days || []).forEach((d, i) => r.append(dayCard(d, i)));
  r.append(el('div', { class: 'row' }, [
    el('button', { class: 'btn', text: state.savedId ? 'Saved' : 'Save trip', onclick: save }),
    el('button', { class: 'btn', text: 'Export PDF', onclick: exportPdf }),
  ]));
}
const stat = (v, l) => el('div', { class: 'stat' }, [el('b', { text: v }), el('span', { text: l })]);

function dayCard(d, i) {
  const color = DAY_COLORS[i % DAY_COLORS.length];
  const s = d.stats || {};
  const card = el('div', { class: `day${i > 0 ? ' collapsed' : ''}` });
  card.append(el('div', { class: 'day-head', onclick: () => card.classList.toggle('collapsed') }, [
    el('span', { class: 'm-day', style: `background:${color}`, text: String(d.day ?? i + 1) }),
    el('b', { text: fmt.date(d.date) || `Day ${i + 1}` }),
    el('span', { class: 'sub', text: `${(d.aids || []).length} aids · ${fmt.mi(s.water_mi, 0)} · ${fmt.hrs(s.total_hrs)}` }),
  ]));
  const body = el('div', { class: 'day-body' });
  body.append(place(d.launch, 'Launch', i), place(d.recover, 'Recover', i), place(d.hotel, 'Lodging', i));
  const table = el('table', { class: 'aid-table' }, (d.aids || []).map((a, n) => el('tr', { onclick: () => openAid(a.objectid, { fly: true }), style: 'cursor:pointer' }, [
    el('td', { text: String(n + 1) }), el('td', {}, [el('div', { text: a.aidname }), el('div', { class: 'muted', text: [a.lightlistnumber ? `LL# ${a.lightlistnumber}` : '', a.characteristics].filter(Boolean).join(' · ') })]),
    el('td', { class: 'eta', text: `${fmt.clock(a.arrive_min)}\n${a.work_min ? a.work_min + ' min' : ''}` }),
  ])));
  body.append(table);
  if (d.drive) body.append(el('div', { class: 'muted small', text: `Drive: ${fmt.mi(d.drive.morning_mi, 0)} to launch · ${fmt.mi(d.drive.evening_mi, 0)} to lodging` }));
  if (d.weather?.periods?.length) {
    const w = d.weather.periods[0];
    body.append(el('div', { class: 'muted small', text: `Weather: ${w.name} — ${w.shortForecast || ''}, ${w.temperature ?? ''}°${w.temperatureUnit || 'F'}, wind ${w.windSpeed || ''} ${w.windDirection || ''}` }));
  }
  if (d.tides?.predictions?.length) body.append(el('div', { class: 'muted small', text: `Tides (${d.tides.station?.name || ''}): ${d.tides.predictions.map((p) => `${p.type[0]} ${p.time?.split(' ')[1] || p.time} ${p.height_ft}ft`).join(', ')}` }));
  if (d.notes?.length) body.append(el('ul', { class: 'note-list' }, d.notes.map((n) => el('li', { text: n }))));
  card.append(body);
  return card;
}

function place(poi, role, dayIdx) {
  if (!poi) return el('div', { class: 'place', style: 'cursor:default' }, [el('span', { class: 'm-poi', text: '?' }), el('div', { class: 'pl-main' }, [el('div', { class: 'pl-role', text: role }), el('div', { class: 'muted small', text: 'None found nearby' })])]);
  return el('div', { class: 'place', onclick: () => showPoi(poi) }, [
    el('span', { class: `m-poi ${poi.kind}`, text: poi.kind === 'ramp' || poi.kind === 'marina' ? '⚓' : poi.kind === 'park' ? '🌲' : '🛏' }),
    el('div', { class: 'pl-main' }, [
      el('div', { class: 'pl-role', text: role }),
      el('div', { class: 'pl-title', text: poi.name }),
      el('div', { class: 'pl-sub', text: [poi.address, poi.phone].filter(Boolean).join(' · ') || 'Address unknown' }),
    ]),
  ]);
}

function drawPlan(p) {
  layers.trip.clearLayers();
  const all = [];
  (p.days || []).forEach((d, i) => {
    const color = DAY_COLORS[i % DAY_COLORS.length];
    const pts = [];
    if (d.launch) pts.push([d.launch.lat, d.launch.lon]);
    for (const a of d.aids || []) pts.push([a.latitude, a.longitude]);
    if (d.recover) pts.push([d.recover.lat, d.recover.lon]);
    if (pts.length > 1) L.polyline(pts, { color, weight: 3, opacity: 0.85 }).addTo(layers.trip);
    (d.aids || []).forEach((a, n) => L.marker([a.latitude, a.longitude], { icon: dayIcon(i, n + 1), title: a.aidname }).on('click', () => openAid(a.objectid)).addTo(layers.trip));
    for (const [poi, glyph] of [[d.launch, 'ramp'], [d.recover, 'ramp'], [d.hotel, 'hotel']]) {
      if (poi) L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.kind || glyph), title: poi.name }).bindTooltip(`Day ${i + 1}: ${poi.name}`, { direction: 'top', offset: [0, -12] }).on('click', () => showPoi(poi)).addTo(layers.trip);
    }
    all.push(...pts);
  });
  fitBounds(all);
}

async function save() {
  if (!state.plan) return;
  try {
    const res = await api.post('/api/trips', { name: state.plan.name, plan: state.plan, id: state.savedId });
    state.savedId = res.id;
    toast('Trip saved', 'ok');
    renderPlan(state.plan);
    loadSaved();
  } catch (err) { toast(`Save failed: ${err.message}`, 'err'); }
}

async function exportPdf() {
  if (!state.plan) return;
  showProgress('Building PDF…');
  try {
    if (!state.savedId) await save();
    const res = await api.get(`/api/trips/${state.savedId}/pdf`);
    if (res.ok === false) { toast(res.error, res.desktop_only ? 'info' : 'err', 6000); return; }
    await api.post('/api/open', { path: res.path });
    toast('PDF exported', 'ok');
  } catch (err) { toast(`PDF failed: ${err.message}`, 'err'); } finally { hideProgress(); }
}

async function loadSaved() {
  try {
    const res = await api.get('/api/trips');
    const trips = Array.isArray(res) ? res : res.items || res.trips || [];
    state.savedEl.innerHTML = '';
    state.savedEl.append(el('h4', { text: 'Saved trips' }));
    if (!trips.length) { state.savedEl.append(el('div', { class: 'muted small', text: 'No saved trips yet.' })); return; }
    for (const t of trips) {
      state.savedEl.append(el('div', { class: 'item', onclick: () => loadTrip(t.id) }, [
        el('div', { class: 'main' }, [el('div', { class: 'title', text: t.name }), el('div', { class: 'sub', text: `${t.day_count ?? ''} days · ${t.aid_count ?? ''} aids · ${fmt.ago(t.updated_at)}` })]),
        el('button', { class: 'btn sm danger', html: '&times;', title: 'Delete', onclick: async (e) => { e.stopPropagation(); await api.del(`/api/trips/${t.id}`); loadSaved(); } }),
      ]));
    }
  } catch { /* backend not ready */ }
}

async function loadTrip(id) {
  try {
    const t = await api.get(`/api/trips/${id}`);
    const plan = t.plan || t;
    state.plan = plan; state.savedId = id;
    if (plan.name) state.form.name.value = plan.name;
    renderPlan(plan); drawPlan(plan);
  } catch (err) { toast(`Load failed: ${err.message}`, 'err'); }
}

