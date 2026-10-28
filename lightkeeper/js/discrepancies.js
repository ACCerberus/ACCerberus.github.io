/** Discrepancy tracker: aids reported extinguished, off station, damaged... with the LNM/BNM that broadcast them.
 *  Desktop: stored in the app database; Excel export opens in Excel; Email opens a draft with the sheet attached.
 *  Web/phone: stored in this browser; Excel downloads; Email shares the sheet to the phone's Mail app. */

import { api } from './api.js?v=2.1.2-2';
import { el, toast, panelSkeleton, onPanelChange, showPanel, debounce } from './ui.js?v=2.1.2-2';

const TYPES = ['Extinguished', 'Improper characteristic', 'Off station', 'Missing', 'Overgrown', 'Vandalized', 'Damaged', 'Other'];
// The tracker is built but hidden from users until it's ready: set to true to show the rail button,
// the aid card's "Log discrepancy" button, the D shortcut and the Settings section.
export const ENABLED = false;

const state = { items: [], filter: 'open', listEl: null, countEl: null, filterEls: {}, view: 'log', bnm: [], bnmAll: false, bnmEl: null, bnmMsg: '', viewEls: {}, logBox: null };
const BNM_DISTRICT = 13;      // Northwest first; other districts are on the To do list
const changeListeners = new Set();
export const onChange = (fn) => changeListeners.add(fn);
// Today in local time (toISOString would give tomorrow's date in the evening, US time).
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const openCount = () => state.items.filter((i) => i.status === 'open').length;

export function init(view) {
  const { body } = panelSkeleton(view, 'Discrepancies', 'Aids reported extinguished, off station or damaged, with the LNM/BNM that broadcast them.');
  const fileInput = el('input', { type: 'file', accept: '.xlsx', hidden: true, onchange: (e) => importFile(e.target.files[0]) });
  const tools = el('div', { class: 'row disc-tools' }, [
    el('button', { class: 'btn primary', text: '+ New', onclick: () => openForm() }),
    el('button', { class: 'btn', text: 'Export Excel', onclick: exportXlsx }),
    el('button', { class: 'btn', text: 'Email', onclick: emailXlsx }),
    el('button', { class: 'btn', text: 'Import', title: 'Load an edited spreadsheet (replaces this list)', onclick: () => fileInput.click() }),
  ]);
  const pills = el('div', { class: 'pills' }, ['open', 'corrected', 'all'].map((f) => {
    const b = el('button', { class: `pill${f === state.filter ? ' on' : ''}`, onclick: () => { state.filter = f; render(); } });
    state.filterEls[f] = b;
    return b;
  }));
  state.listEl = el('div', { class: 'list disc-list' });
  const views = el('div', { class: 'seg disc-views' }, [['log', 'My log'], ['bnm', 'BNMs · D13']].map(([v, label]) => {
    const b = el('button', { class: v === state.view ? 'on' : '', text: label, onclick: () => setView(v) });
    state.viewEls[v] = b;
    return b;
  }));
  state.logBox = el('div', {}, [tools, pills, state.listEl]);
  state.bnmEl = el('div', { class: 'list disc-bnm', hidden: true });
  body.append(views, state.logBox, state.bnmEl, fileInput);
  onPanelChange((name) => { if (name === 'discrep') { load(); loadBnm(); } });   // notices also flag cancelled log entries
  load();
}

function setView(v) {
  state.view = v;
  for (const [k, b] of Object.entries(state.viewEls)) b.classList.toggle('on', k === v);
  state.logBox.hidden = v !== 'log';
  state.bnmEl.hidden = v !== 'bnm';
  if (v === 'bnm') loadBnm();
}

/* ── Broadcast Notices to Mariners (Northwest) ── */
async function loadBnm(refresh = false) {
  if (!state.bnm.length) { state.bnmEl.innerHTML = ''; state.bnmEl.append(el('div', { class: 'empty loading-dots', text: 'Loading broadcast notices' })); }
  try {
    const res = await api.get('/api/bnm', { district: BNM_DISTRICT, ...(refresh ? { refresh: 1 } : {}) }, { timeoutMs: 30000 });
    state.bnm = res.items || [];
    state.bnmMsg = res.ok === false ? res.error : (res.fetched_at ? `Updated ${new Date(res.fetched_at).toLocaleString()}` : '');
  } catch (err) { state.bnmMsg = `Could not load broadcast notices: ${err.message}`; }
  renderBnm();
  render();
}

const cancelledBnms = () => new Map(state.bnm.filter((b) => b.category === 'CANCELLATION' && b.cancels).map((b) => [b.cancels, b]));

