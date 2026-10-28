/** The one detail card. Everything clickable on the map funnels into showDetail(). */

import { $, el, esc, fmt, ICONS, toast } from './ui.js';
import { flyTo, map } from './map.js';
import { api } from './api.js';

const card = () => $('#detail');
let current = null;
const openListeners = new Set();
export function onDetailOpen(fn) { openListeners.add(fn); }

export function hideDetail() { card().hidden = true; current = null; }

/**
 * record = { title, kind, subtitle, lat, lon, address, phone, website, facts: [[label, value]], actions: [{label, primary, onClick}], source }
 */
export function showDetail(record) {
  current = record;
  const c = card();
  c.innerHTML = '';
  const head = el('div', { class: 'd-head' }, [
    el('div', {}, [
      el('h3', { text: record.title || 'Unnamed' }),
      record.subtitle ? el('div', { class: 'muted small', text: record.subtitle }) : null,
    ]),
    record.kind ? el('span', { class: `badge ${record.kind}`, text: fmt.title(record.kind) }) : null,
    el('button', { class: 'd-close', title: 'Close', onclick: hideDetail, html: '&times;' }),
  ]);
  const body = el('div', { class: 'd-body' });
  if (record.photo) {
    const img = el('img', { class: 'd-photo', src: record.photo, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.remove());
    body.append(img);
  }
  if (record.address) body.append(line(ICONS.pin, record.address));
  if (record.phone) body.append(line(ICONS.phone, el('a', { href: `tel:${record.phone.replace(/[^+\d]/g, '')}`, text: record.phone })));
  if (record.website) body.append(line(ICONS.globe, el('a', { href: record.website, target: '_blank', rel: 'noopener', text: record.website.replace(/^https?:\/\//, '').replace(/\/$/, '') })));
  if (record.lat != null) {
    body.append(line(ICONS.xy, el('span', { text: `${fmt.coord(record.lat, record.lon)}  ·  ${fmt.dms(record.lat, record.lon)}`, title: 'Click to copy', style: 'cursor:copy', onclick: () => copy(fmt.coord(record.lat, record.lon)) })));
  }
  const facts = (record.facts || []).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (facts.length) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of facts) {
      const dd = el('dd');
      const rich = !!(v && (v.nodeType || (typeof v === 'object' && 'html' in v)));
      if (v && v.nodeType) dd.append(v);
      else if (rich) dd.innerHTML = v.html;
      else dd.textContent = String(v);
      const dt = el('dt', { text: k });
      if (rich) { dt.classList.add('wide'); dd.classList.add('wide'); if (!k) dt.hidden = true; }
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
  if (record.source) body.append(el('div', { class: 'd-src', text: `Source: ${record.source}` }));
  c.append(head, body);
  c.hidden = false;
  openListeners.forEach((fn) => fn(record));
}

function line(icon, content) { return el('div', { class: 'd-line', html: icon }, [content]); }

function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied coordinates', 'ok')).catch(() => {}); }

export function currentDetail() { return current; }

/* ── Record builders ── */

export function aidRecord(aid, extraActions = []) {
  const facts = [
    ['Light List #', aid.lightlistnumber],
    ['Characteristic', aid.characteristics],
    ['Structure', aid.structure],
    ['Height', aid.aidheight ? `${aid.aidheight} ft` : ''],
    ['Range', aid.aidrange ? `${aid.aidrange} NM` : ''],
    ['Focal plane', aid.focal_plane],
    ['Color', aid.color],
    ['Sound signal', aid.sound_signal],
    ['Daymark', aid.daymark_shape],
    ['Waterway', aid.waterway],
    ['State', aid.state],
    ['CG sector', aid.cg_sector],
    ['Intl LL#', aid.intl_llnr],
    ['Remarks', [aid.structure_remark, aid.remark].filter(Boolean).join(' ')],
    ['District', aid.district_id ? `D${aid.district_id}` : ''],
  ];
  return { title: aid.aidname, kind: aid.aid_type, subtitle: aid.lightlistnumber ? `LL# ${aid.lightlistnumber}` : '', lat: aid.latitude, lon: aid.longitude, facts, actions: extraActions, source: 'USCG Light List (NAVCEN)' };
}

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

export function poiRecord(poi, extraActions = []) {
  const t = poi.tags || {};
  const facts = [];
  if (['ramp', 'marina'].includes(poi.kind)) {
    facts.push(['Surface', t.surface], ['Fee', t.fee], ['Access', t.access], ['Park', t.park], ['Operator', poi.operator], ['Tidal', t.tidal ? 'yes' : '']);
  } else if (['hotel', 'motel', 'resort', 'campground'].includes(poi.kind)) {
    facts.push(['Brand', t.brand || poi.operator], ['Stars', t.stars], ['Rooms', t.rooms]);
  } else if (poi.kind === 'park') {
    facts.push(['Boat ramp', t.ramp_name], ['Operator', poi.operator]);
  } else if (poi.kind === 'dam') {
    facts.push(['Operator', poi.operator], ['Office', t.office], ['River', t.waterway]);
  } else if (['tide', 'gage', 'current'].includes(poi.kind)) {
    facts.push(['Station ID', poi.id?.split(':').pop()], ['Gage height', t.gage_height_ft != null ? `${t.gage_height_ft} ft` : ''], ['Discharge', t.discharge_cfs != null ? `${fmt.int(t.discharge_cfs)} cfs` : ''], ['Water temp', t.water_temp_f != null ? `${t.water_temp_f} °F` : '']);
  }
  if (poi.quality) facts.push(['Data quality', poi.quality]);
  if (poi.distance_mi != null) facts.push(['Distance', fmt.mi(poi.distance_mi)]);
  const photo = null; // place photos are looked up by the desktop app's backend
  return { id: poi.id, title: poi.name, kind: poi.kind, lat: poi.lat, lon: poi.lon, address: poi.address, phone: poi.phone, website: poi.website, facts, actions: extraActions, source: poi.source, photo };
}

