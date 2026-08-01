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

  var THEME_KEY = 'cerberus_theme';

  function init() {
    initSkipLink();

    var nav = document.querySelector('nav');
    if (nav) {
      initScrollShadow(nav);
      // Insert into the nav's existing right-side group (rather than appending
      // directly to <nav>) so it doesn't add a 4th participant to a two/three-
      // child `justify-content: space-between` layout and shove things around.
      var actionsGroup = nav.lastElementChild;
      if (actionsGroup && actionsGroup !== nav.firstElementChild) {
        actionsGroup.appendChild(buildThemeToggle());
      } else {
        nav.appendChild(buildThemeToggle());
      }
    }

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

  function initSkipLink() {
    if (document.querySelector('.skip-link')) return;

    var target = document.querySelector('main, [role="main"], h1');
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');

    var link = document.createElement('a');
    link.className = 'skip-link';
    link.href = '#';
    link.textContent = 'Skip to content';
    link.addEventListener('click', function (e) {
      e.preventDefault();
      target.focus();
      target.scrollIntoView();
    });
    document.body.insertBefore(link, document.body.firstChild);
  }

  function buildThemeToggle() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', 'Toggle light/dark theme');
    btn.innerHTML =
      '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' +
      '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

    btn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      var next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    });

    return btn;
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
