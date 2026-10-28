/* Home-screen app safety net: if startup hasn't finished in 12 s (a stalled download, or iPhone resuming a page it
   dropped from memory), reload once. Never more than once a minute, so it can't loop. */
setTimeout(() => {
  if (window.lkBooted) return;
  try {
    const last = Number(sessionStorage.getItem('lk2.watchdog') || 0);
    if (Date.now() - last < 60000) return;
    sessionStorage.setItem('lk2.watchdog', String(Date.now()));
  } catch { return; }
  location.reload();
}, 12000);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[lightkeeper] service worker:', err.message)));
}
