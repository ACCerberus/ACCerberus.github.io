/* Always run the newest build: compare ./version.json (never cached) with the version this browser last ran.
   On a change, drop every Cache Storage cache and the service worker, then reload once. The downloaded Light List
   and places (IndexedDB) are kept; they refresh on their own schedule, so an update doesn't re-download them. */
(function () {
  var KEY = 'lk2.siteVersion';
  try {
    fetch('./version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
      if (!v || !v.version) return;
      var seen = localStorage.getItem(KEY);
      if (seen === v.version) return;
      localStorage.setItem(KEY, v.version);
      if (seen === null && !('serviceWorker' in navigator && navigator.serviceWorker.controller)) return; // first visit: nothing stale
      var jobs = [];
      if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
      if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
      Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
    }).catch(function () {});
  } catch (e) { /* storage blocked: just run */ }
})();
