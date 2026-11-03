/* Home page data line: aids, Light List freshness and the share of places confirmed by two sources, from the stats file
   the data jobs write. Hidden until it loads, so the page never shows a broken line. */
(async () => {
  const box = document.getElementById('lk-stats');
  if (!box) return;
  try {
    const s = await fetch('/lightkeeper/data/stats.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    const h = (Date.now() - new Date(s.light_list_built_at).getTime()) / 36e5;
    const fresh = !Number.isFinite(h) ? null : h < 24 ? 'refreshed today' : `refreshed ${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? '' : 's'} ago`;
    const parts = [`${s.aids.toLocaleString()} aids`];
    if (fresh) parts.push(`Light List ${fresh}`);
    const all = s.all || {};
    if (typeof all.checked_pct === 'number' && all.checked_pct > 0) parts.push(`${Math.round(all.checked_pct)}% of places confirmed by two sources`);
    else if (typeof all.verified_pct === 'number') parts.push(`${Math.round(all.verified_pct)}% of places verified`);
    const dot = document.createElement('span'); dot.className = 'lt g'; dot.setAttribute('aria-hidden', 'true');
    box.replaceChildren(dot, document.createTextNode(`${parts.join(' · ')} · `), Object.assign(document.createElement('b'), { textContent: 'Data health →' }));
    box.hidden = false;
  } catch { /* no line if the stats file is not reachable */ }
})();
