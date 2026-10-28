/** "What's new" panel: the most recent version and its changes in plain language. */

import { el, fmt, panelSkeleton } from './ui.js?v=2.1.0-4';

export async function init(view) {
  const { body } = panelSkeleton(view, "What's new", 'Recent changes and fixes, in plain language.');
  try {
    const entries = await (await fetch(new URL('../changelog.json', import.meta.url), { cache: 'no-cache' })).json();
    const latest = entries[0];
    body.append(
      el('div', { class: 'box' }, [
        el('h4', { text: `Version ${latest.version} · ${fmt.date(latest.date)}` }),
        el('div', { style: 'font-weight:600;margin-bottom:4px', text: latest.title }),
        el('div', { class: 'muted small', text: latest.summary }),
      ]),
      latest.known_issues?.length ? el('details', { class: 'box known-issues' }, [
        el('summary', { text: `Known issues (${latest.known_issues.length})` }),
        el('ul', { class: 'note-list', style: 'line-height:1.55;margin-top:6px' }, latest.known_issues.map((c) => el('li', { text: c }))),
      ]) : null,
      latest.todo?.length ? el('details', { class: 'box todo-list' }, [
        el('summary', { text: `To do (${latest.todo.length})` }),
        el('ul', { class: 'note-list', style: 'line-height:1.55;margin-top:6px' }, latest.todo.map((c) => el('li', { text: c }))),
      ]) : null,
      el('ul', { class: 'note-list', style: 'line-height:1.55' }, latest.changes.map((c) => el('li', { text: c }))),
      v1History(),
      el('div', { class: 'muted small', text: 'LightKeeper by Evan Isakson · proprietary, all rights reserved.' }),
    );
  } catch {
    body.append(el('div', { class: 'empty' }, [el('b', { text: 'Changelog unavailable' })]));
  }
}

/** "LightKeeper V1" dropdown: every update to the original app, loaded the first time it is opened. */
function v1History() {
  const list = el('div');
  const box = el('details', { class: 'box v1-history' }, [el('summary', { text: 'LightKeeper V1 (original app, Oct 2025 – Apr 2026)' }), list]);
  box.addEventListener('toggle', async () => {
    if (!box.open || list.dataset.loaded) return;
    list.dataset.loaded = '1';
    list.textContent = 'Loading…';
    try {
      const old = await (await fetch(new URL('../changelog_v1.json', import.meta.url), { cache: 'no-cache' })).json();
      list.replaceChildren(...old.map((v) => el('details', { style: 'margin-top:6px' }, [
        el('summary', { text: `Version ${v.version.replace(/^v/i, '')}${v.date ? ` · ${v.date}` : ''}` }),
        ...v.groups.flatMap((g) => [
          el('div', { class: 'muted small', style: 'margin-top:6px;font-weight:600', text: g.title }),
          el('ul', { class: 'note-list', style: 'line-height:1.55;margin-top:2px' }, g.items.map((c) => el('li', { text: c }))),
        ]),
      ])));
    } catch { list.textContent = 'V1 history unavailable'; }
  });
  return box;
}
