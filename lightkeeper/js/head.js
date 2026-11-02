/* Always run the newest build: compare ./version.json (never cached) with the version this browser last ran.
   On a change, install the new build's service worker first and then reload, so the app keeps working offline
   right after an update. Only if that stalls are the caches and the service worker dropped (the old way). Saved
   offline data (lk-keep-* caches and IndexedDB) is always kept. */
(function () {
  var KEY = 'lk2.siteVersion';
  function purge() {
    var jobs = [];
    if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('lk-keep-') !== 0; }).map(function (k) { return caches.delete(k); })); }));
    if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
    return Promise.all(jobs).catch(function () {});
  }
  function installNew() {
    var sw = navigator.serviceWorker;
    if (!sw) return Promise.resolve(true);
    return sw.getRegistration().then(function (reg) {
      if (!reg) return true;
      return reg.update().then(function () {
        var w = reg.installing || reg.waiting;
        if (!w) return !!reg.active;
        return new Promise(function (res) {
          if (w.state === 'activated') return res(true);
          w.addEventListener('statechange', function () { if (w.state === 'activated') res(true); else if (w.state === 'redundant') res(false); });
        });
      });
    });
  }
  try {
    fetch('./version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
      if (!v || !v.version) return;
      var seen = localStorage.getItem(KEY);
      if (seen === v.version) return;
      localStorage.setItem(KEY, v.version);
      if (seen === null && !('serviceWorker' in navigator && navigator.serviceWorker.controller)) return; // first visit: nothing stale
      var timeout = new Promise(function (res) { setTimeout(function () { res(false); }, 20000); });
      Promise.race([installNew().catch(function () { return false; }), timeout])
        .then(function (ok) { return ok ? null : purge(); })
        .then(function () { location.reload(); });
    }).catch(function () {});
  } catch (e) { /* storage blocked: just run */ }
})();
