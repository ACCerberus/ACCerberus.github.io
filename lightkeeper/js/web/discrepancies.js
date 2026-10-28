/** Web edition of the discrepancy tracker: entries live in this browser (localStorage); the spreadsheet is built
 *  in the page with SheetJS (vendor/xlsx.full.min.js, loaded on first use). Same answers as the desktop endpoints:
 *    GET list, POST save, DELETE, POST export (download), POST email (share sheet to Mail, or download + mailto),
 *    POST import {data_b64} (replace the list with an edited spreadsheet). */

const LS = 'lk2.web.discrepancies';
const STATUSES = ['open', 'corrected'];
export const TYPES = ['Extinguished', 'Improper characteristic', 'Off station', 'Missing', 'Overgrown', 'Vandalized', 'Damaged', 'Other'];
const COLUMNS = [
  ['ID', 'id', 7], ['Light / aid name', 'aidname', 34], ['LLNR', 'llnr', 10], ['District', 'district_id', 9],
  ['Discrepancy', 'discrepancy', 24], ['Details', 'details', 36], ['Date reported', 'reported_on', 14],
  ['Original message time', 'message_time', 22], ['LNM / BNM broadcast', 'lnm', 22], ['Status', 'status', 11],
  ['Notes', 'notes', 36], ['Last updated', 'updated_at', 20],
];
const FIELDS = ['aid_objectid', 'aidname', 'llnr', 'district_id', 'discrepancy', 'details', 'reported_on', 'message_time', 'lnm', 'status', 'notes'];

const read = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch { return []; } };
const write = (items) => { try { localStorage.setItem(LS, JSON.stringify(items)); } catch { /* storage full or blocked */ } };
const now = () => new Date().toISOString().slice(0, 19);

function clean(body) {
  const rec = {};
  for (const f of FIELDS) {
    const v = body[f];
    if (f === 'aid_objectid' || f === 'district_id') rec[f] = v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v);
    else rec[f] = String(v ?? '').trim();
  }
  rec.status = STATUSES.includes(rec.status.toLowerCase()) ? rec.status.toLowerCase() : 'open';
  return rec;
}

function sorted(items) {
  return items.slice().sort((a, b) => (a.status === 'corrected') - (b.status === 'corrected')
    || String(b.reported_on || b.created_at).localeCompare(String(a.reported_on || a.created_at)) || b.id - a.id);
}

export function list(params = {}) {
  preload();             // get the spreadsheet library ready, so Email can share straight from the tap
  let items = read();
  if (STATUSES.includes(params.status)) items = items.filter((i) => i.status === params.status);
  if (params.district) items = items.filter((i) => String(i.district_id) === String(params.district));
  return { ok: true, items: sorted(items), types: TYPES };
}

export function save(body) {
  const rec = clean(body || {});
  if (!rec.aidname) throw new Error('Light / aid name is required');
  const items = read();
  const id = Number(body.id) || 0;
  const existing = items.find((i) => i.id === id);
  if (existing) Object.assign(existing, rec, { updated_at: now() });
  else items.push({ ...rec, id: Math.max(0, ...items.map((i) => i.id)) + 1, created_at: now(), updated_at: now() });
  write(items);
  return { ok: true, id: existing ? id : items[items.length - 1].id };
}

export function remove(id) {
  const items = read();
  write(items.filter((i) => i.id !== Number(id)));
  return { ok: items.some((i) => i.id === Number(id)) };
}

/* ── Spreadsheet ── */
let sheetJs = null;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJs) {
    sheetJs = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/xlsx.full.min.js', import.meta.url).href;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => { sheetJs = null; reject(new Error('Could not load the spreadsheet library')); };
      document.head.append(s);
    });
  }
  return sheetJs;
}
export const preload = () => loadSheetJs().catch(() => {});

async function buildFile() {
  const X = await loadSheetJs();
  const items = sorted(read());
  const rows = [COLUMNS.map((c) => c[0]), ...items.map((it) => COLUMNS.map(([, f]) => it[f] ?? ''))];
  const ws = X.utils.aoa_to_sheet(rows);
  ws['!cols'] = COLUMNS.map(([, , w]) => ({ wch: w }));
  ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 1), c: COLUMNS.length - 1 } }) };
  const help = X.utils.aoa_to_sheet([
    ['Add a row for a new discrepancy (leave ID blank). Delete a row to remove it.'],
    ['Status is open or corrected. Then import this file in LightKeeper: Discrepancies > Import.'],
    ['Importing replaces the list in the app with the rows in this sheet.'],
  ]);
  help['!cols'] = [{ wch: 100 }];
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, 'Discrepancies');
  X.utils.book_append_sheet(wb, help, 'How to edit');
  const d = new Date();
  const name = `LightKeeper discrepancies ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.xlsx`;
  const bytes = X.write(wb, { bookType: 'xlsx', type: 'array' });
  return { file: new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), items };
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function exportXlsx() {
  const { file } = await buildFile();
  download(file);
  return { ok: true, filename: file.name };
}

/** Phones: the share sheet (pick Mail, it attaches the spreadsheet). Elsewhere: download it and open a mail draft. */
export async function email(to = '') {
  const { file, items } = await buildFile();
  const open = items.filter((i) => i.status === 'open').length;
  const subject = `LightKeeper discrepancies (${open} open)`;
  const text = items.map((i) => `${i.aidname} (LLNR ${i.llnr || '-'}): ${i.discrepancy || '-'}${i.lnm ? ` - ${i.lnm}` : ''} [${i.status}]`).join('\n') || '(none)';
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: subject, text: `${subject}\n\n${text}` });
      return { ok: true, shared: true };
    } catch (err) {
      if (err?.name === 'AbortError') return { ok: true, cancelled: true };
    }
  }
  download(file);
  location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`Spreadsheet downloaded as ${file.name}; attach it to this email.\n\n${text}`)}`;
  return { ok: true, downloaded: true, filename: file.name };
}

export async function importXlsx(b64) {
  const X = await loadSheetJs();
  const wb = X.read(b64, { type: 'base64', cellDates: true });
  const ws = wb.Sheets.Discrepancies || wb.Sheets[wb.SheetNames[0]];
  const rows = X.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const header = (rows.shift() || []).map((h) => String(h).trim().toLowerCase());
  const byHeader = Object.fromEntries(COLUMNS.map(([h, f]) => [h.toLowerCase(), f]));
  const fields = header.map((h) => byHeader[h]);
  if (!fields.includes('aidname')) throw new Error('This file has no "Light / aid name" column; export from LightKeeper first and edit that file');
  const pad = (n) => String(n).padStart(2, '0');
  const items = [];
  let nextId = 1;
  const used = new Set();
  for (const values of rows) {
    const rec = {};
    fields.forEach((f, i) => {
      if (!f) return;
      let v = values[i];
      if (v instanceof Date) v = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}${v.getHours() || v.getMinutes() ? ` ${pad(v.getHours())}:${pad(v.getMinutes())}` : ''}`;
      rec[f] = v;
    });
    if (!String(rec.aidname || '').trim()) continue;
    const c = clean(rec);
    let id = Number(rec.id) || 0;
    if (!id || used.has(id)) { while (used.has(nextId) || rows.some((r) => Number(r[fields.indexOf('id')]) === nextId)) nextId += 1; id = nextId; }
    used.add(id);
    items.push({ ...c, id, created_at: now(), updated_at: now() });
  }
  write(items);
  return { ok: true, count: items.length };
}
