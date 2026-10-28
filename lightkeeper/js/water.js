/** Water: NOAA tide/current stations, USGS gages and USACE dams in view; readings on click. */

import { api } from './api.js?v=2.0.8';
import { el, fmt, toast, panelSkeleton, onPanelChange, debounce, store, showProgress, hideProgress } from './ui.js?v=2.0.8';
import { map, layers, poiIcon, viewportBbox } from './map.js?v=2.0.8';
import { showDetail, poiRecord } from './detail.js?v=2.0.8';
import { haversineMi } from './geo.js?v=2.0.8';
import { timeChart, interpolateExtremes, parseTime } from './chart.js?v=2.0.8';

const TYPES = [['tide', 'Tides'], ['current', 'Currents'], ['gage', 'USGS gages'], ['dam', 'Dams']];
const MIN_ZOOM = 7;
const state = { types: new Set(store.get('waterTypes', ['tide', 'gage', 'dam'])), items: new Map(), listEl: null, active: false, hover: store.get('waterHover', false) };

/** Nearest loaded station of each kind to a point — used by the hover card (no network). */
export function nearestStations(lat, lon, maxMi = 60) {
  const best = {};
  for (const poi of state.items.values()) {
    const d = haversineMi(lat, lon, poi.lat, poi.lon);
    if (d > maxMi) continue;
    if (!best[poi.kind] || d < best[poi.kind].distance_mi) best[poi.kind] = { ...poi, distance_mi: d };
  }
  return Object.values(best).sort((a, b) => a.distance_mi - b.distance_mi);
}
export const openStation = (poi) => open(poi);
export const hoverEnabled = () => state.hover;
export function stationsLoaded() { return state.items.size > 0; }
export const ensureStations = () => refresh();

export function init(view) {
  const { body, foot } = panelSkeleton(view, 'Water', 'Tide predictions, river gages (level, flow, temperature) and dam releases.');
  const pills = el('div', { class: 'pills' }, TYPES.map(([t, label]) => el('button', {
    class: `pill${state.types.has(t) ? ' on' : ''}`, html: `<span class="dot m-poi ${t}" style="width:9px;height:9px;border:0;box-shadow:none"></span>${label}`,
    onclick: (e) => { e.currentTarget.classList.toggle('on'); e.currentTarget.classList.contains('on') ? state.types.add(t) : state.types.delete(t); store.set('waterTypes', Array.from(state.types)); refresh(); },
  })));
  state.listEl = el('div', { class: 'list' });
  const hoverSwitch = el('label', { class: 'switch' }, [
    el('span', { text: 'Show nearest stations in the hover hint' }),
    el('input', { type: 'checkbox', checked: state.hover, onchange: (e) => { state.hover = e.target.checked; store.set('waterHover', state.hover); } }),
  ]);
  body.append(pills, hoverSwitch, state.listEl);
  foot.hidden = false;
  foot.append(
    el('button', { class: 'btn', text: 'Water temp here', onclick: () => waterTemp() }),
  );
  onPanelChange((name) => { state.active = name === 'water'; if (state.active) refresh(); });
  map.on('moveend', debounce(() => { if (state.active || state.hover) refresh(); }, 600));
  if (state.hover) refresh();
}

async function refresh() {
  if (map.getZoom() < MIN_ZOOM) { if (state.active) renderList([], 'Zoom in to load stations'); return; }
  try {
    const data = await api.get('/api/water/stations', { bbox: viewportBbox(), types: Array.from(state.types).join(',') });
    layers.water.clearLayers();
    state.items.clear();
    for (const poi of data.items || []) {
      const m = L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.kind), title: poi.name }).addTo(layers.water);
      m.bindTooltip(poi.name, { direction: 'top', offset: [0, -12] });
      m.on('click', () => open(poi));
      state.items.set(poi.id, poi);
    }
    if (state.active) renderList(Array.from(state.items.values()));
  } catch (err) { if (state.active) toast(`Water stations: ${err.message}`, 'warn'); }
}

