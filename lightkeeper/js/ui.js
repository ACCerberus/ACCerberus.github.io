/** Small DOM + formatting helpers shared by every module. No app state lives here. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Create an element: el('div', {class:'x', onclick: fn}, [children...]) */
const SVG_TAGS = new Set(['svg', 'path', 'line', 'circle', 'rect', 'text', 'g', 'polyline', 'polygon']);
export function el(tag, attrs = {}, children = []) {
  const node = SVG_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmt = {
  coord: (lat, lon, dp = 5) => `${(+lat).toFixed(dp)}, ${(+lon).toFixed(dp)}`,
  dms(lat, lon) {
    const one = (v, pos, neg) => {
      const a = Math.abs(v); const d = Math.floor(a); const m = (a - d) * 60;
      return `${d}°${m.toFixed(3).padStart(6, '0')}' ${v >= 0 ? pos : neg}`;
    };
    return `${one(lat, 'N', 'S')}  ${one(lon, 'E', 'W')}`;
  },
  mi: (v, dp = 1) => (v == null ? '—' : `${(+v).toFixed(dp)} mi`),
  nm: (v, dp = 1) => (v == null ? '—' : `${(+v).toFixed(dp)} NM`),
  hrs(h) {
    if (h == null) return '—';
    const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  },
  clock(min) {
    if (min == null) return '—';
    const m = Math.round(min) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  },
  date(iso) {
    if (!iso) return '';
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  },
  ago(iso) {
    if (!iso) return 'never';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  },
  int: (v) => (v == null ? '—' : Number(v).toLocaleString()),
  title: (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
};

/* ── Toasts ── */
export function toast(message, type = 'info', ms = 3200) {
  const box = $('#toasts');
  const node = el('div', { class: `toast ${type}`, text: message });
  box.append(node);
  setTimeout(() => node.remove(), ms);
}

/* ── Progress strip (one at a time, says what it is doing) ── */
let progressHidden = false;
export function showProgress(text, fraction = null) {
  const wrap = $('#progress');
  if (progressHidden) return;
  wrap.hidden = false;
  $('#progress-text').textContent = text;
  const fill = $('#progress-fill');
  if (fraction == null) { fill.classList.add('indeterminate'); fill.style.width = ''; }
  else { fill.classList.remove('indeterminate'); fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`; }
}
export function hideProgress() { $('#progress').hidden = true; progressHidden = false; }
$('#progress-close')?.addEventListener('click', () => { $('#progress').hidden = true; progressHidden = true; });

/* ── Status bar ── */
export function setStatus(parts) {
  if (parts.coords !== undefined) $('#sb-coords').textContent = parts.coords;
  if (parts.district !== undefined) $('#sb-district').textContent = parts.district;
  if (parts.aids !== undefined) $('#sb-aids').textContent = parts.aids;
  if (parts.zoom !== undefined) $('#sb-zoom').textContent = `Zoom ${parts.zoom}`;
  if (parts.online !== undefined) {
    const n = $('#sb-online');
    n.textContent = parts.online ? 'Online' : 'Offline — cached data';
    n.className = parts.online ? 'online' : 'offline';
  }
}

/* ── Panel views ── */
const panelListeners = new Set();
export function showPanel(name) {
  $$('#rail button[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  $$('#panel .view').forEach((v) => v.classList.toggle('on', v.id === `view-${name}`));
  document.body.classList.remove('panel-hidden');
  panelListeners.forEach((fn) => fn(name));
}
export function onPanelChange(fn) { panelListeners.add(fn); }
export function currentPanel() { return $('#rail button.on')?.dataset.panel || 'aids'; }

/** Build a standard panel skeleton: returns {head, body, foot} containers. */
export function panelSkeleton(view, title, subtitle) {
  view.innerHTML = '';
  const head = el('div', { class: 'view-head' }, [el('h2', { html: title }), subtitle ? el('p', { text: subtitle }) : null]);
  const body = el('div', { class: 'view-body' });
  const foot = el('div', { class: 'view-foot' });
  foot.hidden = true;
  view.append(head, body, foot);
  return { head, body, foot };
}

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`lk2.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`lk2.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

export const ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  xy: '<svg viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="4"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
};

/* ── Simple modal dialog ── */
export function dialog(title, bodyNodes, { okText = 'OK' } = {}) {
  const close = () => overlay.remove();
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } }, [
    el('div', { class: 'modal', role: 'dialog', 'aria-label': title }, [
      el('h3', { text: title }),
      ...[].concat(bodyNodes),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, [el('button', { class: 'btn primary', text: okText, onclick: close, style: 'flex:0 0 auto' })]),
    ]),
  ]);
  document.body.append(overlay);
  return close;
}
