/** Connection check at startup: one timed download of a small picture from the LightKeeper site.
 *  Slow link (or Lite picked in Settings) -> save data: only your district's aids load, and the map keeps
 *  fewer tiles around it. Settings > Connection shows the result and lets the user force Lite or Full. */

import { store } from './ui.js?v=2.1.1-3';

export const DESKTOP = import.meta.url.includes('/static/js/');
const TEST_URL = DESKTOP ? 'https://cerberusac.dev/lightkeeper/img/icon-512.png' : new URL('../img/icon-512.png', import.meta.url).href;
const SLOW_MS = 1800;          // 50 KB taking longer than this (after the connection is open) is a slow link
const TIMEOUT_MS = 8000;

export const net = { mode: store.get('netMode', 'auto'), slow: false, checked: false, ms: null, mbps: null, note: '' };
let ready = null;

export function check() {
  ready = (async () => {
    const c = navigator.connection;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // Open the connection first (name lookup + secure handshake), so the timing below is the download alone.
      await fetch(`${TEST_URL}?speedtest=warm${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
      const t0 = performance.now();
      const resp = await fetch(`${TEST_URL}?speedtest=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
      const bytes = (await resp.arrayBuffer()).byteLength;
      net.ms = Math.round(performance.now() - t0);
      net.mbps = Math.round((bytes * 8) / (net.ms / 1000) / 1e5) / 10;
      net.slow = net.ms > SLOW_MS;
    } catch (err) {
      // Timed out = very slow. Any other failure (offline, site unreachable) says nothing about speed.
      net.slow = err?.name === 'AbortError';
      net.note = net.slow ? 'test download timed out' : 'could not test';
    } finally {
      clearTimeout(timer);
    }
    if (c?.saveData) { net.slow = true; net.note = 'data saver is on'; }
    else if (['slow-2g', '2g'].includes(c?.effectiveType)) net.slow = true;
    net.checked = true;
    document.dispatchEvent(new CustomEvent('net-checked', { detail: net }));
    return net;
  })();
  return ready;
}

/** True when the app should save data. */
export const lite = () => net.mode === 'lite' || (net.mode === 'auto' && net.slow);

/** The check's result, waiting at most maxMs for it. */
export function whenChecked(maxMs = TIMEOUT_MS + 500) {
  if (!ready) return Promise.resolve(net);
  return Promise.race([ready, new Promise((r) => setTimeout(() => r(net), maxMs))]);
}

export function setMode(mode) {
  net.mode = mode;
  store.set('netMode', mode);
  document.dispatchEvent(new CustomEvent('net-mode', { detail: lite() }));
}

export function describe() {
  if (!net.checked) return 'Checking connection…';
  const speed = net.ms != null ? `test took ${net.ms} ms (about ${net.mbps} Mbps)` : net.note;
  return `${net.slow ? 'Slow connection' : 'Connection OK'} · ${speed}`;
}
