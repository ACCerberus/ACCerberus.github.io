/**
 * Cerberus — shared mobile navigation.
 * Injects a hamburger toggle + slide-down panel into any page whose
 * top nav follows the standard `.nav > .nav-links` pattern. No-ops on
 * pages without that structure (e.g. the partner dashboard).
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('DOMContentLoaded', initScrollReveal);

  function initScrollReveal() {
    var targets = document.querySelectorAll('.reveal');
    if (!targets.length) return;

    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('visible'); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    targets.forEach(function (el) { observer.observe(el); });

    // Safety net: never leave content permanently invisible if something goes wrong.
    setTimeout(function () {
      targets.forEach(function (el) { el.classList.add('visible'); });
    }, 4000);
  }

  function init() {
    var nav = document.querySelector('nav');
    if (nav) initScrollShadow(nav);

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

  function initScrollShadow(nav) {
    var lastState = false;
    function update() {
      var scrolled = window.scrollY > 20;
      if (scrolled !== lastState) {
        nav.classList.toggle('nav-scrolled', scrolled);
        lastState = scrolled;
      }
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
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
