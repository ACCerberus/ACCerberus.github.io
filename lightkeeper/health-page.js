/* Data health page: draws ./data/stats.json (written by the places job and the daily health check). */
(async () => {
  const $ = (id) => document.getElementById(id);
  const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '—');
  const pct = (v) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '—');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ago = (iso) => {
    if (!iso) return 'unknown';
    const h = (Date.now() - new Date(iso).getTime()) / 36e5;
    if (h < 1) return 'within the hour';
    if (h < 24) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'} ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  };
  const DISTRICT_ORDER = ['1', '5', '7', '8', '9', '11', '13', '14', '17'];

  let s;
  try {
    s = await fetch('./data/stats.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  } catch {
    $('h-error').hidden = false;
    return;
  }
  const all = s.all || {};
  const q = all.quality || {};

  $('h-stamp').textContent = `Data health · updated ${ago(s.built_at)}`;

  // Headline tiles
  const tiles = [
    [n(s.aids), 'Aids in the Light List', `Refreshed ${ago(s.light_list_built_at)}`],
    [n(all.places), 'Places', `Rebuilt ${ago(s.places_built_at)}`],
    [pct(all.verified_pct), 'Verified', `${n(q.verified)} places`],
    [pct(all.checked_pct), 'Confirmed by a second source', all.checked_pct ? 'Another dataset agrees on the place' : 'Starts as official lists are added'],
  ];
  $('h-tiles').replaceChildren(...tiles.map(([v, k, sub]) => {
    const t = el('div', 'tile'); t.append(el('b', null, v), el('span', null, k), el('small', null, sub)); return t;
  }));

  // Grade bar
  const total = (q.verified || 0) + (q.likely || 0) + (q.unverified || 0);
  const bar = $('h-qbar');
  if (total) {
    for (const [key, cls, label] of [['verified', 'v', 'Verified'], ['likely', 'l', 'Likely'], ['unverified', 'u', 'Thin']]) {
      const share = (q[key] || 0) / total * 100;
      const seg = el('span', cls);
      seg.style.width = `${share}%`;
      seg.title = `${label}: ${n(q[key])} (${Math.round(share)}%)`;
      if (share >= 9) seg.textContent = `${Math.round(share)}%`;
      bar.append(seg);
    }
    bar.setAttribute('aria-label', `Verified ${Math.round(q.verified / total * 100)}%, likely ${Math.round(q.likely / total * 100)}%, thin ${Math.round(q.unverified / total * 100)}%`);
  }

  // Completeness meters
  const meters = [
    ['Has its own name', all.named_pct, 'Named in OpenStreetMap, not a name LightKeeper made up'],
    ['Has an address', all.address_pct, 'All places'],
    ['Has a phone number', all.phone_pct, 'Hotels, motels, resorts and marinas'],
  ];
  $('h-meters').replaceChildren(...meters.map(([k, v, sub]) => {
    const m = el('div', 'meter');
    const head = el('div', 'mh'); head.append(el('b', null, k), el('span', null, pct(v)));
    const track = el('div', 'mt'); const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, v || 0))}%`; track.append(fill);
    m.append(head, track, el('small', null, sub));
    return m;
  }));

  // District table
  const head = el('div', 'drow dhead');
  for (const h of ['District', 'Aids', 'Places', 'Verified', 'Phone', 'Address']) head.append(el('span', null, h));
  const rows = DISTRICT_ORDER.filter((id) => s.districts && s.districts[id]).map((id) => {
    const d = s.districts[id];
    const r = el('div', 'drow');
    const name = el('span', 'dn'); name.append(el('b', null, `D${id}`), document.createTextNode(` ${d.name || ''}`));
    const ver = el('span', 'dv');
    const mini = el('i', 'mini'); const f = el('i'); f.style.width = `${d.verified_pct || 0}%`; mini.append(f);
    ver.append(mini, document.createTextNode(pct(d.verified_pct)));
    r.append(name, el('span', 'num', n(d.aids)), el('span', 'num', n(d.places)), ver, el('span', 'num', pct(d.phone_pct)), el('span', 'num', pct(d.address_pct)));
    return r;
  });
  $('h-districts').replaceChildren(head, ...rows);

  // Source status
  const h = s.health;
  const box = $('h-sources');
  if (!h || !Array.isArray(h.sources)) {
    $('h-health-sub').textContent = 'Every day an automatic check calls each service LightKeeper uses. The first check has not reported here yet.';
    box.replaceChildren();
    return;
  }
  $('h-health-sub').textContent = `Every day an automatic check calls each service LightKeeper uses. Last check ${ago(h.checked_at)}: ${n(h.ok)} of ${n(h.total)} up.`;
  box.replaceChildren(...h.sources.map((src) => {
    const r = el('div', `src${src.ok ? '' : ' down'}`);
    const dot = el('span', `lt ${src.ok ? 'g' : 'r'}`); dot.style.setProperty('--k', src.ok ? 'none' : 'fl');
    r.append(dot, el('b', null, src.name), el('span', null, src.ok ? 'Up' : (src.must_have ? 'Down · needed' : 'Down')));
    return r;
  }));
})();
