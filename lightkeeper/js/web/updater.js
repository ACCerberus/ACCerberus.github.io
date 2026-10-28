/** Website auto-update: every 2 minutes (and whenever the app comes back on screen) ask whether a newer build is
 *  published. If so, wait until the user isn't typing or in a dialog, show "Updating to version …" and reload.
 *  Picked aids, the trip form, district, panel, map view and settings are all kept in this browser, so nothing the
 *  user was doing is lost. */

const CHECK_MS = 2 * 60 * 1000;
const MINE = new URL(import.meta.url).searchParams.get('v') || '';      // this page's build token, e.g. 2.1.1-5
let updating = false;

const pretty = (token) => token.replace(/-(\d+)$/, ' (build $1)');
const busy = () => {
  const a = document.activeElement;
  return !!(a && a.matches?.('input, textarea, select, [contenteditable="true"]')) || !!document.querySelector('.dialog:not([hidden]), dialog[open], .modal:not([hidden])');
};

async function check() {
  if (updating || !MINE || document.hidden || !navigator.onLine) return;
  try {
    const v = await (await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    if (!v?.version || v.version === MINE) return;
    if (busy()) { setTimeout(check, 15000); return; }   // finish typing first
    updating = true;
    document.dispatchEvent(new CustomEvent('lk-before-update', { detail: v.version }));
    const box = document.createElement('div');
    box.id = 'boot-splash';
    box.setAttribute('role', 'status');
    box.innerHTML = '<div class="spin"></div><div></div>';
    box.lastChild.textContent = `Updating to version ${pretty(v.version)}…`;
    document.body.append(box);
    setTimeout(() => location.reload(), 1500);
  } catch { /* offline or the site is busy: try again next time */ }
}

export function initUpdater() {
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
