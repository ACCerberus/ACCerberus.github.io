document.querySelectorAll('.shot img').forEach(function (img) {
  function empty() { var slot = img.parentNode; slot.classList.add('empty'); slot.textContent = 'screenshot: ' + img.getAttribute('src'); }
  if (img.complete && !img.naturalWidth) empty(); else img.addEventListener('error', empty);
});
var io = new IntersectionObserver(function (entries) {
  entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
var tiltEl = document.querySelector('.tilt');
var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function tilt() { if (tiltEl) tiltEl.style.setProperty('--tilt', (calm ? 0 : Math.max(0, 9 - scrollY / 45)).toFixed(2) + 'deg'); }
var progress = document.getElementById('progress');
function onScroll() {
  var max = document.documentElement.scrollHeight - innerHeight;
  progress.style.transform = 'scaleX(' + (max > 0 ? scrollY / max : 0) + ')';
  tilt();
}
addEventListener('scroll', onScroll, { passive: true }); onScroll();
document.addEventListener('pointermove', function (e) {
  var card = e.target.closest && e.target.closest('.card'); if (!card) return;
  var r = card.getBoundingClientRect();
  card.style.setProperty('--mx', (e.clientX - r.left) + 'px'); card.style.setProperty('--my', (e.clientY - r.top) + 'px');
});
var stats = document.querySelector('.stats');
if (stats) new IntersectionObserver(function (entries, obs) {
  if (!entries[0].isIntersecting) return; obs.disconnect(); if (calm) return;
  document.querySelectorAll('[data-count]').forEach(function (el) {
    var end = +el.dataset.count, t0 = performance.now();
    (function tick(now) { var p = Math.min(1, (now - t0) / 1100); el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))).toLocaleString(); if (p < 1) requestAnimationFrame(tick); })(t0);
  });
}, { threshold: 0.6 }).observe(stats);
var nav = document.querySelector('.nav'), menu = document.getElementById('menu');
function setMenu(open) { nav.classList.toggle('open', open); menu.setAttribute('aria-expanded', open); }
menu.addEventListener('click', function () { setMenu(!nav.classList.contains('open')); });
nav.querySelectorAll('.nav-links a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
var lightbox = document.getElementById('lightbox');
document.querySelectorAll('.shot img').forEach(function (img) {
  img.addEventListener('click', function () { lightbox.firstElementChild.src = img.src; lightbox.classList.add('open'); });
});
lightbox.addEventListener('click', function () { lightbox.classList.remove('open'); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') lightbox.classList.remove('open'); });
var list = document.getElementById('list'), toggle = document.getElementById('toggle');
if (list && toggle) {
  var all = Array.prototype.slice.call(list.querySelectorAll('details'));
  function sync() { toggle.textContent = all.every(function (d) { return d.open; }) ? 'Collapse all' : 'Expand all'; }
  toggle.addEventListener('click', function () { var open = !all.every(function (d) { return d.open; }); all.forEach(function (d) { d.open = open; }); sync(); });
  all.forEach(function (d) { d.addEventListener('toggle', sync); });
  function openHash() { var d = location.hash && document.getElementById(location.hash.slice(1)); if (d && d.tagName === 'DETAILS') { d.open = true; d.scrollIntoView(); sync(); } }
  window.addEventListener('hashchange', openHash); openHash();
}
