/** NWS forecast for the map center (or a picked point) with active alerts. */

import { api } from './api.js';
import { $, el, fmt, toast, panelSkeleton, onPanelChange, showProgress, hideProgress } from './ui.js';
import { map, layers, poiIcon } from './map.js';

const state = { body: null, picking: false, point: null, loaded: false };

export function init(view) {
  const { body, foot } = panelSkeleton(view, 'Weather', 'National Weather Service forecast for the map center or a point you pick.');
  state.body = body;
  foot.hidden = false;
  foot.append(
    el('button', { class: 'btn primary', text: 'Forecast at center', onclick: () => load(map.getCenter()) }),
    el('button', { class: 'btn', text: 'Pick a point', onclick: () => { state.picking = true; $('#map').classList.add('measuring'); toast('Click the map to pick a forecast point', 'info'); } }),
  );
  map.on('click', (e) => { if (state.picking) { state.picking = false; $('#map').classList.remove('measuring'); load(e.latlng); } });
  onPanelChange((name) => { if (name === 'weather' && !state.loaded) load(map.getCenter()); });
  body.append(el('div', { class: 'empty' }, [el('b', { text: 'No forecast yet' }), 'Open this panel or click "Forecast at center".']));
}

export async function load(latlng) {
  state.loaded = true;
  showProgress('Fetching NWS forecast…');
  try {
    const data = await api.get('/api/weather', { lat: latlng.lat.toFixed(4), lon: latlng.lng.toFixed(4) });
    render(data, latlng);
  } catch (err) {
    toast(`Weather: ${err.message}`, 'err');
  } finally { hideProgress(); }
}

function render(data, latlng) {
  const b = state.body;
  b.innerHTML = '';
  layers.search.clearLayers();
  L.marker(latlng, { icon: poiIcon('gage'), interactive: false }).addTo(layers.search);
  if (data.ok === false) { b.append(el('div', { class: 'empty' }, [el('b', { text: 'No forecast' }), data.error || 'NWS has no grid for this point.'])); return; }
  b.append(el('div', { class: 'box' }, [
    el('h4', { text: 'Location' }),
    el('div', { text: data.location || fmt.coord(latlng.lat, latlng.lng, 3) }),
    el('div', { class: 'muted small', text: [data.office ? `NWS ${data.office}` : '', data.cached ? `cached ${data.cached_age_min} min ago` : 'live'].filter(Boolean).join(' · ') }),
  ]));
  for (const a of data.alerts || []) b.append(el('div', { class: 'alert' }, [el('b', { text: a.event || 'Alert' }), a.headline || a.description?.slice(0, 200) || '']));
  for (const p of data.periods || []) {
    b.append(el('div', { class: 'wx-period' }, [
      p.icon ? el('img', { src: p.icon, alt: '' }) : null,
      el('div', {}, [el('div', { class: 'wx-name', text: p.name }), el('div', { class: 'wx-sub', text: `${p.shortForecast || ''} · wind ${p.windSpeed || '—'} ${p.windDirection || ''}` })]),
      el('div', { class: 'wx-temp', text: p.temperature != null ? `${p.temperature}°${p.temperatureUnit || 'F'}` : '' }),
    ]));
  }
}
