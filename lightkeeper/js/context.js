/** Right-click menu on the map: look up tides, currents, weather, water temp, places, measure. */

import { $, el, fmt, toast, showPanel } from './ui.js?v=2.1.3-3';
import { map, flyTo } from './map.js?v=2.1.3-3';
import * as water from './water.js?v=2.1.3-3';
import * as weather from './weather.js?v=2.1.3-3';
import * as measure from './measure.js?v=2.1.3-3';
import * as poi from './poi.js?v=2.1.3-3';

let menu;
let backdrop;

export function init() {
  menu = el('div', { id: 'ctx-menu', hidden: true });
  $('#map').append(menu);
  map.on('contextmenu', (e) => { L.DomEvent.preventDefault(e.originalEvent); show(e); });
  map.on('click movestart zoomstart', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) hide(); });
}

function hide() { if (menu) menu.hidden = true; if (backdrop) backdrop.hidden = true; }

function show(e) {
  const ll = e.latlng;
  const items = [
    ['≋', 'Tides here', () => water.openNearest(ll, 'tide', 'tide')],
    ['➤', 'Currents here', () => water.openNearest(ll, 'current', 'current')],
    ['◉', 'River gage here', () => water.openNearest(ll, 'gage', 'gage')],
    ['▲', 'Dam info here', () => water.openNearest(ll, 'dam', 'dam')],
    ['☁', 'Weather here', () => { showPanel('weather'); weather.load(ll); }],
    ['🌡', 'Water temperature', () => water.waterTemp(ll)],
    null,
    ['⚓', 'Boat ramps near here', () => { flyTo(ll.lat, ll.lng, 11); poi.enableLayer('ramps'); }],
    ['🛏', 'Lodging near here', () => { flyTo(ll.lat, ll.lng, 11); poi.enableLayer('hotels'); }],
    null,
    ['📏', 'Measure from here', () => { showPanel('measure'); measure.startFrom(ll); }],
    ['⎘', `Copy ${fmt.coord(ll.lat, ll.lng, 5)}`, () => navigator.clipboard?.writeText(fmt.coord(ll.lat, ll.lng, 5)).then(() => toast('Coordinates copied', 'ok'))],
  ];
  // Phones have no measure tool (it is a desktop feature); drop that entry.
  const phone = document.body.classList.contains('phone');
  const shown = phone ? items.filter((it) => !it || it[1] !== 'Measure from here') : items;
  menu.innerHTML = '';
  menu.classList.toggle('ctx-sheet', phone);
  if (phone) {
    // Phones: a centered card over a dimmed map, with a title and a close button, scrolling when it is taller than the screen.
    if (menu.parentElement !== document.body) document.body.append(menu);
    if (!backdrop) { backdrop = el('div', { id: 'ctx-backdrop', hidden: true, onclick: hide }); document.body.append(backdrop); }
    menu.append(el('div', { class: 'ctx-head' }, [
      el('span', { text: fmt.coord(ll.lat, ll.lng, 4) }),
      el('button', { class: 'ctx-close', 'aria-label': 'Close', text: '✕', onclick: (ev) => { ev.stopPropagation(); hide(); } }),
    ]));
  } else if (menu.parentElement === document.body) {
    $('#map').append(menu);
  }
  for (const item of shown) {
    if (!item) { menu.append(el('div', { class: 'ctx-sep' })); continue; }
    const [glyph, label, action] = item;
    menu.append(el('button', { onclick: () => { hide(); action(); } }, [el('span', { class: 'ctx-glyph', text: glyph }), label]));
  }
  if (phone) {
    menu.style.transform = '';
    backdrop.hidden = false;
    menu.hidden = false;
    menu.scrollTop = 0;
    return;
  }
  const size = map.getSize();
  menu.hidden = false;
  const w = menu.offsetWidth || 230; const h = menu.offsetHeight || shown.length * 30;
  const x = Math.max(4, e.containerPoint.x + w > size.x ? Math.min(e.containerPoint.x - w, size.x - w - 4) : e.containerPoint.x);
  const y = e.containerPoint.y + h > size.y ? Math.max(4, size.y - h - 8) : e.containerPoint.y;
  menu.style.transform = `translate(${x}px, ${y}px)`;
  menu.hidden = false;
}
