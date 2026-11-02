/* Home-screen app safety net: if startup hasn't finished in 12 s (a stalled download, or iPhone resuming a page it
   dropped from memory), reload once. Never more than once a minute, so it can't loop; if it still hasn't started,
   say so on the loading screen instead of spinning forever. */
function lkStuck() {
  const s = document.getElementById('boot-splash');
  if (!s || window.lkBooted || s.dataset.stuck) return;
  s.dataset.stuck = '1';
  const off = !navigator.onLine;
  s.innerHTML = '<div style="max-width:300px;text-align:center;line-height:1.45">'
    + (off ? 'LightKeeper could not start without signal.<br>Open it once with signal so it can save itself for offline use.'
      : 'LightKeeper is taking a long time to start.<br>The connection may be too weak.')
    + '</div><button type="button" style="font:inherit;padding:10px 22px;border-radius:8px;border:0;background:#4f9dff;color:#fff">Try again</button>';
  s.querySelector('button').addEventListener('click', () => location.reload());
}
setTimeout(() => {
  if (window.lkBooted) return;
  try {
    const last = Number(sessionStorage.getItem('lk2.watchdog') || 0);
    if (Date.now() - last < 60000) { lkStuck(); return; }
    sessionStorage.setItem('lk2.watchdog', String(Date.now()));
  } catch { lkStuck(); return; }
  location.reload();
}, 12000);
setTimeout(lkStuck, 25000);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[lightkeeper] service worker:', err.message)));
}
