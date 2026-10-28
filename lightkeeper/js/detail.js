/** The one detail card. Everything clickable on the map funnels into showDetail(). */

import { $, el, esc, fmt, ICONS, toast } from './ui.js?v=2.1.3-2';
import { photoUrl, satView } from './photo.js?v=2.1.3-2';
import { lite } from './netcheck.js?v=2.1.3-2';
import { flyTo, map } from './map.js?v=2.1.3-2';
import { api } from './api.js?v=2.1.3-2';
import * as units from './units.js?v=2.1.3-2';
import { layers, poiIcon, AID_COLORS } from './map.js?v=2.1.3-2';
import { loadedItems } from './poi.js?v=2.1.3-2';
import { logForAid, ENABLED as DISCREP_ON } from './discrepancies.js?v=2.1.3-2';
import { haversineNM } from './geo.js?v=2.1.3-2';

const card = () => $('#detail');
let current = null;
const openListeners = new Set();
export function onDetailOpen(fn) { openListeners.add(fn); }

export function hideDetail() { card().hidden = true; current = null; layers.route?.clearLayers(); }   // closing the card also removes its ramp route

/**
 * record = { title, kind, subtitle, lat, lon, address, phone, website, facts: [[label, value]], actions: [{label, primary, onClick}], source }
 */
