(async () => {
  const $ = (id) => document.getElementById(id);
  const list = (ul, items) => {
    ul.replaceChildren(...(items && items.length ? items : ['Nothing listed right now.']).map((t) => {
      const li = document.createElement('li'); li.textContent = t; return li;
    }));
  };
  try {
    const log = await fetch('./changelog.json', { cache: 'no-store' }).then((r) => r.json());
    const latest = log[0];
    $('u-eyebrow').textContent = `Version ${latest.version} · ${new Date(latest.date + 'T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
    $('u-title').textContent = latest.title || "What's new";
    $('u-lead').textContent = 'What changed in the newest version, what we know is still rough, and what is coming next.';
    list($('u-changes'), latest.changes);
    list($('u-issues'), latest.known_issues);
    list($('u-todo'), latest.todo);
    const older = $('u-older');
    for (const v of log.slice(1, 8)) {
      const d = document.createElement('details');
      const s = document.createElement('summary');
      s.textContent = `Version ${v.version}${v.title ? ` — ${v.title}` : ''}`;
      const ul = document.createElement('ul');
      list(ul, v.changes);
      d.append(s, ul);
      older.append(d);
    }
    if (!older.children.length) older.textContent = 'This is the first version.';
    // LightKeeper V1: loaded when the dropdown is first opened.
    const v1 = $('u-v1');
    v1.addEventListener('toggle', async () => {
      const box = $('u-v1-list');
      if (!v1.open || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      box.textContent = 'Loading…';
      try {
        const old = await fetch('./changelog_v1.json', { cache: 'no-store' }).then((r) => r.json());
        box.replaceChildren(...old.map((v) => {
          const d = document.createElement('details');
          const s = document.createElement('summary');
          s.textContent = `Version ${v.version.replace(/^v/i, '')}${v.date ? ` — ${v.date}` : ''}`;
          d.append(s);
          for (const g of v.groups) {
            const h = document.createElement('div'); h.className = 'meta'; h.style.marginTop = '8px'; h.textContent = g.title;
            const ul = document.createElement('ul'); list(ul, g.items);
            d.append(h, ul);
          }
          return d;
        }));
      } catch { box.textContent = 'Could not load the V1 history right now.'; }
    });
  } catch {
    $('u-lead').textContent = 'Could not load the change list right now. Please try again in a moment.';
  }
})();