function renderBnm() {
  const el0 = state.bnmEl;
  el0.innerHTML = '';
  const logged = new Set(state.items.map((i) => i.lnm).filter(Boolean));
  const openByLnm = new Map(state.items.filter((i) => i.status === 'open' && i.lnm).map((i) => [i.lnm, i]));
  const shown = state.bnm.filter((b) => state.bnmAll || b.active || (b.category === 'CANCELLATION' && openByLnm.has(b.cancels)));
  el0.append(el('div', { class: 'row disc-bnm-head' }, [
    el('span', { class: 'muted small', text: `Northwest (D13) · ${state.bnm.filter((b) => b.active).length} active · ${state.bnmMsg}` }),
    el('label', { class: 'switch small' }, [el('input', { type: 'checkbox', checked: state.bnmAll, onchange: (e) => { state.bnmAll = e.target.checked; renderBnm(); } }), el('span', { text: 'Show all recent' })]),
    el('button', { class: 'btn sm', text: 'Refresh', onclick: () => loadBnm(true) }),
  ]));
  if (!shown.length) { el0.append(el('div', { class: 'empty' }, [el('b', { text: 'No active aid notices' }), 'Tick "Show all recent" to see cancelled and older ones.'])); return; }
  for (const b of shown) {
    const isCancel = b.category === 'CANCELLATION';
    const match = isCancel ? openByLnm.get(b.cancels) : null;
    const label = isCancel ? 'Cancellation' : b.active ? 'Active' : b.category === 'SCHEDULED' ? 'Scheduled' : 'Ended';
    el0.append(el('div', { class: `item disc-bnm-item ${b.active ? 'active' : ''}` }, [
      el('div', { class: 'main' }, [
        el('div', { class: 'title' }, [el('span', { class: `badge ${b.active ? 'warn' : isCancel ? 'ok' : ''}`, text: label }), ` ${b.id}`]),
        el('div', { class: 'sub', text: [b.area, b.dtg, b.discrepancy].filter(Boolean).join(' · ') }),
        el('div', { class: 'bnm-text', text: b.text }),
        b.llnrs.length ? el('div', { class: 'sub', text: `LLNR ${b.llnrs.join(', ')}` }) : null,
      ]),
      el('div', { class: 'disc-bnm-actions' }, [
        !isCancel && !logged.has(b.id) ? el('button', { class: 'btn sm primary', text: 'Add to log', onclick: () => addFromBnm(b) }) : null,
        !isCancel && logged.has(b.id) ? el('span', { class: 'muted small', text: 'In your log' }) : null,
        match ? el('button', { class: 'btn sm', text: 'Mark corrected', title: `Close ${match.aidname} in your log`, onclick: () => markCorrected(match, b) }) : null,
      ]),
    ]));
  }
}

async function addFromBnm(b) {
  let aid = null;
  if (b.llnrs.length) {
    try {
      const found = (await api.get('/api/aids', { q: b.llnrs[0], districts: BNM_DISTRICT, limit: 10 })).aids || [];
      aid = found.find((a) => String(a.lightlistnumber) === b.llnrs[0]) || null;
    } catch { aid = null; }
  }
  const published = b.published ? new Date(b.published) : new Date();
  setView('log');
  openForm({
    aidname: aid?.aidname || b.aid_hint || '', lightlistnumber: aid?.lightlistnumber || b.llnrs[0] || '', district_id: BNM_DISTRICT,
    objectid: aid?.objectid || null, discrepancy: b.discrepancy, details: b.text, message_time: b.dtg, lnm: b.id, reported_on: localDate(published),
  });
}

async function markCorrected(entry, cancel) {
  const note = `Cancelled by ${cancel.id}${cancel.dtg ? ` (${cancel.dtg})` : ''}.`;
  await api.post('/api/discrepancies', { ...entry, status: 'corrected', notes: [entry.notes, note].filter(Boolean).join(' ') });
  toast(`${entry.aidname} marked corrected`, 'ok');
  load();
}

export async function load() {
  try {
    const res = await api.get('/api/discrepancies');
    state.items = res.items || [];
  } catch (err) { toast(`Discrepancies: ${err.message}`, 'warn'); }
  render();
  changeListeners.forEach((fn) => fn(openCount()));
}

