/** Trip planner: pick lights -> plan -> a timeline per day (drive, launch, light to light with NM/mi and ETA,
 *  recover, hotel). Ramps and hotels can be swapped with one tap; the day re-times on the spot.
 *  Desktop: the panel is a full form and every day can be opened. Phone: one simple flow - tap lights on the map,
 *  Plan, then one day at a time. Planning itself is POST /api/trip/plan (desktop: trip.py; website: js/web/tripplan.js). */

import { api } from './api.js?v=2.1.3-3';
import { el, fmt, toast, panelSkeleton, debounce, store, showProgress, hideProgress, onPanelChange, showPanel } from './ui.js?v=2.1.3-3';
import { layers, dayIcon, poiIcon, fitBounds, DAY_COLORS } from './map.js?v=2.1.3-3';
import { showPoi } from './detail.js?v=2.1.3-3';
import { getSelected, onSelectionChange, toggleSelect, openAid, clearSelection } from './aids.js?v=2.1.3-3';

const LODGING = ['hotel', 'motel', 'resort', 'campground'];
const LAUNCH_PREP_MIN = 25;
const RECOVERY_PREP_MIN = 25;
const DAY_BUFFER_MIN = 45;
const FUEL_RESERVE = 1.1;
const WATER_TORT = 1.1;          // straight line -> water route, for a swapped ramp (marked est.)
const ROAD_FACTOR = 1.3;
const DRIVE_MPH = 45;
const MI_PER_NM = 1.15078;

