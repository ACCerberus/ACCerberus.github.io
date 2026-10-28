/** Measure tool: click points on the map, see each leg's distance and true bearing plus the total. */

import { $, el, panelSkeleton, onPanelChange, store } from './ui.js?v=2.0.8';
import { map, layers, wpIcon } from './map.js?v=2.0.8';
import { haversineNM, trueBearing, formatDistance } from './geo.js?v=2.0.8';

const state = { active: false, points: [], line: null, labels: [], unit: store.get('measureUnit', 'nm'), listEl: null, totalEl: null };

export function init(view) {
  const { body, foot } = panelSkeleton(view, 'Measure', 'Click the map to drop points; drag a point to move it, right-click a point to remove it.');
  const units = el('div', { class: 'seg' }, ['nm', 'mi', 'km'].map((u) => el('button', { text: u.toUpperCase(), class: u === state.unit ? 'on' : '', onclick: (e) => { state.unit = u; store.set('measureUnit', u); e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); render(); } })));
  state.totalEl = el('div', { class: 'stat-row', style: 'grid-template-columns:1fr 1fr' });
  state.listEl = el('div', { class: 'list' });
  body.append(el('div', { class: 'row' }, [units]), state.totalEl, state.listEl);
  foot.hidden = false;
  foot.append(
    el('button', { class: 'btn', text: 'Undo', onclick: undo }),
    el('button', { class: 'btn danger', text: 'Clear', onclick: clear }),
  );
  onPanelChange((name) => setActive(name === 'measure'));
  map.on('click', (e) => { if (state.active) addPoint(e.latlng); });
  document.addEventListener('keydown', (e) => { if (state.active && e.key === 'Escape') clear(); });
  render();
}

/** Start (or continue) a measurement from a point chosen elsewhere, e.g. the right-click menu. */
export function startFrom(latlng) { addPoint(latlng); }

function setActive(active) {
  state.active = active;
  $('#map').classList.toggle('measuring', active);
}

function addPoint(latlng) {
  state.points.push(latlng);
  redraw();
}
function undo() { state.points.pop(); redraw(); }
function clear() { state.points = []; redraw(); }

function redraw() {
  layers.measure.clearLayers();
  state.points.forEach((p, i) => L.marker(p, { icon: wpIcon(i + 1), draggable: true, title: 'Drag to move · right-click to remove' })
    .on('dragend', (e) => { state.points[i] = e.target.getLatLng(); redraw(); })
    .on('contextmenu', (e) => { L.DomEvent.stop(e); state.points.splice(i, 1); redraw(); })
    .addTo(layers.measure));
  if (state.points.length > 1) {
    L.polyline(state.points, { color: '#4f9dff', weight: 3, dashArray: '6 6' }).addTo(layers.measure);
    for (let i = 1; i < state.points.length; i++) {
      const a = state.points[i - 1]; const b = state.points[i];
      const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      const nm = haversineNM(a.lat, a.lng, b.lat, b.lng);
      L.marker(mid, { icon: L.divIcon({ className: '', html: `<div class="measure-label">${formatDistance(nm, state.unit)} · ${trueBearing(a.lat, a.lng, b.lat, b.lng).toFixed(0)}°T</div>`, iconAnchor: [40, 10] }), interactive: false }).addTo(layers.measure);
    }
  }
  render();
}

function render() {
  const legs = [];
  let total = 0;
  for (let i = 1; i < state.points.length; i++) {
    const a = state.points[i - 1]; const b = state.points[i];
    const nm = haversineNM(a.lat, a.lng, b.lat, b.lng);
    total += nm;
    legs.push({ i, nm, brg: trueBearing(a.lat, a.lng, b.lat, b.lng) });
  }
  state.totalEl.innerHTML = '';
  state.totalEl.append(
    el('div', { class: 'stat' }, [el('b', { text: formatDistance(total, state.unit) }), el('span', { text: 'Total' })]),
    el('div', { class: 'stat' }, [el('b', { text: String(state.points.length) }), el('span', { text: 'Points' })]),
  );
  state.listEl.innerHTML = '';
  if (!legs.length) { state.listEl.append(el('div', { class: 'empty' }, [el('b', { text: 'No legs yet' }), 'Click two or more points on the map.'])); return; }
  for (const leg of legs) {
    state.listEl.append(el('div', { class: 'item' }, [
      el('span', { class: 'badge', text: `${leg.i} → ${leg.i + 1}` }),
      el('div', { class: 'main' }, [el('div', { class: 'title', text: formatDistance(leg.nm, state.unit) }), el('div', { class: 'sub', text: `Course ${leg.brg.toFixed(0)}° true` })]),
    ]));
  }
}
