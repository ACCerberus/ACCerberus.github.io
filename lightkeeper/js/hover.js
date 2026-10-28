/** Subtle hover hint next to the pointer: "Right-click for more", plus the nearest tide / current / gage / dam
 *  when some are loaded nearby. Shown after the cursor rests; hidden as soon as it moves again. */

import { el, fmt } from './ui.js?v=2.1.0';
import { map } from './map.js?v=2.1.0';
import { nearestStations, hoverEnabled } from './water.js?v=2.1.0';

const GLYPH = { tide: '≋', current: '➤', gage: '◉', dam: '▲' };
const REST_MS = 450;
let hint;
let restTimer;

export function init() {
  hint = el('div', { id: 'hover-hint', hidden: true });
  document.getElementById('map').append(hint);
  map.on('mousemove', (e) => { hide(); clearTimeout(restTimer); restTimer = setTimeout(() => show(e), REST_MS); });
  map.on('mouseout movestart zoomstart contextmenu click', () => { clearTimeout(restTimer); hide(); });
  map.getContainer().addEventListener('mouseleave', () => { clearTimeout(restTimer); hide(); });
}

function hide() { hint.hidden = true; }

function show(e) {
  hint.innerHTML = '';
  if (hoverEnabled() && map.getZoom() >= 7) {
    for (const s of nearestStations(e.latlng.lat, e.latlng.lng).slice(0, 3)) {
      hint.append(el('div', { class: 'hh-row' }, [
        el('span', { class: `hh-glyph ${s.kind}`, text: GLYPH[s.kind] || '•' }),
        el('span', { class: 'hh-name', text: s.name }),
        el('span', { class: 'hh-dist', text: fmt.mi(s.distance_mi, 0) }),
      ]));
    }
  }
  hint.append(el('div', { class: 'hh-tip', text: 'Right-click for tides, weather & more' }));
  const size = map.getSize();
  const w = 220; const h = hint.offsetHeight || 24;
  const x = e.containerPoint.x + 16 + w > size.x ? e.containerPoint.x - w - 10 : e.containerPoint.x + 16;
  const y = e.containerPoint.y + 18 + h > size.y ? e.containerPoint.y - h - 6 : e.containerPoint.y + 18;
  hint.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  hint.hidden = false;
}