function renderList(items, emptyText = 'No stations in view') {
  const c = map.getCenter();
  items.sort((a, b) => haversineMi(c.lat, c.lng, a.lat, a.lon) - haversineMi(c.lat, c.lng, b.lat, b.lon));
  state.listEl.innerHTML = '';
  if (!items.length) { state.listEl.append(el('div', { class: 'empty' }, [el('b', { text: emptyText })])); return; }
  for (const poi of items.slice(0, 80)) {
    state.listEl.append(el('div', { class: 'item', onclick: () => open(poi) }, [
      el('span', { class: `m-poi ${poi.kind}`, style: 'width:22px;height:22px;font-size:11px', text: poi.kind === 'dam' ? '▲' : poi.kind === 'gage' ? '◉' : '≋' }),
      el('div', { class: 'main' }, [el('div', { class: 'title', text: poi.name }), el('div', { class: 'sub', text: `${fmt.title(poi.kind)} · ${poi.source || ''}` })]),
      el('span', { class: 'right', text: fmt.mi(haversineMi(c.lat, c.lng, poi.lat, poi.lon), 0) }),
    ]));
  }
}

async function open(poi) {
  showDetail(poiRecord(poi));
  showProgress(`Loading ${poi.name}…`);
  try {
    const d = await api.get(`/api/water/station/${encodeURIComponent(poi.id)}`);
    if (d.ok === false) { toast(d.error || 'No data', 'warn'); return; }
    const merged = { ...poi, ...(d.poi || {}), phone: d.phone || d.poi?.phone || poi.phone, address: d.address || d.poi?.address || poi.address };
    const rec = poiRecord(merged);
    rec.facts = rec.facts.filter(([k]) => !['Gage height', 'Discharge', 'Water temp'].includes(k));
    if (d.backup_station && d.backup_poi) rec.facts.push(['Backup station', `${d.backup_poi.name} (${fmt.mi(d.backup_poi.distance_mi)}) — primary station had no data`]);
    if (d.backup && !d.backup_station) rec.facts.push(['Backup source', d.source || 'model data']);
    const now = Date.now();
    if (poi.kind === 'tide') {
      if (d.water_temp_f != null) rec.facts.push(['Water temp', `${d.water_temp_f} °F`]);
      const ext = (d.predictions || []).map((p) => ({ t: parseTime(p.time), v: +p.height_ft, type: p.type })).filter((p) => !Number.isNaN(p.t));
      const chart = timeChart(interpolateExtremes(ext), ext.map((p) => ({ t: p.t, v: p.v, label: `${p.type[0]} ${p.v.toFixed(1)} ft` })), { unit: 'ft', now, title: 'Tide height today' });
      rec.facts.push([`Tides ${fmt.date(d.date) || 'today'}`, chart]);
      const rows = (d.predictions || []).map((p) => `<tr><td>${p.type}</td><td>${p.time?.split(' ')[1] || p.time}</td><td style="text-align:right">${p.height_ft} ft</td></tr>`).join('');
      rec.facts.push(['', { html: `<table class="aid-table">${rows || '<tr><td>No predictions</td></tr>'}</table>` }]);
      if (d.datum) rec.facts.push(['Datum', d.datum]);
    } else if (poi.kind === 'gage') {
      const r = d.readings || {};
      rec.facts.push(['Gage height', r.gage_height_ft != null ? `${r.gage_height_ft} ft` : '—'], ['Flow', r.discharge_cfs != null ? `${fmt.int(r.discharge_cfs)} cfs` : '—'], ['Water temp', r.water_temp_f != null ? `${r.water_temp_f} °F` : '—'], ['Updated', r.time || r.times?.gage || '']);
      const hist = (d.history_7d || []).map((h) => ({ t: parseTime(h.time), v: h.value })).filter((h) => !Number.isNaN(h.t) && h.v != null);
      if (hist.length > 1) {
        const last = hist[hist.length - 1];
        rec.facts.push(['Level, last 7 days', timeChart(hist, [{ t: last.t, v: last.v, label: `${last.v.toFixed(2)} ft now` }], { unit: 'ft', now, title: 'Gage height, 7 days', fmtV: (v) => `${v.toFixed(2)} ft` })]);
      }
      if (d.stats_7d) rec.facts.push(['7-day range', `${d.stats_7d.min_ft} – ${d.stats_7d.max_ft} ft (mean ${d.stats_7d.mean_ft})`]);
    } else if (poi.kind === 'dam') {
      rec.facts.push(['Pool elevation', d.pool_elevation_ft != null ? `${d.pool_elevation_ft} ft` : '—'], ['Tailwater', d.tailwater_ft != null ? `${d.tailwater_ft} ft` : '—'], ['Inflow', d.inflow_cfs != null ? `${fmt.int(d.inflow_cfs)} cfs` : '—'], ['Outflow (release)', d.outflow_cfs != null ? `${fmt.int(d.outflow_cfs)} cfs` : '—'], ['Storage', d.storage_acft != null ? `${fmt.int(d.storage_acft)} ac-ft` : '—'], ['Office', d.office], ['Updated', d.updated]);
    } else if (poi.kind === 'current') {
      const pts = (d.predictions || []).map((p) => {
        let v = +p.velocity_kt; if (p.type === 'ebb' && v > 0) v = -v; if (p.type === 'slack') v = 0;
        return { t: parseTime(p.time), v, type: p.type };
      }).filter((p) => !Number.isNaN(p.t) && !Number.isNaN(p.v));
      if (pts.length > 1) {
        const peaks = pts.filter((p) => p.type !== 'slack').map((p) => ({ t: p.t, v: p.v, label: `${p.type} ${Math.abs(p.v).toFixed(1)} kt` }));
        rec.facts.push(['Current (flood +, ebb −)', timeChart(interpolateExtremes(pts), peaks, { unit: 'kt', zero: true, now, title: 'Current velocity today', fmtV: (v) => `${v.toFixed(1)} kt` })]);
      }
      const rows = (d.predictions || []).map((p) => `<tr><td>${p.type || ''}</td><td>${p.time?.split(' ')[1] || p.time}</td><td style="text-align:right">${p.velocity_kt != null ? Math.abs(p.velocity_kt).toFixed(1) + ' kt' : ''}</td></tr>`).join('');
      if (rows) rec.facts.push(['', { html: `<table class="aid-table">${rows}</table>` }]);
    }
    showDetail(rec);
  } catch (err) { toast(`Station: ${err.message}`, 'err'); } finally { hideProgress(); }
}

