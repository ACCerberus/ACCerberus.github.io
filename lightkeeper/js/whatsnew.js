/** "What's new" panel: the most recent version and its changes in plain language. */

import { el, fmt, panelSkeleton } from './ui.js';

export async function init(view) {
  const { body } = panelSkeleton(view, "What's new", 'Recent changes and fixes, in plain language.');
  try {
    const entries = await (await fetch(new URL('../changelog.json', import.meta.url))).json();
    const latest = entries[0];
    body.append(
      el('div', { class: 'box' }, [
        el('h4', { text: `Version ${latest.version} · ${fmt.date(latest.date)}` }),
        el('div', { style: 'font-weight:600;margin-bottom:4px', text: latest.title }),
        el('div', { class: 'muted small', text: latest.summary }),
      ]),
      el('ul', { class: 'note-list', style: 'line-height:1.55' }, latest.changes.map((c) => el('li', { text: c }))),
      el('div', { class: 'muted small', text: 'LightKeeper by Evan Isakson · proprietary, all rights reserved.' }),
    );
  } catch {
    body.append(el('div', { class: 'empty' }, [el('b', { text: 'Changelog unavailable' })]));
  }
}