export function showDetail(record) {
  current = record;
  const c = card();
  c.innerHTML = '';
  const head = el('div', { class: 'd-head' }, [
    record.lead || null,
    el('div', { class: 'd-title' }, [
      el('h3', { text: record.title || 'Unnamed' }),
      record.subtitle ? el('div', { class: 'muted small', text: record.subtitle }) : null,
    ]),
    record.kind ? el('span', { class: `badge ${record.kind}`, text: fmt.title(record.kind) }) : null,
    el('button', { class: 'd-close', title: 'Close', onclick: hideDetail, html: '&times;' }),
  ]);
  const body = el('div', { class: 'd-body' });
  if (record.render) {                 // cards with their own layout (aids)
    record.render(body);
    if (record.source) body.append(el('div', { class: 'd-src', text: `Source: ${record.source}` }));
    const pic = hero(record, { photo: false, small: true });
    if (pic) c.append(pic);
    c.append(head, body);
    if (record.bar) c.append(record.bar);
    c.hidden = false;
    openListeners.forEach((fn) => fn(record));
    return;
  }
  const pic = hero(record, { photo: !!record.photo });
  if (record.chips?.length) body.append(el('div', { class: 'd-chips' }, record.chips.map(([k, v]) => el('span', { class: 'd-chip' }, [k ? `${k} ` : '', el('b', { text: String(v) })]))));
  if (record.address) body.append(line(ICONS.pin, record.address));
  const contact = el('div', { class: 'd-contact' });
  if (record.phone) contact.append(el('a', { class: 'btn sm primary', href: `tel:${record.phone.replace(/[^+\d]/g, '')}`, html: `${ICONS.phone}<span></span>` }));
  if (record.website) contact.append(el('a', { class: 'btn sm', href: record.website, target: '_blank', rel: 'noopener', html: `${ICONS.globe}<span>Website</span>` }));
  if (record.phone) contact.querySelector('span').textContent = `Call ${record.phone}`;
  if (contact.children.length) body.append(contact);
  if (record.hours) body.append(el('div', { class: 'd-hours', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' }, [el('span', { text: record.hours })]));
  if (record.lat != null) {
    body.append(line(ICONS.xy, el('span', { text: `${fmt.coord(record.lat, record.lon)}  ·  ${fmt.dms(record.lat, record.lon)}`, title: 'Click to copy', style: 'cursor:copy', onclick: () => copy(fmt.coord(record.lat, record.lon)) })));
  }
  const facts = (record.facts || []).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (facts.length) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of facts) {
      const dd = el('dd');
      const isNode = !!(v && v.nodeType);
      const isHtml = !!(v && !isNode && typeof v === 'object' && 'html' in v);
      if (isNode) dd.append(v);
      else if (isHtml) dd.innerHTML = v.html;
      else dd.textContent = String(v);
      const dt = el('dt', { text: k });
      // Only charts and tables take the full card width; links and live cells stay beside their label.
      const wide = (isNode && /^(svg|table)$/i.test(v.tagName)) || (isHtml && /<table/i.test(v.html));
      if (wide) { dt.classList.add('wide'); dd.classList.add('wide'); if (!k) dt.hidden = true; }
      dl.append(dt, dd);
    }
    body.append(dl);
  }
  const actions = el('div', { class: 'd-actions' });
  if (record.lat != null) {
    actions.append(el('button', { class: 'btn sm', text: 'Zoom', onclick: () => flyTo(record.lat, record.lon, 15) }));
    actions.append(el('a', { class: 'btn sm', text: 'Directions', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/dir/?api=1&destination=${record.lat},${record.lon}` }));
    if (record.kind && record.kind !== 'light' && record.kind !== 'buoy' && record.kind !== 'daybeacon' && record.kind !== 'bridge') {
      actions.append(el('a', { class: 'btn sm', text: 'Google Maps', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${record.title} ${record.lat},${record.lon}`)}` }));
    }
  }
  for (const a of record.actions || []) actions.append(el('button', { class: `btn sm${a.primary ? ' primary' : ''}`, text: a.label, onclick: a.onClick }));
  body.append(actions);
  if (record.source) body.append(el('div', { class: 'd-src', text: `Source: ${record.source}${record.quality ? ` · ${record.quality}` : ''}` }));
  if (pic) c.append(pic);
  c.append(head, body);
  c.hidden = false;
  openListeners.forEach((fn) => fn(record));
}

/** Picture strip at the top of a card: satellite view of the spot, replaced by a nearby photo when one exists.
 *  Tapping it switches between the two. Skipped in Lite mode (slow connection). */
function hero(record, { photo = true, small = false } = {}) {
  if (record.lat == null || lite()) return null;
  if (document.body.classList.contains('phone')) return null;   // phones: no picture strip on any card, screen space is short
  const cap = el('span', { class: 'd-hero-cap', text: 'Satellite · Esri' });
  const box = el('div', { class: `d-hero${small ? ' small' : ''}`, title: 'Tap to switch photo / satellite' }, [
    satView(record.lat, record.lon, small ? 16 : 17), el('span', { class: 'd-hero-pin' }), cap,
    el('button', { class: 'd-hero-close', title: 'Close', 'aria-label': 'Close', html: '&times;', onclick: (e) => { e.stopPropagation(); hideDetail(); } }),
  ]);
  box.addEventListener('click', () => {
    if (!box.classList.contains('has-photo')) return;
    const sat = box.classList.toggle('show-sat');
    cap.textContent = sat ? 'Satellite · Esri' : 'Photo · Wikimedia Commons';
  });
  if (photo) {
    photoUrl(record.lat, record.lon, record.title || '').then((url) => {
      if (!url) return;
      const img = el('img', { class: 'd-hero-img', alt: '', src: url });
      img.addEventListener('load', () => { box.classList.add('has-photo'); cap.textContent = 'Photo · Wikimedia Commons'; });
      img.addEventListener('error', () => img.remove());
      box.insertBefore(img, cap);
    });
  }
  return box;
}

function line(icon, content) { return el('div', { class: 'd-line', html: icon }, [content]); }

function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied coordinates', 'ok')).catch(() => {}); }

export function currentDetail() { return current; }

/* ── Record builders ── */

/* ── Aid card ── */

const LIGHT_HEX = { W: '#fff3c4', R: '#ff5a5a', G: '#3ee07a', Y: '#ffd23f', Bu: '#5aa9ff' };
const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..' };
const SVG = {
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.3 1.5A3.5 3.5 0 0 1 17 18z"/></svg>',
  temp: '<svg viewBox="0 0 24 24"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M3 20c2 0 2-1 4-1s2 1 4 1"/></svg>',
  ramp: '<svg viewBox="0 0 24 24"><path d="M12 3v15M8 7h8M5 13a7 7 0 0 0 14 0"/><circle cx="12" cy="3.5" r="1.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
};

/** One period of a light characteristic as [color | null, ms] steps ("Fl (2) G 6s", "Iso R 6s", "Mo (A) W 8s", "Al WR 10s").
 *  steps === null means a steady (fixed) light. Returns null for an unlit aid. */
export function lightPattern(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || !/\b(F|Fl|LFl|Q|VQ|IQ|Iso|Oc|Mo|Al|FFl)\b/.test(s)) return null;
  const alt = s.match(/\bAl\.?\s*(W|R|G|Y)\s*(W|R|G|Y)\b/);
  const colorM = s.replace(/\bAl\.?\s*\w+/, '').match(/\b(W|R|G|Y|Bu)\b/);
  const color = LIGHT_HEX[alt?.[1] || colorM?.[1] || 'W'];
  const periodM = s.match(/(\d+(?:\.\d+)?)\s*s\b/);
  const P = periodM ? parseFloat(periodM[1]) * 1000 : null;
  const groupM = s.match(/\((\d+)(?:\s*\+\s*(\d+))?\)/);
  const groups = groupM ? [Number(groupM[1]), ...(groupM[2] ? [Number(groupM[2])] : [])] : [1];
  const pad = (steps, period) => {
    const used = steps.reduce((t, [, ms]) => t + ms, 0);
    if (period && period > used) steps.push([null, period - used]);
    return steps;
  };
  const flashes = (on, off, gap) => {
    const st = [];
    groups.forEach((n, gi) => {
      for (let i = 0; i < n; i += 1) { st.push([color, on]); if (i < n - 1) st.push([null, off]); }
      if (gi < groups.length - 1) st.push([null, gap]);
    });
    return st;
  };
  if (alt) { const p = P || 6000; return { color, steps: [[LIGHT_HEX[alt[1]], p / 2], [LIGHT_HEX[alt[2]], p / 2]] }; }
  const mo = s.match(/\bMo\s*\(([A-Z])\)/);
  if (mo && MORSE[mo[1]]) {
    const st = [];
    [...MORSE[mo[1]]].forEach((c, i, all) => { st.push([color, c === '.' ? 400 : 1200]); if (i < all.length - 1) st.push([null, 400]); });
    return { color, steps: pad(st, P || 8000) };
  }
  const card = s.match(/\b(V?Q)\s*\((\d+)\)\s*\+\s*LFl/);          // south cardinal: Q (6) + LFl
  if (card) {
    const [on, off] = card[1] === 'VQ' ? [150, 350] : [250, 750];
    const st = [];
    for (let i = 0; i < Number(card[2]); i += 1) st.push([color, on], [null, off]);
    st.push([color, 2000]);
    return { color, steps: pad(st, P || 15000) };
  }
  if (/\bLFl\b/.test(s)) return { color, steps: pad([[color, 2000]], P || 10000) };
  if (/\bVQ\b/.test(s)) return { color, steps: groupM ? pad(flashes(150, 350, 1000), P || 10000) : [[color, 150], [null, 350]] };
  if (/\b(Q|IQ)\b/.test(s)) return { color, steps: groupM ? pad(flashes(250, 750, 1500), P || 10000) : [[color, 250], [null, 750]] };
  if (/\bIso\b/.test(s)) { const p = P || 4000; return { color, steps: [[color, p / 2], [null, p / 2]] }; }
  if (/\bOc\b/.test(s)) {
    const n = groups.reduce((t, g) => t + g, 0); const p = P || 4000;
    const st = [[color, Math.max(800, p - (2 * n - 1) * 500)]];
    for (let i = 0; i < n; i += 1) { st.push([null, 500]); if (i < n - 1) st.push([color, 500]); }
    return { color, steps: st };
  }
  if (/\bFl\b/.test(s)) return { color, steps: pad(flashes(groupM ? 400 : 600, 500, 1300), P || 4000) };
  return { color, steps: null };        // F (fixed) and anything unrecognised: steady
}

/** A small lantern in the card header that flashes the aid's real characteristic. */
function lightPreview(aid) {
  const p = lightPattern(aid.characteristics);
  const dot = el('span', { class: 'lp-dot' });
  const wrap = el('span', { class: 'light-preview', title: p ? `${aid.characteristics} (live preview)` : 'Unlit' }, [dot]);
  const set = (c) => { dot.classList.toggle('off', !c); if (c) dot.style.setProperty('--c', c); };
  if (!p) { wrap.classList.add('unlit'); dot.style.setProperty('--c', AID_COLORS[aid.aid_type] || AID_COLORS.other); return wrap; }
  set(p.color);
  if (!p.steps || matchMedia('(prefers-reduced-motion: reduce)').matches) return wrap;
  let i = 0;
  const tick = () => {
    if (!wrap.isConnected) return;        // card closed or replaced: stop
    const [c, ms] = p.steps[i % p.steps.length];
    i += 1;
    set(c);
    setTimeout(tick, ms);
  };
  setTimeout(tick, 0);
  return wrap;
}

/** Three quick-glance tiles: what the light does, how high, how far it is seen. */
const COLOR_WORD = { W: 'white', R: 'red', G: 'green', Y: 'yellow', Bu: 'blue' };
/** "Fl (2) G 6s" + 5 NM -> "Green, 2 flashes every 6 seconds · seen 5 nautical miles". Empty when unknown. */
export function plainCharacteristic(text, rangeNm) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const alt = s.match(/\bAl\.?\s*(W|R|G|Y)\s*(W|R|G|Y)\b/);
  const colorM = s.replace(/\bAl\.?\s*\w+/, '').match(/\b(W|R|G|Y|Bu)\b/);
  const color = alt ? `Alternating ${COLOR_WORD[alt[1]]} and ${COLOR_WORD[alt[2]]}` : (COLOR_WORD[colorM?.[1]] || 'white');
  const period = s.match(/(\d+(?:\.\d+)?)\s*s\b/)?.[1];
  const group = s.match(/\((\d+)(?:\s*\+\s*(\d+))?\)/);
  const morse = s.match(/\bMo\s*\(([A-Z])\)/)?.[1];
  const every = period ? ` every ${period} seconds` : '';
  let what = '';
  if (morse) what = `Morse code "${morse}"${every}`;
  else if (/\bVQ\b/.test(s)) what = 'very quick flashing';
  else if (/\bIQ\b/.test(s)) what = 'interrupted quick flashing';
  else if (/\bQ\b/.test(s)) what = group ? `${group[1]} quick flashes${every}` : 'quick flashing';
  else if (/\bLFl\b/.test(s)) what = `long flash${every}`;
  else if (/\bIso\b/.test(s)) what = `equal on and off${every}`;
  else if (/\bOc\b/.test(s)) what = group ? `on, with ${group[1]} short eclipses${every}` : `on, briefly off${every}`;
  else if (/\bF\s*Fl\b|\bFFl\b/.test(s)) what = `steady with a brighter flash${every}`;
  else if (/\bFl\b/.test(s)) what = group ? `${group[2] ? `${group[1]} + ${group[2]}` : group[1]} flashes${every}` : `flashes${every}`;
  else if (/\bF\b/.test(s)) what = 'steady (fixed)';
  else if (alt) what = `changing color${every}`;
  else return '';
  const seen = rangeNm ? ` · seen ${rangeNm} nautical miles` : '';
  return `${color[0].toUpperCase()}${color.slice(1)}, ${what}${seen}`;
}

/** Sunrise and sunset (NOAA formula) for a day at a point, as Date objects; null in polar day/night. */
function sunTimes(lat, lon, day = new Date()) {
  const rad = Math.PI / 180;
  const start = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  const n = Math.floor((start - Date.UTC(2000, 0, 1, 12)) / 864e5) + 1 - lon / 360;
  const M = (357.5291 + 0.98560028 * n) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545 + n + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.44 * rad));
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return null;
  const H = Math.acos(cosH) / rad / 360;
  const toDate = (jd) => new Date((jd - 2440587.5) * 864e5);
  return { rise: toDate(transit - H), set: toDate(transit + H) };
}

function sunLine(aid) {
  const t = sunTimes(aid.latitude, aid.longitude);
  if (!t) return null;
  const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const left = (ms) => { const m = Math.round(ms / 6e4); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  let note = '';
  if (now < t.rise) note = `sunrise in ${left(t.rise - now)}`;
  else if (now < t.set) note = `${left(t.set - now)} of daylight left`;
  else note = 'after sunset';
  return el('div', { class: 'ac-sun', title: 'Times are in this device\'s time zone' }, [
    el('span', { text: `Sunrise ${hm(t.rise)}` }), el('span', { text: `Sunset ${hm(t.set)}` }), el('b', { text: note }),
  ]);
}

/** Cruise speed from Settings (mph), read once. */
let cruise = null;
document.addEventListener('settings-changed', () => { cruise = null; });
const cruiseMph = () => (cruise ||= api.get('/api/settings').then((s) => Number(s.speed_mph) || 25).catch(() => 25));
const runTime = (nm, mph) => { const m = Math.max(1, Math.round((nm * 1.15078) / mph * 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

function glanceTiles(aid) {
  const tiles = [
    ['Characteristic', aid.characteristics || 'Unlit'],
    ['Focal plane', aid.focal_plane || (aid.aidheight ? `${aid.aidheight} ft` : '')],
    ['Range', aid.aidrange ? `${aid.aidrange} NM` : ''],
  ];
  return el('div', { class: 'ac-tiles' }, tiles.map(([k, v]) => el('div', { class: 'ac-tile' }, [
    el('div', { class: `ac-v${v ? '' : ' none'}`, text: v || '—', title: v || '' }), el('div', { class: 'ac-k', text: k }),
  ])));
}

/** A titled group of label/value rows; empty rows are dropped, an empty group is skipped. */
function section(title, rows, extra = null) {
  const kept = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!kept.length && !extra) return null;
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of kept) {
    const dd = el('dd');
    if (v && v.nodeType) dd.append(v); else dd.textContent = String(v);
    dl.append(el('dt', { text: k }), dd);
  }
  return el('section', { class: 'd-sec' }, [el('h4', { text: title }), kept.length ? dl : null, extra]);
}

/** A live-data tile: shimmer while loading, then value + source line + a freshness dot
 *  (green: updated within the hour, amber: older, gray: unavailable). */
function liveTile(icon, label, loadingText) {
  const value = el('div', { class: 'lt-value' }, [el('span', { class: 'skel' })]);
  const sub = el('div', { class: 'lt-sub', text: loadingText });
  const dot = el('span', { class: 'fresh', title: 'Loading' });
  const tile = el('div', { class: 'live-tile loading' }, [
    el('span', { class: 'lt-ico', html: icon }),
    el('div', { class: 'lt-main' }, [el('div', { class: 'lt-label', text: label }), value, sub]),
    dot,
  ]);
  return {
    tile,
    progress(text) { if (tile.classList.contains('loading')) sub.textContent = text; },
    done(v, subText, when = null) {
      tile.classList.remove('loading');
      value.innerHTML = '';
      if (v && v.nodeType) value.append(v); else value.textContent = v;
      sub.textContent = subText || '';
      const t = when ? new Date(when).getTime() : NaN;
      const old = Number.isFinite(t) && Date.now() - t > 3600 * 1000;
      dot.className = `fresh ${old ? 'old' : 'ok'}`;
      dot.title = Number.isFinite(t) ? `Updated ${fmt.ago(when)}` : 'Current';
    },
    fail(msg) {
      tile.classList.remove('loading'); tile.classList.add('na');
      value.textContent = msg; sub.textContent = '';
      dot.className = 'fresh na'; dot.title = 'Unavailable';
    },
  };
}

/** Open Google Maps with the ramp as the start and the aid as the end, so both show on one map. */
function openGoogleRoute(ramp, aid) {
  const url = `https://www.google.com/maps/dir/?api=1&origin=${ramp.lat},${ramp.lon}&destination=${aid.latitude},${aid.longitude}`;
  const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
  document.body.append(a); a.click(); a.remove();
}

// Active Broadcast Notices for an aid (set by notices.js, which shows the BNM tab), drawn at the top of its card.
const aidNotices = { lookup: () => [], banner: null };
export function setAidNotices(lookup, banner) { aidNotices.lookup = lookup; aidNotices.banner = banner; }

export function aidRecord(aid, extraActions = []) {
  layers.route?.clearLayers();                 // a new aid card starts without the previous aid's route
  const link = (text, onClick) => el('a', { href: '#', text, onclick: (e) => { e.preventDefault(); onClick(); } });
  const coords = el('span', { class: 'ac-coords' }, [
    el('span', { text: fmt.coord(aid.latitude, aid.longitude) }),
    el('span', { class: 'muted', text: fmt.dms(aid.latitude, aid.longitude) }),
  ]);
  const ctx = { ramp: null };
  const rampBtn = el('button', { class: 'btn sm', text: 'Route to ramp', disabled: true, title: 'Finding the nearest boat ramp…',
    onclick: () => { if (ctx.ramp) { drawWaterRoute(aid, ctx.ramp); openGoogleRoute(ctx.ramp, aid); } } });
  const bar = el('div', { class: 'd-bar' }, [
    rampBtn,
    ...extraActions.map((a) => el('button', { class: `btn sm${a.primary ? ' primary' : ''}`, text: a.label, onclick: a.onClick })),
    DISCREP_ON && el('button', { class: 'btn sm', text: 'Log discrepancy', title: 'Add this aid to the discrepancy tracker', onclick: () => logForAid(aid) }),
    el('button', { class: 'btn sm icon', title: 'Copy coordinates', html: SVG.copy, onclick: () => copy(fmt.coord(aid.latitude, aid.longitude)) }),
    el('button', { class: 'btn sm icon', title: 'Zoom to this aid', html: ICONS.xy, onclick: () => flyTo(aid.latitude, aid.longitude, 15) }),
  ]);
  const render = (body) => {
    const notes = aidNotices.lookup(aid);
    if (notes.length && aidNotices.banner) body.append(aidNotices.banner(notes));
    body.append(glanceTiles(aid));
    const plain = plainCharacteristic(aid.characteristics, aid.aidrange);
    if (plain) body.append(el('div', { class: 'ac-plain', text: plain }));
    const now = el('div', {}, [el('div', { class: 'lt-grid' }, [weatherTile(aid), waterTempTile(aid)]), sunLine(aid)]);
    const nearby = nearestRampTile(aid, (r) => { ctx.ramp = r; rampBtn.disabled = false; rampBtn.title = `Draw the water route to ${r.name} and open it in Google Maps`; });
    for (const s of [
      section('Conditions now', [], now),
      section('Nearby', [], nearby),
      section('Identity', [
        ['Light List #', aid.lightlistnumber], ['Intl LL#', aid.intl_llnr],
        ['Characteristic', aid.characteristics], ['Light color', aid.color],
        ['Range (visibility)', aid.aidrange ? `${aid.aidrange} NM` : ''], ['Focal plane', aid.focal_plane],
        ['Structure', aid.structure], ['Structure height', aid.aidheight ? `${aid.aidheight} ft` : ''],
        ['Daymark', aid.daymark_shape], ['Sound signal', aid.sound_signal],
        ['Remarks', [aid.structure_remark, aid.remark].filter(Boolean).join(' ')],
      ]),
      section('Location', [
        ['Position', coords], ['Waterway', aid.waterway], ['State', aid.state],
        ['CG sector', aid.cg_sector ? link(`${aid.cg_sector} · contact`, () => units.showSector(aid.cg_sector)) : ''],
        ['District', aid.district_id ? link(`D${aid.district_id} · contact`, () => units.showDistrict(aid.district_id)) : ''],
      ]),
    ]) if (s) body.append(s);
  };
  return {
    title: aid.aidname, kind: aid.aid_type, subtitle: aid.lightlistnumber ? `LL# ${aid.lightlistnumber}` : '',
    lat: aid.latitude, lon: aid.longitude, lead: lightPreview(aid), render, bar,
    facts: [['Light List #', aid.lightlistnumber], ['Characteristic', aid.characteristics], ['Waterway', aid.waterway]],
    actions: extraActions, source: 'USCG Light List (NAVCEN)',
  };
}

const liveCache = new Map();   // per-aid results of the live lookups, so re-rendering a card never refetches
function once(key, fn) {
  if (!liveCache.has(key)) liveCache.set(key, fn().catch((e) => { liveCache.delete(key); throw e; }));
  return liveCache.get(key);
}

/** Nearest boat ramp, searched outward 5 → 10 → 15 → 25 mi; if nothing is that close, says so and keeps widening. */
const RAMP_STEPS_MI = [5, 10, 15, 25];
const RAMP_FAR_STEPS_MI = [50, 100, 124];      // 124 mi ≈ the server's 200 km limit
const MI_M = 1609.344;

async function findNearestRamp(aid, steps, onStep) {
  const onMap = () => { try { return loadedItems('ramps').filter((r) => r.kind === 'ramp' || r.kind === 'marina'); } catch { return []; } };
  for (const mi of steps) {
    onStep?.(mi);
    let res = null;
    try {
      res = await api.get('/api/poi/ramps', { lat: aid.latitude, lon: aid.longitude, radius_m: Math.round(mi * MI_M), fast: 1 }, { timeoutMs: 20000 });
    } catch { /* still check the ramps already on the map */ }
    // Ramps already drawn on the map count too, so the card never says "none" next to a visible ramp.
    const ramps = [...(res?.items || []), ...onMap()].map((r) => ({ ...r, nm: haversineNM(aid.latitude, aid.longitude, r.lat, r.lon) }))
      .filter((r) => r.nm * 1.15078 <= mi + 0.01).sort((a, b) => a.nm - b.nm);
    if (ramps.length) return { ramp: ramps[0], mi };
  }
  return null;
}

function nearestRampTile(aid, onFound) {
  const t = liveTile(SVG.ramp, 'Nearest boat ramp', 'Searching 5 mi…');
  once(`ramp:${aid.objectid}`, async () => {
    const near = await findNearestRamp(aid, RAMP_STEPS_MI, (mi) => t.progress(`Searching ${mi} mi…`));
    if (near) return near;
    toast(`No boat ramps within 25 mi of ${aid.aidname}. Searching farther out…`, 'info', 5000);
    const far = await findNearestRamp(aid, RAMP_FAR_STEPS_MI, (mi) => t.progress(`Searching ${mi} mi…`));
    return far ? { ...far, far: true } : null;
  }).then((found) => {
    if (!found) { liveCache.delete(`ramp:${aid.objectid}`); t.fail(`None within ${RAMP_FAR_STEPS_MI.at(-1)} mi`); return; }
    const r = found.ramp;
    const run = el('span');
    t.done(
      el('a', { href: '#', text: r.name, title: 'Draw the water route to this ramp', onclick: (e) => { e.preventDefault(); drawWaterRoute(aid, r); } }),
      [`${r.nm.toFixed(1)} NM`, found.far ? 'nothing within 25 mi' : null, r.address, r.phone].filter(Boolean).join(' · '),
    );
    t.tile.querySelector('.lt-sub')?.append(run);
    cruiseMph().then((mph) => { run.textContent = ` · about ${runTime(r.nm, mph)} by boat at ${mph} mph (straight line)`; });
    onFound(r);
  }).catch(() => t.fail('Unavailable'));
  return t.tile;
}

/** Latest NWS observation from the nearest station (falls back to the forecast's current period). */
function weatherTile(aid) {
  const t = liveTile(SVG.cloud, 'Weather', 'Checking nearest station…');
  const q = { lat: aid.latitude.toFixed(4), lon: aid.longitude.toFixed(4) };
  once(`obs:${aid.objectid}`, () => api.get('/api/weather/observation', q, { timeoutMs: 12000 })).then(async (o) => {
    if (o?.ok !== false && o?.station) {
      const parts = [o.temp_f != null ? `${Math.round(o.temp_f)}°F` : null, o.conditions,
        o.wind_kt != null ? `${Math.round(o.wind_kt)} kt ${o.wind_dir || ''}`.trim() : null].filter(Boolean);
      t.done(parts.join(' · ') || 'No current reading', `${o.station.name}, ${fmt.mi(o.station.distance_mi)}`, o.observed_at);
      return;
    }
    const f = await api.get('/api/weather', q, { timeoutMs: 12000 });
    const p = f?.periods?.[0];
    if (!p) { t.fail('Unavailable'); return; }
    t.done(`${p.temperature}°${p.temperatureUnit || 'F'} · ${p.shortForecast} · ${p.windSpeed} ${p.windDirection || ''}`.trim(), `${p.name} forecast · ${f.source || 'NWS'}`);
  }).catch(() => t.fail('Unavailable'));
  return t.tile;
}

/** Closest, most recent water temperature (USGS / NOAA / Open-Meteo), with distance when it is far. */
function waterTempTile(aid) {
  const t = liveTile(SVG.temp, 'Water temp', 'Checking nearby gauges…');
  once(`temp:${aid.objectid}`, () => api.get('/api/water/temp', { lat: aid.latitude.toFixed(4), lon: aid.longitude.toFixed(4) }, { timeoutMs: 15000 })).then((d) => {
    const p = d?.primary;
    if (!p) { t.fail('No reading nearby'); return; }
    t.done(`${p.water_temp_f} °F · ${p.water_temp_c} °C`, [`${p.station_name}, ${fmt.mi(p.distance_mi)}`, d.note].filter(Boolean).join(' · '), p.time);
  }).catch(() => t.fail('Unavailable'));
  return t.tile;
}

export async function drawWaterRoute(aid, ramp) {
  layers.route.clearLayers();
  toast('Routing over water…', 'info', 2000);
  let res = null;
  // The web edition has no water-routing backend: always a straight line (the desktop app routes on the water).
  res = { ok: false, note: 'Straight line — the Windows app routes over the water' };
  const pts = res?.ok && res.points?.length > 1 ? res.points : [[aid.latitude, aid.longitude], [ramp.lat, ramp.lon]];
  const direct = !res?.ok || res.method === 'direct';
  L.polyline(pts, { color: '#3ad0e8', weight: 4, opacity: 0.9, dashArray: direct ? '8 8' : null }).addTo(layers.route);
  L.marker([ramp.lat, ramp.lon], { icon: poiIcon(ramp.kind || 'ramp'), title: ramp.name }).bindTooltip(ramp.name, { direction: 'top', offset: [0, -12] }).on('click', () => showPoi(ramp)).addTo(layers.route);
  const nm = res?.distance_nm ?? haversineNM(aid.latitude, aid.longitude, ramp.lat, ramp.lon);
  const mid = pts[Math.floor(pts.length / 2)];
  L.marker(mid, { icon: L.divIcon({ className: '', html: `<div class="measure-label">${nm.toFixed(1)} NM${direct ? ' · straight line' : ' on the water'}</div>`, iconAnchor: [40, 10] }), interactive: false }).addTo(layers.route);
  map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 14 });
  if (direct) toast(res?.note || 'No water geometry here — showing a straight line', 'warn', 5000);
}

export function clearRoute() { layers.route.clearLayers(); }

/** POI (ramp/hotel/park/dam/station) → detail record; enriches missing address/phone once. */
export async function showPoi(poi, extraActions = []) {
  const record = poiRecord(poi, extraActions);
  showDetail(record);
  if (!poi.address || poi.name_source === 'coords') {
    try {
      const res = await api.post('/api/poi/enrich', { items: [poi] });
      const better = res.items?.[0];
      if (better && current && current.id === record.id) { Object.assign(poi, better); showDetail(poiRecord(poi, extraActions)); }
    } catch { /* offline — keep what we have */ }
  }
}

/** A safe link for a place's website tag: http(s) only; "www.x.com" / "x.com" get https://; anything else is dropped. */
function safeUrl(raw) {
  const v = String(raw || '').trim().split(/\s*;\s*/)[0];
  if (!v) return '';
  const url = /^https?:\/\//i.test(v) ? v : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(v) ? `https://${v}` : '';
  try { return url && ['http:', 'https:'].includes(new URL(url).protocol) ? url : ''; } catch { return ''; }
}

export function poiRecord(poi, extraActions = []) {
  const t = poi.tags || {};
  const facts = [];
  if (['ramp', 'marina'].includes(poi.kind)) {
    facts.push(['Surface', t.surface], ['Fee', t.fee], ['Access', t.access], ['Park', t.park], ['Operator', poi.operator], ['Tidal', t.tidal ? 'yes' : '']);
  } else if (['hotel', 'motel', 'resort', 'campground'].includes(poi.kind)) {
    facts.push(['Brand', t.brand || poi.operator], ['Stars', t.stars], ['Rooms', t.rooms], ['Check-in', t.check_in], ['Check-out', t.check_out]);
  } else if (poi.kind === 'park') {
    facts.push(['Boat ramp', t.ramp_name], ['Operator', poi.operator]);
  } else if (poi.kind === 'dam') {
    facts.push(['Operator', poi.operator], ['Office', t.office], ['River', t.waterway || t.river], ['Height', t.height_ft ? `${t.height_ft} ft` : ''],
      ['Built', t.year_completed], ['Purpose', t.purpose], ['Owner', t.owner_type], ['Locks', t.locks], ['NID ID', t.nid_id]);
  } else if (['tide', 'gage', 'current'].includes(poi.kind)) {
    facts.push(['Station ID', poi.id?.split(':').pop()], ['Gage height', t.gage_height_ft != null ? `${t.gage_height_ft} ft` : ''], ['Discharge', t.discharge_cfs != null ? `${fmt.int(t.discharge_cfs)} cfs` : ''], ['Water temp', t.water_temp_f != null ? `${t.water_temp_f} °F` : '']);
  }
  const chips = [];
  if (poi.distance_mi != null) chips.push(['', `${fmt.mi(poi.distance_mi)} away`]);
  if (t.stars) chips.push(['', `${t.stars}★`]);
  if (t.fee) chips.push(['Fee', t.fee]);
  if (t.surface) chips.push(['', t.surface]);
  const photo = ['ramp', 'marina', 'hotel', 'motel', 'resort', 'campground', 'park', 'dam'].includes(poi.kind);
  const hours = t.opening_hours ? (t.opening_hours === '24/7' ? 'Open 24 hours' : `Hours: ${t.opening_hours}`) : '';
  return { id: poi.id, title: poi.name, kind: poi.kind, lat: poi.lat, lon: poi.lon, address: poi.address, phone: poi.phone || t.phone || t['contact:phone'], website: safeUrl(poi.website || t.website || t['contact:website']),
    hours, chips, facts, actions: extraActions, source: poi.source, quality: poi.quality, photo };
}