function render() {
  const counts = { open: 0, corrected: 0, all: state.items.length };
  for (const i of state.items) counts[i.status] = (counts[i.status] || 0) + 1;
  for (const [f, b] of Object.entries(state.filterEls)) {
    b.classList.toggle('on', f === state.filter);
    b.textContent = `${f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Corrected'} (${counts[f] || 0})`;
  }
  if (!state.listEl) return;
  const shown = state.items.filter((i) => state.filter === 'all' || i.status === state.filter);
  state.listEl.innerHTML = '';
  if (!shown.length) {
    state.listEl.append(el('div', { class: 'empty' }, [el('b', { text: state.items.length ? 'Nothing in this list' : 'No discrepancies logged' }),
      'Use + New, or "Log discrepancy" on any aid card.']));
    return;
  }
  for (const it of shown) {
    state.listEl.append(el('div', { class: `item disc-item ${it.status}` }, [
      el('div', { class: 'main', onclick: () => openForm(it) }, [
        el('div', { class: 'title', text: it.aidname }),
        el('div', { class: 'sub', text: [it.llnr ? `LLNR ${it.llnr}` : '', it.discrepancy, it.reported_on].filter(Boolean).join(' · ') }),
        it.lnm || it.message_time ? el('div', { class: 'sub', text: [it.lnm, it.message_time ? `msg ${it.message_time}` : ''].filter(Boolean).join(' · ') }) : null,
      ]),
      it.status === 'open' && cancelledBnms().has(it.lnm)
        ? el('button', { class: 'btn sm', text: 'BNM cancelled · mark corrected', onclick: () => markCorrected(it, cancelledBnms().get(it.lnm)) })
        : el('span', { class: `badge ${it.status === 'open' ? 'warn' : 'ok'}`, text: it.status === 'open' ? 'Open' : 'Corrected' }),
      el('button', { class: 'btn sm icon', title: 'Delete', 'aria-label': `Delete ${it.aidname}`, text: '✕', onclick: () => remove(it) }),
    ]));
  }
}

async function remove(it) {
  if (!confirm(`Delete the discrepancy for ${it.aidname}?`)) return;
  await api.del(`/api/discrepancies/${it.id}`);
  toast('Discrepancy deleted', 'ok');
  load();
}

