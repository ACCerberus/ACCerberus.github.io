/**
 * Cerberus — shared mobile navigation.
 * Injects a hamburger toggle + slide-down panel into any page whose
 * top nav follows the standard `.nav > .nav-links` pattern. No-ops on
 * pages without that structure (e.g. the partner dashboard).
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    var nav = document.querySelector('nav');
    var links = nav && nav.querySelector('.nav-links');
    if (!nav || !links) return;

    var panel = buildPanel(nav, links);
    document.body.appendChild(panel);

    var btn = buildButton();
    nav.appendChild(btn);

    var open = false;
    function setOpen(next) {
      open = next;
      btn.setAttribute('aria-expanded', String(open));
      panel.classList.toggle('open', open);
      document.body.style.overflow = open ? 'hidden' : '';
    }

    btn.addEventListener('click', function () { setOpen(!open); });
    panel.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) setOpen(false);
    });
    window.addEventListener('resize', function () {
      if (open && window.innerWidth > 900) setOpen(false);
    });
  }

  function buildButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-hamburger';
    btn.setAttribute('aria-label', 'Toggle navigation menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="nav-hamburger-lines"><span></span><span></span><span></span></span>';
    return btn;
  }

  function buildPanel(nav, links) {
    var panel = document.createElement('div');
    panel.className = 'mobile-nav-panel';

    // Primary nav links
    Array.prototype.forEach.call(links.querySelectorAll('a'), function (a) {
      panel.appendChild(a.cloneNode(true));
    });

    // Secondary actions (login / CTA / user menu) — try common containers
    var extras = nav.querySelectorAll(
      '.nav-cta-wrap a, .nav-right a, .nav-right button'
    );
    if (extras.length) {
      var label = document.createElement('div');
      label.className = 'mobile-nav-section-label';
      label.textContent = 'Account';
      panel.appendChild(label);
      Array.prototype.forEach.call(extras, function (el) {
        var clone = el.cloneNode(true);
        if (clone.classList.contains('nav-cta') || clone.classList.contains('btn-logout')) {
          clone.classList.add('mobile-nav-cta');
        }
        panel.appendChild(clone);
      });
    }

    return panel;
  }
})();