const state = { body: null, form: {}, plan: null, savedId: null, depart: null, settings: {}, dayIdx: 0, picking: false, bar: null, dirty: false };
const phone = () => document.body.classList.contains('phone');
const hav = (a, b) => {
  const r = Math.PI / 180;
  const la1 = (a.lat ?? a.latitude) * r; const la2 = (b.lat ?? b.latitude) * r;
  const dla = la2 - la1; const dlo = ((b.lon ?? b.longitude) - (a.lon ?? a.longitude)) * r;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const toMin = (hhmm) => { const [h, m] = String(hhmm || '06:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const legText = (mi) => (mi ? `${(mi / MI_PER_NM).toFixed(1)} NM · ${mi.toFixed(1)} mi` : '');
const runMin = (mi, mph) => Math.round((mi / mph) * 60);
const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min` : `${Math.round(min)} min`);

export function init(view) {
  const { body, foot } = panelSkeleton(view, 'Trip planner', 'Pick lights on the map, then plan. LightKeeper picks the ramps, the order, the days and the hotels.');
  state.body = body;
  state.foot = foot;
  const saved = store.get('tripForm', {});
  const f = state.form;
  f.name = el('input', { placeholder: 'e.g. FDR Lake spring run', value: saved.name || '' });
  f.start = el('input', { type: 'date', value: saved.start_date || new Date().toISOString().slice(0, 10) });
  f.time = el('input', { type: 'time', value: saved.start_time || '06:00' });
  f.days = el('input', { type: 'number', min: 1, max: 30, placeholder: 'Auto', value: saved.days || '' });
  f.speed = el('input', { type: 'number', min: 3, max: 60, value: saved.speed || 25 });
  f.stop = el('input', { type: 'number', min: 1, max: 240, value: saved.stop || 15 });
  f.hours = el('input', { type: 'number', min: 4, max: 16, step: 0.5, value: saved.max_hours || 8 });
  f.depart = el('input', { placeholder: 'Departure city (optional)', value: saved.depart?.name || '' });
  state.depart = saved.depart || null;
  f.depart.addEventListener('input', debounce(geocodeDepart, 500));
  f.lodging = el('div', { class: 'pills' }, LODGING.map((t) => el('button', { type: 'button', class: `pill${(saved.lodging || ['hotel', 'motel']).includes(t) ? ' on' : ''}`, text: fmt.title(t), dataset: { t }, onclick: (e) => e.currentTarget.classList.toggle('on') })));
  loadSettings();
  document.addEventListener('settings-changed', loadSettings);
  onSelectionChange(() => { render(); updateBar(); });
  onPanelChange((name) => { setPicking(name === 'trip' && !phone()); render(); });
  document.addEventListener('trip-pick-done', () => setPicking(false));
  render();
}

async function loadSettings() {
  try { state.settings = await api.get('/api/settings'); } catch { state.settings = {}; }
  if (!store.get('tripForm', {}).speed && state.settings.speed_mph) state.form.speed.value = state.settings.speed_mph;
}

/* ── Picking lights on the map ── */
// While picking, a plain click on an aid marker adds or removes it (aids.js checks body.dataset.tripPick).
function setPicking(on) {
  state.picking = !!on;
  if (on) document.body.dataset.tripPick = '1'; else delete document.body.dataset.tripPick;
  updateBar();
}

function updateBar() {
  if (!state.bar) {
    state.bar = el('div', { id: 'trip-pickbar', hidden: true }, [
      el('span', { class: 'tp-count' }),
      el('button', { type: 'button', class: 'btn sm', text: 'Clear', onclick: () => clearSelection() }),
      el('button', { type: 'button', class: 'btn sm primary', text: 'Done', onclick: () => { setPicking(false); showPanel('trip'); document.body.classList.remove('panel-hidden'); } }),
    ]);
    document.body.append(state.bar);
  }
  const n = getSelected().length;
  state.bar.querySelector('.tp-count').textContent = n ? `${n} light${n > 1 ? 's' : ''} picked · tap more` : 'Tap lights on the map';
  state.bar.hidden = !(state.picking && phone());
}

/* ── Panel ── */
function render() {
  const b = state.body;
  if (!b) return;
  b.innerHTML = '';
  state.foot.innerHTML = '';
  state.foot.hidden = false;
  if (phone()) renderPhone(b); else renderDesktop(b);
}

function selectedBox() {
  const aids = getSelected();
  const box = el('div', { class: 'box' }, [el('h4', { text: `Lights in this trip${aids.length ? ` (${aids.length})` : ''}` })]);
  if (!aids.length) {
    box.append(el('div', { class: 'muted small', text: phone() ? 'None yet. Tap "Pick lights", then tap lights on the map.' : 'None yet. Click lights on the map while this panel is open (click again to remove), or tick them in the Aids panel.' }));
    return box;
  }
  const list = el('div', { class: 'list trip-sel' });
  for (const a of aids.slice(0, 60)) {
    list.append(el('div', { class: 'item', onclick: () => openAid(a.objectid, { fly: true }) }, [
      el('div', { class: 'main' }, [el('div', { class: 'title', text: a.aidname }), el('div', { class: 'sub', text: a.waterway || a.characteristics || '' })]),
      el('button', { type: 'button', class: 'btn sm', html: '&times;', title: 'Remove from the trip', 'aria-label': `Remove ${a.aidname}`, onclick: (e) => { e.stopPropagation(); toggleSelect(a.objectid); } }),
    ]));
  }
  if (aids.length > 60) list.append(el('div', { class: 'muted small', text: `…and ${aids.length - 60} more` }));
  box.append(list);
  return box;
}

const field = (label, input, hint) => el('div', { class: 'field' }, [el('label', { text: label }), input, hint ? el('div', { class: 'muted small', text: hint }) : null]);

function formFields(compact) {
  const f = state.form;
  const grid = el('div', { class: 'grid-2' }, [
    field('Start date', f.start), field('Start time', f.time),
    field('Days', f.days, 'Blank = Auto'), field('Hours on water / day', f.hours),
    field('Boat speed (mph)', f.speed), field('Stop at each light (min)', f.stop),
  ]);
  const more = el('details', { class: 'trip-more' }, [
    el('summary', { text: 'More: departure city, lodging, trip name' }),
    field('Departure city', f.depart, state.depart ? `✓ ${state.depart.name}` : 'Used to pick the first ramp and the drive on day 1'),
    field('Lodging', f.lodging),
    field('Trip name', f.name),
  ]);
  return compact ? [grid, more] : [field('Trip name', f.name), grid, field('Departure city', f.depart, state.depart ? `✓ ${state.depart.name}` : 'Optional: used to pick the first ramp and the drive on day 1'), field('Lodging', f.lodging)];
}

function renderDesktop(b) {
  b.append(selectedBox());
  if (state.plan) {
    b.append(planView(state.plan));
    b.append(el('details', { class: 'trip-more' }, [el('summary', { text: 'Change trip settings' }), ...formFields(false)]));
  } else {
    b.append(...formFields(false));
  }
  b.append(savedBox());
  state.foot.append(
    el('button', { type: 'button', class: 'btn primary', style: 'flex:1', text: state.plan ? 'Plan again' : 'Plan trip', onclick: plan }),
    el('button', { type: 'button', class: 'btn', text: 'Clear', onclick: clearAll }),
  );
}

/** Phone: three simple steps, one day at a time. */
function renderPhone(b) {
  const n = getSelected().length;
  if (!state.plan) {
    b.append(el('div', { class: 'trip-steps' }, [
      el('div', { class: 'trip-step' }, [el('b', { text: '1' }), el('div', {}, [el('div', { class: 'title', text: n ? `${n} light${n > 1 ? 's' : ''} picked` : 'Pick the lights' }), el('div', { class: 'muted small', text: 'Tap lights on the map to add or remove them.' })])]),
      el('button', { type: 'button', class: 'btn big', text: n ? 'Pick more lights' : 'Pick lights on the map', onclick: startPicking }),
      el('div', { class: 'trip-step' }, [el('b', { text: '2' }), el('div', {}, [el('div', { class: 'title', text: 'Plan' }), el('div', { class: 'muted small', text: `Days: ${state.form.days.value || 'Auto'} · ${state.form.speed.value} mph · start ${state.form.time.value}` })])]),
      el('details', { class: 'trip-more' }, [el('summary', { text: 'Options' }), ...formFields(true)]),
    ]));
    if (n) b.append(selectedBox());
    b.append(savedBox());
    state.foot.append(el('button', { type: 'button', class: 'btn primary big', style: 'flex:1', text: n ? `Plan trip (${n})` : 'Plan trip', disabled: !n, onclick: plan }));
    return;
  }
  b.append(planView(state.plan));
  state.foot.append(
    el('button', { type: 'button', class: 'btn', text: 'Edit', onclick: () => { state.plan = null; layers.trip.clearLayers(); render(); } }),
    el('button', { type: 'button', class: 'btn primary', style: 'flex:1', text: state.savedId && !state.dirty ? 'Saved' : 'Save trip', onclick: save }),
  );
}

function startPicking() {
  setPicking(true);
  document.body.classList.add('panel-hidden');       // phone: drop the sheet so the map is free
  toast('Tap lights to add or remove them, then tap Done', 'info', 3500);
}

async function geocodeDepart() {
  const q = state.form.depart.value.trim();
  if (q.length < 3) { state.depart = null; return; }
  try {
    const res = await api.get('/api/geocode', { q });
    const hit = Array.isArray(res) ? res[0] : res.items?.[0];
    state.depart = hit ? { name: hit.name, lat: hit.lat, lon: hit.lon } : null;
    const hint = state.form.depart.parentElement?.querySelector('.muted');
    if (hint) hint.textContent = hit ? `✓ ${hit.name}` : 'Not found';
  } catch { /* offline: plan without it */ }
}

function readForm() {
  const f = state.form;
  const lodging = Array.from(f.lodging.querySelectorAll('.pill.on')).map((p) => p.dataset.t);
  const s = state.settings || {};
  const req = {
    name: f.name.value.trim() || 'Untitled trip',
    aid_ids: getSelected().map((a) => a.objectid),
    days: f.days.value ? Number(f.days.value) : 'auto',
    start_date: f.start.value,
    start_time: f.time.value || '06:00',
    speed_mph: Number(f.speed.value) || Number(s.speed_mph) || 25,
    work_min_default: Number(f.stop.value) || 15,
    max_hours: Number(f.hours.value) || 8,
    fuel_gph: Number(s.fuel_gph) > 0 ? Number(s.fuel_gph) : undefined,
    tank_gal: Number(s.tank_gal) > 0 ? Number(s.tank_gal) : undefined,
    depart: state.depart,
    lodging: lodging.length ? lodging : ['hotel', 'motel'],
  };
  store.set('tripForm', { name: req.name, days: f.days.value, start_date: req.start_date, start_time: req.start_time, speed: req.speed_mph, stop: req.work_min_default, max_hours: req.max_hours, depart: state.depart, lodging: req.lodging });
  return req;
}

async function plan() {
  const req = readForm();
  if (!req.aid_ids.length) { toast('Pick at least one light first', 'warn'); return; }
  setPicking(false);
  showProgress(`Planning ${req.aid_ids.length} light${req.aid_ids.length > 1 ? 's' : ''}…`);
  try {
    const res = await api.post('/api/trip/plan', req, { timeoutMs: 180000 });
    if (res.ok === false) { toast(res.error || 'Planning failed', 'err', 6000); return; }
    state.plan = res; state.savedId = null; state.dirty = false; state.dayIdx = 0;
    if (phone()) document.body.classList.remove('panel-hidden');
    render();
    drawPlan(res);
    toast(`Planned ${res.days?.length || 0} day${res.days?.length === 1 ? '' : 's'}`, 'ok');
  } catch (err) { toast(`Planning failed: ${err.message}`, 'err'); } finally { hideProgress(); }
}

function clearAll() { state.plan = null; state.savedId = null; layers.trip.clearLayers(); clearSelection(); render(); }

/* ── Results ── */
function planView(p) {
  const wrap = el('div', { class: 'trip-plan' });
  const t = p.totals || {};
  const water = t.water_mi || 0;
  wrap.append(el('div', { class: 'trip-title' }, [el('b', { text: p.name || 'Trip' }), el('span', { class: 'muted small', text: [fmt.date(p.start_date), p.auto_days ? `${t.days} days (auto)` : `${t.days} days`].filter(Boolean).join(' · ') })]));
  wrap.append(el('div', { class: 'stat-row' }, [
    stat(String(t.aids ?? 0), 'Lights'),
    stat(`${(water / MI_PER_NM).toFixed(0)} NM`, `${water.toFixed(0)} mi water`),
    stat(fmt.hrs(t.hours), 'On water'),
    t.fuel_gal != null ? stat(`${Math.round(t.fuel_gal)} gal`, 'Fuel') : stat(`${Math.round(t.drive_mi || 0)} mi`, 'Driving'),
  ]));
  if (p.warnings?.length) wrap.append(el('ul', { class: 'warn-list' }, p.warnings.map((w) => el('li', { text: w }))));
  const days = p.days || [];
  if (phone()) {
    if (days.length > 1) {
      wrap.append(el('div', { class: 'trip-daypills', role: 'tablist' }, days.map((d, i) => el('button', {
        type: 'button', role: 'tab', 'aria-selected': String(i === state.dayIdx), class: i === state.dayIdx ? 'on' : '',
        style: `--c:${DAY_COLORS[i % DAY_COLORS.length]}`, text: `Day ${d.day}`,
        onclick: () => { state.dayIdx = i; render(); focusDay(i); },
      }))));
    }
    const i = Math.min(state.dayIdx, days.length - 1);
    if (days[i]) wrap.append(dayCard(days[i], i, true));
  } else {
    days.forEach((d, i) => wrap.append(dayCard(d, i, false)));
    wrap.append(el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'btn', text: state.savedId && !state.dirty ? 'Saved' : 'Save trip', onclick: save }),
      el('button', { type: 'button', class: 'btn', text: 'Export PDF', onclick: exportPdf }),
    ]));
  }
  return wrap;
}
const stat = (v, l) => el('div', { class: 'stat' }, [el('b', { text: v }), el('span', { text: l })]);

function dayCard(d, i, open) {
  const color = DAY_COLORS[i % DAY_COLORS.length];
  const s = d.stats || {};
  const card = el('div', { class: `day${open || i === 0 ? '' : ' collapsed'}` });
  card.append(el('button', { type: 'button', class: 'day-head', onclick: () => { if (!open) card.classList.toggle('collapsed'); focusDay(i); } }, [
    el('span', { class: 'm-day', style: `background:${color}`, text: String(d.day ?? i + 1) }),
    el('b', { text: fmt.date(d.date) || `Day ${i + 1}` }),
    el('span', { class: 'sub', text: `${(d.aids || []).length} lights · ${fmt.hrs(s.total_hrs)} · done ${s.finish_time || ''}` }),
  ]));
  const body = el('div', { class: 'day-body' });
  body.append(timeline(d, i));
  const extra = [];
  if (s.fuel_gal != null) extra.push(`Fuel about ${s.fuel_gal} gal`);
  if (d.weather?.periods?.length) { const w = d.weather.periods[0]; extra.push(`Weather: ${w.shortForecast || ''}, ${w.temperature ?? ''}°${w.temperatureUnit || 'F'}, wind ${w.windSpeed || ''} ${w.windDirection || ''}`); }
  if (d.tides?.predictions?.length) extra.push(`Tides: ${d.tides.predictions.map((p) => `${p.type[0]} ${p.time?.split(' ')[1] || p.time} ${p.height_ft} ft`).join(', ')}`);
  for (const line of extra) body.append(el('div', { class: 'muted small', text: line }));
  if (d.notes?.length) body.append(el('details', { class: 'trip-why' }, [el('summary', { text: 'Why this plan' }), el('ul', { class: 'note-list' }, d.notes.map((n) => el('li', { text: n })))]));
  card.append(body);
  return card;
}

/** The day as a list of times: drive, launch, each light, recover, done, drive to the hotel. */
function timeline(d, i) {
  const p = state.plan;
  const speed = p.speed_mph || 25;
  const s = d.stats || {};
  const aids = d.aids || [];
  const start = toMin(s.start_time || p.start_time);
  const rows = el('ol', { class: 'tl' });
  const row = (time, title, sub, { kind = '', onClick = null, swap = null } = {}) => {
    const li = el('li', { class: `tl-row ${kind}` }, [
      el('span', { class: 'tl-time', text: time == null ? '' : fmt.clock(time) }),
      el('div', { class: 'tl-main' }, [
        onClick ? el('button', { type: 'button', class: 'tl-title link', text: title, onclick: onClick }) : el('div', { class: 'tl-title', text: title }),
        sub ? el('div', { class: 'tl-sub', text: sub }) : null,
        swap,
      ]),
    ]);
    rows.append(li);
  };
  const prevHotel = i > 0 ? p.days[i - 1].hotel : null;
  const drive = d.drive || {};
  if (drive.morning_mi) {
    const min = drive.morning_min ?? Math.round((drive.morning_mi / DRIVE_MPH) * 60);
    row(start - min, `Drive from ${prevHotel?.name || p.depart?.name || state.depart?.name || 'start'}`, `${drive.morning_mi.toFixed(0)} mi · ${dur(min)}${drive.morning_est ? ' (est.)' : ''}`, { kind: 'drive' });
  }
  row(start, `Launch · ${d.launch?.name || 'no ramp found'}`, d.launch ? `Prep ${LAUNCH_PREP_MIN} min${d.launch.address ? ` · ${d.launch.address}` : ''}` : 'Check the map for a ramp near the first light',
    { kind: 'ramp', onClick: d.launch ? () => showPoi(d.launch) : null, swap: swapChips(d, i, 'launch') });
  aids.forEach((a, n) => {
    const mi = n === 0 ? s.to_first_mi : s.legs_mi?.[n - 1];
    const est = n === 0 ? true : s.legs_est?.[n - 1] !== false;
    row(a.arrive_min, `${n + 1}. ${a.aidname}`, [mi ? `${legText(mi)}${est ? ' (est.)' : ''}` : '', mi ? `${dur(runMin(mi, speed))} run` : '', `stop ${a.work_min || 0} min`].filter(Boolean).join(' · '),
      { kind: 'aid', onClick: () => openAid(a.objectid, { fly: true }) });
  });
  const last = aids[aids.length - 1];
  if (last) {
    const recTime = last.arrive_min + (last.work_min || 0) + (s.from_last_mi ? runMin(s.from_last_mi, speed) : 0);
    row(recTime, `Recover · ${d.recover?.name || 'no ramp found'}`, [s.from_last_mi ? `${legText(s.from_last_mi)} (est.)` : '', `prep ${RECOVERY_PREP_MIN} min`].filter(Boolean).join(' · '),
      { kind: 'ramp', onClick: d.recover ? () => showPoi(d.recover) : null, swap: swapChips(d, i, 'recover') });
  }
  row(toMin(s.finish_time), 'Day done', `${DAY_BUFFER_MIN} min spare included · ${fmt.hrs(s.total_hrs)} on the water`, { kind: 'done' });
  if (d.hotel) {
    const min = drive.evening_min ?? (drive.evening_mi ? Math.round((drive.evening_mi / DRIVE_MPH) * 60) : null);
    row(null, `Stay · ${d.hotel.name}`, [drive.evening_mi ? `${drive.evening_mi.toFixed(0)} mi · ${dur(min)}${drive.evening_est ? ' (est.)' : ''} from the ramp` : '', d.hotel.phone].filter(Boolean).join(' · '),
      { kind: 'hotel', onClick: () => showPoi(d.hotel), swap: swapChips(d, i, 'hotel') });
  } else {
    row(null, 'Stay · no hotel found', 'Check lodging near the recovery ramp', { kind: 'hotel' });
  }
  const next = p.days[i + 1];
  if (next && d.recover && next.launch && samePoi(d.recover, next.launch)) rows.append(el('li', { class: 'tl-note', text: `Tonight's ramp is tomorrow's launch (${d.recover.name}).` }));
  return rows;
}

/* ── Swapping a ramp or hotel (re-times the day here, no new plan) ── */
const samePoi = (a, b) => !!(a && b && (a.id === b.id || (Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4)));
const ALTS = { launch: 'alt_launches', recover: 'alt_recovers', hotel: 'alt_hotels' };

function swapChips(d, i, which) {
  const alts = (d[ALTS[which]] || []).filter((x) => x && !samePoi(x, d[which])).slice(0, 4);
  if (!alts.length) return null;
  return el('div', { class: 'tl-swap' }, [
    el('span', { class: 'muted small', text: which === 'hotel' ? 'Other hotels:' : 'Other ramps:' }),
    ...alts.map((alt) => el('button', { type: 'button', class: 'chip sm', text: alt.name, title: `Use ${alt.name}`, onclick: () => swap(i, which, alt) })),
  ]);
}

function swap(i, which, alt) {
  const p = state.plan;
  const d = p.days[i];
  const old = d[which];
  d[ALTS[which]] = [old, ...(d[ALTS[which]] || []).filter((x) => !samePoi(x, alt))].filter(Boolean);
  d[which] = alt;
  if (which === 'recover' && p.days[i + 1] && samePoi(old, p.days[i + 1].launch)) { p.days[i + 1].launch = alt; retime(i + 1); }   // keep the chain
  if (which === 'launch' && p.days[i - 1] && samePoi(old, p.days[i - 1].recover)) { p.days[i - 1].recover = alt; retime(i - 1); }
  if (which === 'hotel') rehotel(i); else retime(i);
  if (which !== 'hotel') redrive(i);
  totals();
  state.dirty = true;
  render();
  drawPlan(p, false);
  toast(`${which === 'hotel' ? 'Hotel' : which === 'launch' ? 'Launch' : 'Recovery'} changed to ${alt.name}`, 'ok');
}

/** Re-time one day after a ramp change: the light-to-light legs stay, the ramp runs become estimates. */
function retime(i) {
  const p = state.plan;
  const d = p.days[i];
  const s = d.stats;
  const speed = p.speed_mph || 25;
  const aids = d.aids || [];
  if (!aids.length) return;
  const start = toMin(s.start_time || p.start_time);
  s.to_first_mi = d.launch ? +(hav(d.launch, aids[0]) * WATER_TORT).toFixed(2) : 0;
  s.from_last_mi = d.recover ? +(hav(aids[aids.length - 1], d.recover) * WATER_TORT).toFixed(2) : 0;
  let t = start + LAUNCH_PREP_MIN + (s.to_first_mi / speed) * 60;
  aids.forEach((a, n) => { if (n) t += ((s.legs_mi?.[n - 1] || 0) / speed) * 60; a.arrive_min = Math.round(t); t += a.work_min || 0; });
  t += (s.from_last_mi / speed) * 60 + RECOVERY_PREP_MIN + DAY_BUFFER_MIN;
  const water = (s.legs_mi || []).reduce((x, y) => x + y, 0) + s.to_first_mi + s.from_last_mi;
  s.water_mi = +water.toFixed(1);
  s.travel_hrs = +(water / speed).toFixed(2);
  s.total_hrs = +((t - start) / 60).toFixed(2);
  s.finish_time = fmt.clock(t);
  s.fuel_gal = p.fuel_gph ? +(p.fuel_gph * s.travel_hrs * FUEL_RESERVE).toFixed(1) : s.fuel_gal;
}

const estDrive = (a, b) => { const mi = hav(a, b) * ROAD_FACTOR; return { mi: +mi.toFixed(1), min: Math.round((mi / DRIVE_MPH) * 60) }; };
function rehotel(i) {
  const p = state.plan;
  const d = p.days[i];
  if (d.hotel && d.recover) { const e = estDrive(d.recover, d.hotel); Object.assign(d.drive ||= {}, { evening_mi: e.mi, evening_min: e.min, evening_est: true }); }
  const next = p.days[i + 1];
  if (next && d.hotel && next.launch) { const e = estDrive(d.hotel, next.launch); Object.assign(next.drive ||= {}, { morning_mi: e.mi, morning_min: e.min, morning_est: true }); }
}
function redrive(i) {
  const p = state.plan;
  const d = p.days[i];
  const prev = p.days[i - 1];
  if (prev?.hotel && d.launch) { const e = estDrive(prev.hotel, d.launch); Object.assign(d.drive ||= {}, { morning_mi: e.mi, morning_min: e.min, morning_est: true }); }
  if (d.hotel && d.recover) { const e = estDrive(d.recover, d.hotel); Object.assign(d.drive ||= {}, { evening_mi: e.mi, evening_min: e.min, evening_est: true }); }
}
function totals() {
  const p = state.plan;
  const t = p.totals || (p.totals = {});
  const days = p.days || [];
  t.water_mi = +days.reduce((x, d) => x + (d.stats?.water_mi || 0), 0).toFixed(1);
  t.hours = +days.reduce((x, d) => x + (d.stats?.total_hrs || 0), 0).toFixed(1);
  t.drive_mi = +days.reduce((x, d) => x + (d.drive?.morning_mi || 0) + (d.drive?.evening_mi || 0), 0).toFixed(1);
  const fuel = days.map((d) => d.stats?.fuel_gal).filter((x) => x != null);
  t.fuel_gal = fuel.length ? +fuel.reduce((x, y) => x + y, 0).toFixed(1) : null;
}

/* ── Map ── */
function drawPlan(p, fit = true) {
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
  if (fit) fitBounds(all);
}

function focusDay(i) {
  const d = state.plan?.days?.[i];
  if (!d) return;
  const pts = [d.launch, ...(d.aids || []).map((a) => ({ lat: a.latitude, lon: a.longitude })), d.recover].filter(Boolean).map((x) => [x.lat, x.lon]);
  fitBounds(pts);
}

/* ── Save / PDF / saved trips ── */
async function save() {
  if (!state.plan) return;
  try {
    const res = await api.post('/api/trips', { name: state.plan.name, plan: state.plan, id: state.savedId });
    state.savedId = res.id;
    state.dirty = false;
    toast('Trip saved', 'ok');
    render();
  } catch (err) { toast(`Save failed: ${err.message}`, 'err'); }
}

async function exportPdf() {
  if (!state.plan) return;
  showProgress('Building PDF…');
  try {
    if (!state.savedId || state.dirty) await save();
    const res = await api.get(`/api/trips/${state.savedId}/pdf`);
    if (res.ok === false) { printPlan(state.plan); return; }     // website: the browser's print / Save as PDF
    await api.post('/api/open', { path: res.path });
    toast('PDF exported', 'ok');
  } catch (err) { toast(`PDF failed: ${err.message}`, 'err'); } finally { hideProgress(); }
}

/** A printable page of the plan (website): the browser's Print dialog can save it as a PDF. */
function printPlan(p) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const speed = p.speed_mph || 25;
  const dayHtml = (p.days || []).map((d) => {
    const s = d.stats || {};
    const rows = (d.aids || []).map((a, n) => {
      const mi = n === 0 ? s.to_first_mi : s.legs_mi?.[n - 1];
      return `<tr><td>${n + 1}</td><td>${esc(a.lightlistnumber)}</td><td>${esc(a.aidname)}</td><td>${esc(a.characteristics)}</td><td>${mi ? `${(mi / MI_PER_NM).toFixed(1)} NM / ${mi.toFixed(1)} mi` : ''}</td><td>${mi ? runMin(mi, speed) + ' min' : ''}</td><td>${fmt.clock(a.arrive_min)}</td></tr>`;
    }).join('');
    return `<h2>Day ${d.day} · ${esc(fmt.date(d.date))}</h2>
      <p><b>Launch:</b> ${esc(d.launch?.name || 'none')} ${esc(d.launch?.address || '')} · start ${esc(s.start_time || p.start_time || '')}<br>
      <b>Recover:</b> ${esc(d.recover?.name || 'none')} ${esc(d.recover?.address || '')} · done ${esc(s.finish_time)}<br>
      <b>Hotel:</b> ${esc(d.hotel?.name || 'none')} ${esc(d.hotel?.address || '')} ${esc(d.hotel?.phone || '')}<br>
      ${(s.water_mi / MI_PER_NM).toFixed(1)} NM / ${s.water_mi} mi on the water · ${fmt.hrs(s.total_hrs)}${s.fuel_gal != null ? ` · fuel about ${s.fuel_gal} gal` : ''}</p>
      <table><tr><th>#</th><th>LL#</th><th>Light</th><th>Characteristic</th><th>Leg</th><th>Run</th><th>ETA</th></tr>${rows}</table>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)}</title><style>
    body{font:12px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:15px;margin-top:22px;border-bottom:1px solid #999}
    table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:3px 5px;text-align:left}th{background:#e8edf3}
    .w{color:#8a5a00}</style></head><body><h1>${esc(p.name)}</h1>
    <p>${esc(fmt.date(p.start_date))} · ${p.totals?.days} days · ${p.totals?.aids} lights · ${p.totals?.water_mi} mi on the water · ${speed} mph</p>
    ${(p.warnings || []).map((w) => `<div class="w">! ${esc(w)}</div>`).join('')}${dayHtml}
    <p style="margin-top:24px;color:#666">LightKeeper trip plan</p></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print the plan', 'warn'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
}

function savedBox() {
  const box = el('div', { class: 'box' }, [el('h4', { text: 'Saved trips' })]);
  api.get('/api/trips').then((res) => {
    const trips = Array.isArray(res) ? res : res.items || res.trips || [];
    if (!trips.length) { box.append(el('div', { class: 'muted small', text: 'No saved trips yet.' })); return; }
    for (const t of trips) {
      box.append(el('div', { class: 'item', onclick: () => loadTrip(t.id) }, [
        el('div', { class: 'main' }, [el('div', { class: 'title', text: t.name }), el('div', { class: 'sub', text: `${t.day_count ?? ''} days · ${t.aid_count ?? ''} lights · ${fmt.ago(t.updated_at)}` })]),
        el('button', { type: 'button', class: 'btn sm danger', html: '&times;', title: 'Delete', 'aria-label': `Delete ${t.name}`, onclick: async (e) => { e.stopPropagation(); await api.del(`/api/trips/${t.id}`); render(); } }),
      ]));
    }
  }).catch(() => {});
  return box;
}

async function loadTrip(id) {
  try {
    const t = await api.get(`/api/trips/${id}`);
    const p = t.plan || t;
    state.plan = p; state.savedId = id; state.dirty = false; state.dayIdx = 0;
    if (p.name) state.form.name.value = p.name;
    render(); drawPlan(p);
  } catch (err) { toast(`Load failed: ${err.message}`, 'err'); }
}