/** New or edit form. `prefill` may be an aid ({aidname, lightlistnumber, district_id, objectid}) or a saved entry. */
export function openForm(prefill = {}) {
  const entry = prefill.id ? prefill : {
    aidname: prefill.aidname || '', llnr: prefill.lightlistnumber || prefill.llnr || '', district_id: prefill.district_id || '',
    aid_objectid: prefill.objectid || null, discrepancy: prefill.discrepancy || '', details: prefill.details || '',
    reported_on: prefill.reported_on || localDate(), message_time: prefill.message_time || '', lnm: prefill.lnm || '', status: 'open', notes: '',
  };
  const field = (label, input) => el('label', { class: 'field disc-field' }, [el('span', { text: label }), input]);
  const name = el('input', { type: 'text', value: entry.aidname, list: 'disc-aids', placeholder: 'Search by light name or LLNR', autocomplete: 'off' });
  const suggestions = el('datalist', { id: 'disc-aids' });
  const llnr = el('input', { type: 'text', value: entry.llnr, placeholder: 'e.g. 13055' });
  const kind = el('select', {}, ['', ...TYPES].map((t) => el('option', { value: t, text: t || 'Choose…', selected: t === entry.discrepancy })));
  if (entry.discrepancy && !TYPES.includes(entry.discrepancy)) kind.append(el('option', { value: entry.discrepancy, text: entry.discrepancy, selected: true }));
  const details = el('textarea', { rows: 2, placeholder: 'What was seen or reported' }, []);
  details.value = entry.details || '';
  const reported = el('input', { type: 'date', value: entry.reported_on || '' });
  const msgTime = el('input', { type: 'text', value: entry.message_time, placeholder: 'e.g. 271530Z OCT 26' });
  const lnm = el('input', { type: 'text', value: entry.lnm, placeholder: 'e.g. BNM 0123-26 or LNM 43/26' });
  const status = el('select', {}, [el('option', { value: 'open', text: 'Open', selected: entry.status !== 'corrected' }),
    el('option', { value: 'corrected', text: 'Corrected', selected: entry.status === 'corrected' })]);
  const notes = el('textarea', { rows: 2, placeholder: 'Notes' });
  notes.value = entry.notes || '';
  let picked = { aid_objectid: entry.aid_objectid, district_id: entry.district_id };
  let found = [];
  name.addEventListener('input', debounce(async () => {
    const q = name.value.trim();
    const exact = found.find((a) => a.aidname === q);
    if (exact) { llnr.value = exact.lightlistnumber || ''; picked = { aid_objectid: exact.objectid, district_id: exact.district_id }; return; }
    if (q.length < 2) return;
    // Light List numbers repeat between districts, so search the picked district when there is one.
    const district = document.getElementById('district-select')?.value || '';
    try { found = (await api.get('/api/aids', { q, limit: 12, ...(district ? { districts: district } : {}) })).aids || []; } catch { found = []; }
    suggestions.replaceChildren(...found.map((a) => el('option', { value: a.aidname, text: [a.lightlistnumber ? `LLNR ${a.lightlistnumber}` : '', a.district_id ? `D${a.district_id}` : ''].filter(Boolean).join(' · ') })));
    // A full name, or an LLNR typed into the name box, fills the rest straight away when only one aid matches.
    const byName = found.filter((a) => a.aidname.toLowerCase() === q.toLowerCase());
    const byLl = found.filter((a) => String(a.lightlistnumber) === q);
    const hit = byName.length === 1 ? byName[0] : byLl.length === 1 ? byLl[0] : null;
    if (hit) { name.value = hit.aidname; llnr.value = hit.lightlistnumber || ''; picked = { aid_objectid: hit.objectid, district_id: hit.district_id }; }
  }, 200));

  const close = () => overlay.remove();
  const save = async () => {
    const body = { id: entry.id, aidname: name.value.trim(), llnr: llnr.value.trim(), discrepancy: kind.value, details: details.value.trim(),
      reported_on: reported.value, message_time: msgTime.value.trim(), lnm: lnm.value.trim(), status: status.value, notes: notes.value.trim(), ...picked };
    if (!body.aidname) { toast('Enter the light or aid name', 'warn'); name.focus(); return; }
    try {
      await api.post('/api/discrepancies', body);
      toast(entry.id ? 'Discrepancy updated' : 'Discrepancy logged', 'ok');
      close();
      load();
    } catch (err) { toast(`Could not save: ${err.message}`, 'err'); }
  };
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } }, [
    el('div', { class: 'modal disc-modal', role: 'dialog', 'aria-label': 'Discrepancy' }, [
      el('div', { class: 'disc-head' }, [el('h3', { text: entry.id ? 'Edit discrepancy' : 'Log discrepancy' }),
        el('button', { class: 'btn sm icon', 'aria-label': 'Close', text: '✕', onclick: close })]),
      el('div', { class: 'disc-grid' }, [
        field('Light / aid name', name), suggestions, field('LLNR', llnr), field('Discrepancy', kind), field('Status', status),
        field('Date reported', reported), field('Original message time', msgTime), field('LNM / BNM broadcast', lnm),
        el('div', { class: 'disc-wide' }, [field('Details', details)]), el('div', { class: 'disc-wide' }, [field('Notes', notes)]),
      ]),
      el('div', { class: 'row', style: 'justify-content:flex-end;gap:8px;margin-top:12px' }, [
        entry.id ? el('button', { class: 'btn', text: 'Delete', style: 'margin-right:auto', onclick: async () => { close(); await remove(entry); } }) : null,
        el('button', { class: 'btn', text: 'Cancel', onclick: close }),
        el('button', { class: 'btn primary', text: 'Save', onclick: save }),
      ]),
    ]),
  ]);
  document.body.append(overlay);
  (entry.aidname ? kind : name).focus();
}

/** From an aid card: open the tracker with this aid filled in. */
export function logForAid(aid) {
  showPanel('discrep');
  openForm(aid);
}

async function exportXlsx() {
  try {
    const res = await api.post('/api/discrepancies/export', {});
    toast(res.path ? `Saved and opened ${res.path.split(/[\\/]/).pop()}` : `Downloaded ${res.filename || 'the spreadsheet'}`, 'ok', 5000);
  } catch (err) { toast(`Export failed: ${err.message}`, 'err'); }
}

async function emailXlsx() {
  try {
    const res = await api.post('/api/discrepancies/email', {});
    if (res.draft) toast('Email draft opened with the spreadsheet attached', 'ok', 5000);
    else if (res.shared) toast('Shared', 'ok');
    else if (res.cancelled) toast('Sharing cancelled', 'info');
    else toast('Spreadsheet downloaded; attach it to the email that opened', 'info', 6000);
  } catch (err) { toast(`Email failed: ${err.message}`, 'err'); }
}

async function importFile(file) {
  if (!file) return;
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  if (!confirm(`Replace your ${state.items.length} discrepancies with the rows in ${file.name}?`)) return;
  try {
    const res = await api.post('/api/discrepancies/import', { data_b64: btoa(bin) });
    toast(`Imported ${res.count} discrepancies`, 'ok');
    load();
  } catch (err) { toast(`Import failed: ${err.message}`, 'err'); }
}
