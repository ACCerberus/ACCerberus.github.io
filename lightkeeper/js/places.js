/** Places panel (phone mode): toggle the boat ramp / lodging / park layers and list what is loaded around the
 *  map, nearest first, with address and a tap-to-call phone number. Desktop users have the top-bar chips. */

import { el, fmt, panelSkeleton, onPanelChange } from './ui.js?v=2.1.3-2';
import { map } from './map.js?v=2.1.3-2';
import { showPoi } from './detail.js?v=2.1.3-2';
import { haversineMi } from './geo.js?v=2.1.3-2';
import * as poi from './poi.js?v=2.1.3-2';

const LAYERS = [['ramps', 'Boat ramps', '⚓'], ['hotels', 'Hotels', '🛏'], ['parks', 'Parks', '🌲']];
const state = { listEl: null, pills: null, active: false };

export function init(view) {
  const { body } = panelSkeleton(view, 'Places', 'Boat ramps, marinas, lodging and parks with ramps around the map. Tap one for its address and phone.');
  state.pills = el('div', { class: 'pills' }, LAYERS.map(([name, label, glyph]) => el('button', {
    class: `pill${poi.isOn(name) ? ' on' : ''}`, dataset: { layer: name }, text: `${glyph} ${label}`,
    onclick: () => { poi.toggleLayer(name); render(); },
  })));
  state.listEl = el('div', { class: 'list' });
  body.append(state.pills, state.listEl);
  onPanelChange((name) => { state.active = name === 'places'; if (state.active) render(); });
  window.addEventListener('lk:places', () => { if (state.active) render(); });
  map.on('moveend', () => { if (state.active) render(); });
  render();
}

function render() {
  state.pills.querySelectorAll('.pill').forEach((p) => p.classList.toggle('on', poi.isOn(p.dataset.layer)));
  const c = map.getCenter();
  const items = LAYERS.filter(([name]) => poi.isOn(name)).flatMap(([name]) => poi.loadedItems(name))
    .map((p) => ({ ...p, distance_mi: haversineMi(c.lat, c.lng, p.lat, p.lon) }))
    .sort((a, b) => a.distance_mi - b.distance_mi);
  state.listEl.innerHTML = '';
  if (!LAYERS.some(([name]) => poi.isOn(name))) { state.listEl.append(el('div', { class: 'empty' }, [el('b', { text: 'Pick a place type above' }), 'Places load around the map view (zoom in to about 25 miles).'])); return; }
  if (!items.length) { state.listEl.append(el('div', { class: 'empty' }, [el('b', { text: map.getZoom() < 8 ? 'Zoom in to load places' : 'Nothing loaded here yet' }), 'Pan or zoom the map; places appear as they are found.']) ); return; }
  for (const p of items.slice(0, 80)) {
    state.listEl.append(el('div', { class: 'item', onclick: () => showPoi(p) }, [
      el('span', { class: `m-poi ${p.kind}`, style: 'width:26px;height:26px;font-size:12px;flex-shrink:0', text: p.kind === 'park' ? '🌲' : ['ramp', 'marina'].includes(p.kind) ? '⚓' : p.kind === 'campground' ? '⛺' : '🛏' }),
      el('div', { class: 'main' }, [
        el('div', { class: 'title', text: p.name }),
        el('div', { class: 'sub', text: [fmt.title(p.kind), p.address || 'Address unknown'].join(' · ') }),
        p.phone ? el('a', { class: 'sub', href: `tel:${p.phone.replace(/[^+\d]/g, '')}`, text: p.phone, onclick: (e) => e.stopPropagation() }) : null,
      ]),
      el('span', { class: 'right', text: fmt.mi(p.distance_mi) }),
    ]));
  }
}
