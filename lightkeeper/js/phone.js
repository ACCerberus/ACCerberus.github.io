/** Phone mode: bottom tab bar instead of the rail, panels and the detail card as bottom sheets, long-press for
 *  the map menu. Detected from the viewport (a browser cannot read the phone model); the screen size and pixel
 *  ratio are logged and shown in Settings → About. */

import { $, $$, showPanel, onPanelChange } from './ui.js?v=2.0.7-4';
import { map } from './map.js?v=2.0.7-4';
import { onDetailOpen, hideDetail } from './detail.js?v=2.0.7-4';

const PHONE_QUERY = '(max-width: 820px), (pointer: coarse) and (max-width: 1024px), (max-height: 500px) and (max-width: 1024px)';
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const SHEET_MIN_VH = 30;
const state = { phone: false, decided: false, dragging: null };

export const isPhone = () => state.phone;
/** The open panel by its view element (the rail has no button for every phone tab). */
const activePanel = () => $('#panel .view.on')?.id.replace('view-', '') || 'aids';

export function init() {
  const mq = matchMedia(PHONE_QUERY);
  console.info(`[lightkeeper] screen ${screen.width}x${screen.height} @ ${window.devicePixelRatio || 1}dpr, viewport ${innerWidth}x${innerHeight}, phone mode: ${mq.matches}`);
  // A pane that has not been laid out yet reports a 0×0 viewport; decide once it has a real size.
  if (innerWidth > 0) apply(mq.matches);
  else window.addEventListener('resize', () => { if (!state.decided && innerWidth > 0) apply(mq.matches); }, { once: false });
  mq.addEventListener('change', (e) => { if (innerWidth > 0) apply(e.matches); });

  $$('#tabbar button').forEach((b) => b.addEventListener('click', () => {
    if (activePanel() === b.dataset.panel && !document.body.classList.contains('panel-hidden')) document.body.classList.add('panel-hidden');
    else showPanel(b.dataset.panel);
    syncTabs();
  }));
  // One sheet at a time on a phone: a panel replaces the detail card and vice versa.
  onPanelChange(() => { if (state.phone) hideDetail(); syncTabs(); });
  onDetailOpen(() => { if (state.phone) { document.body.classList.add('panel-hidden'); syncTabs(); } });
  initSheetHandle();
  initLongPress();
}

function apply(on) {
  if (state.decided && on === state.phone) return;
  state.decided = true;
  state.phone = on;
  document.body.classList.toggle('phone', on);
  $('#tabbar').hidden = !on;
  map.zoomControl.setPosition(on ? 'bottomright' : 'topright');
  if (on) {
    // A phone starts on the map; the first tab tap opens its sheet.
    if (['trip', 'measure', 'whatsnew'].includes(activePanel())) showPanel('aids');
    document.body.classList.add('panel-hidden');
  } else {
    $('#panel').style.height = '';
    document.body.classList.remove('panel-hidden');
  }
  syncTabs();
  setTimeout(() => map.invalidateSize({ animate: false }), 60);
}

function syncTabs() {
  const name = activePanel();
  const hidden = document.body.classList.contains('panel-hidden');
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', !hidden && b.dataset.panel === name));
}

/* ── Sheet drag handle: drag up for full height, drag down to shrink or close ── */
function initSheetHandle() {
  const panel = $('#panel');
  const handle = document.createElement('div');
  handle.id = 'sheet-handle';
  handle.innerHTML = '<span class="grip"></span><button type="button" class="sheet-close" aria-label="Close">×</button>';
  panel.prepend(handle);
  handle.querySelector('.sheet-close').addEventListener('click', () => { document.body.classList.add('panel-hidden'); syncTabs(); });
  handle.addEventListener('pointerdown', (e) => {
    if (!state.phone || e.target.closest('.sheet-close')) return;
    state.dragging = { y0: e.clientY, h0: panel.getBoundingClientRect().height };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    const h = Math.max(window.innerHeight * 0.2, Math.min(maxSheetHeight(), state.dragging.h0 - (e.clientY - state.dragging.y0)));
    panel.style.height = `${h}px`;
  });
  const end = () => {
    if (!state.dragging) return;
    state.dragging = null;
    const h = panel.getBoundingClientRect().height;
    if (h < window.innerHeight * (SHEET_MIN_VH / 100) * 0.85) { document.body.classList.add('panel-hidden'); panel.style.height = ''; syncTabs(); }
    else if (h > maxSheetHeight() * 0.8) panel.style.height = `${maxSheetHeight()}px`;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { panel.style.height = panel.getBoundingClientRect().height > maxSheetHeight() * 0.8 ? '' : `${maxSheetHeight()}px`; });
}
const maxSheetHeight = () => window.innerHeight - cssPx('--top-h') - cssPx('--tab-h');
const cssPx = (name) => parseFloat(getComputedStyle(document.body).getPropertyValue(name)) || 0;

/* ── Long-press (500 ms, still finger) → the same menu as a right-click ── */
function initLongPress() {
  const container = map.getContainer();
  let timer = null; let start = null; let lastSynthetic = 0;
  const cancel = () => { clearTimeout(timer); timer = null; start = null; };
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { cancel(); return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      const point = map.mouseEventToContainerPoint({ clientX: start.x, clientY: start.y });
      lastSynthetic = Date.now();
      if (navigator.vibrate) navigator.vibrate(10);
      map.fire('contextmenu', { latlng: map.containerPointToLatLng(point), containerPoint: point, layerPoint: map.containerPointToLayerPoint(point), originalEvent: e });
      timer = null;
    }, LONG_PRESS_MS);
  }, { passive: true });
  container.addEventListener('touchmove', (e) => {
    if (!start) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
  }, { passive: true });
  container.addEventListener('touchend', cancel, { passive: true });
  container.addEventListener('touchcancel', cancel, { passive: true });
  // Some mobile browsers also synthesise a native contextmenu after a long press; keep only ours.
  map.on('contextmenu', (e) => { if (e.originalEvent?.type !== 'touchstart' && Date.now() - lastSynthetic < 800) L.DomEvent.stop(e.originalEvent); });
}
