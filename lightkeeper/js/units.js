/** USCG district / sector contact cards, from lightkeeper/data/uscg_units.json. */

import { el, dialog, ICONS } from './ui.js?v=2.1.1-3';

let data = null;

async function load() {
  if (data) return data;
  try { data = await (await fetch(new URL('../data/uscg_units.json', import.meta.url))).json(); } catch { data = { districts: [], sectors: [] }; }
  return data;
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function districtInfo(id) { return (await load()).districts.find((d) => Number(d.id) === Number(id)) || null; }
export async function sectorInfo(code) {
  const units = await load();
  const key = norm(code);
  return units.sectors.find((s) => norm(s.code) === key) || units.sectors.find((s) => key && norm(s.name).includes(key.replace(/^CGSECTOR/, ''))) || null;
}

function contactCard(title, u) {
  const rows = [];
  const line = (icon, node) => el('div', { class: 'd-line', html: icon }, [node]);
  if (u.command_center_phone) rows.push(line(ICONS.phone, el('span', {}, ['24-hour command center: ', el('a', { href: `tel:${u.command_center_phone.replace(/[^+\d]/g, '')}`, text: u.command_center_phone })])));
  if (u.phone && u.phone !== u.command_center_phone) rows.push(line(ICONS.phone, el('span', {}, ['Office: ', el('a', { href: `tel:${u.phone.replace(/[^+\d]/g, '')}`, text: u.phone })])));
  if (u.address) rows.push(line(ICONS.pin, el('span', { text: u.address })));
  if (u.website) rows.push(line(ICONS.globe, el('a', { href: u.website, target: '_blank', rel: 'noopener', text: u.website.replace(/^https?:\/\//, '') })));
  if (u.lnm_url) rows.push(line(ICONS.info, el('a', { href: u.lnm_url, target: '_blank', rel: 'noopener', text: 'Local Notice to Mariners' })));
  if (!rows.length) rows.push(el('p', { class: 'muted', text: 'No contact details on file yet.' }));
  dialog(title, [el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, rows)], { okText: 'Close' });
}

export async function showDistrict(id) {
  const d = await districtInfo(id);
  contactCard(d ? `${d.name} (${d.former || `District ${id}`})` : `District ${id}`, d || {});
}

export async function showSector(code) {
  const s = await sectorInfo(code);
  contactCard(s ? s.name : code, s || {});
}