/** Find the nearest station of one kind to a point (fetching around it if needed) and open it. */
export async function openNearest(latlng, kind, label = kind) {
  showProgress(`Finding nearest ${label} station…`);
  try {
    // Widen the search box until something turns up (≈40 mi → 100 mi → 200 mi).
    let items = [];
    for (const pad of [0.6, 1.5, 3.0]) {
      const bbox = `${(latlng.lat - pad).toFixed(4)},${(latlng.lng - pad).toFixed(4)},${(latlng.lat + pad).toFixed(4)},${(latlng.lng + pad).toFixed(4)}`;
      const data = await api.get('/api/water/stations', { bbox, types: kind });
      items = (data.items || []).filter((p) => p.kind === kind);
      if (items.length) break;
    }
    if (!items.length) { toast(`No ${label} station within about 200 miles`, 'warn', 5000); return; }
    items.sort((a, b) => haversineMi(latlng.lat, latlng.lng, a.lat, a.lon) - haversineMi(latlng.lat, latlng.lng, b.lat, b.lon));
    const dist = haversineMi(latlng.lat, latlng.lng, items[0].lat, items[0].lon);
    const poi = { ...items[0], distance_mi: dist };
    if (dist > 40) toast(`No ${label} station close by — showing ${poi.name}, ${dist.toFixed(0)} mi away`, 'info', 5000);
    if (!state.items.has(poi.id)) {
      L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.kind), title: poi.name }).bindTooltip(poi.name, { direction: 'top', offset: [0, -12] }).on('click', () => open(poi)).addTo(layers.water);
      state.items.set(poi.id, poi);
    }
    await open(poi);
  } catch (err) { toast(`${label}: ${err.message}`, 'err'); } finally { hideProgress(); }
}

export async function waterTemp(latlng) {
  const c = latlng || map.getCenter();
  showProgress('Checking water temperature…');
  try {
    const d = await api.get('/api/water/temp', { lat: c.lat.toFixed(4), lon: c.lng.toFixed(4) });
    if (d.ok === false || !d.primary) { toast(d.error || 'No water temperature reading found anywhere nearby', 'warn', 5000); return; }
    const p = d.primary;
    if (d.note) toast(d.note, 'info', 6000);
    showDetail({ title: p.station_name || 'Water temperature', kind: 'gage', subtitle: d.note || '', lat: p.lat, lon: p.lon, facts: [['Water temp', `${p.water_temp_f} °F (${p.water_temp_c} °C)`], ['Distance from here', fmt.mi(p.distance_mi)], ['Measured', p.time], ...((d.all || []).slice(1).map((s) => [`${s.source}`, `${s.water_temp_f} °F at ${s.station_name} (${fmt.mi(s.distance_mi)})`]))], source: p.source });
  } catch (err) { toast(`Water temp: ${err.message}`, 'err'); } finally { hideProgress(); }
}

