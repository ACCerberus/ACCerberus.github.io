/**
 * Cerberus Anti-Cheat — Shared Module
 * Loaded on every page. Provides:
 *  - State feed-through from data/state.json (TODO #1)
 *  - Dynamic threat level banner (TODO #10)
 *  - Smart favicon (QOL #10)
 *  - Cross-page event propagation (TODO #25)
 *  - Page transition animations (QOL #6)
 */

(function () {
  'use strict';

  var CERBERUS = window.CERBERUS || {};
  window.CERBERUS = CERBERUS;

  // ─── Helpers ───
  function daySeed() {
    var d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function seededRand(seed) {
    var x = Math.sin(seed) * 43758.5453;
    return x - Math.floor(x);
  }

  // ─── 1. STATE FEED-THROUGH ───
  // Fetch state.json and expose globally so every page can use it
  CERBERUS.state = null;
  CERBERUS.stateReady = new Promise(function (resolve) {
    CERBERUS._resolveState = resolve;
  });

  function fetchState() {
    var cacheBust = '?t=' + Math.floor(Date.now() / 60000);
    fetch('/data/state.json' + cacheBust)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        CERBERUS.state = data;
        CERBERUS._resolveState(data);
        applyThreatBanner(data.threatLevel);
        applySmartFavicon(data.threatLevel);
        document.dispatchEvent(new CustomEvent('cerberus:state', { detail: data }));
      })
      .catch(function () {
        // Fallback defaults
        CERBERUS.state = {
          threatLevel: 'MODERATE', signatureDb: 4891, totalBans: 2847291,
          engineVersion: 'v0.4.2.0b', activeSessions: 4218, dailyDetections: 1847,
          falsePositiveRate: 0.003, avgScanLatency: 0.42
        };
        CERBERUS._resolveState(CERBERUS.state);
        applyThreatBanner('MODERATE');
        applySmartFavicon('MODERATE');
      });
  }

  // ─── 10. DYNAMIC THREAT LEVEL BANNER ───
  var bannerConfig = {
    LOW:      { bg: 'rgba(48,200,96,0.12)',  border: 'rgba(48,200,96,0.3)',  color: '#30c860', text: 'All Clear', icon: '\u2714', show: false },
    MODERATE: { bg: 'rgba(232,160,32,0.10)', border: 'rgba(232,160,32,0.3)', color: '#e8a020', text: 'Elevated Activity', icon: '\u26a0', show: true },
    ELEVATED: { bg: 'rgba(232,140,40,0.14)', border: 'rgba(232,140,40,0.4)', color: '#e88c28', text: 'Elevated Threat Level', icon: '\u26a0', show: true },
    HIGH:     { bg: 'rgba(224,64,80,0.14)',   border: 'rgba(224,64,80,0.4)',  color: '#e04050', text: 'Active Threat — Monitoring Engaged', icon: '\u26d4', show: true }
  };

  function applyThreatBanner(level) {
    level = level || 'MODERATE';
    var cfg = bannerConfig[level] || bannerConfig.MODERATE;
    var existing = document.getElementById('cerberusThreatBanner');
    if (existing) existing.remove();
    if (!cfg.show) return;

    var banner = document.createElement('div');
    banner.id = 'cerberusThreatBanner';
    banner.setAttribute('role', 'alert');
    var pulse = level === 'HIGH' ? 'animation:cerberus-pulse 2s ease-in-out infinite;' : '';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;' +
      'padding:8px 20px;text-align:center;font-size:0.78rem;font-weight:600;' +
      'font-family:Inter,-apple-system,sans-serif;letter-spacing:0.5px;' +
      'background:' + cfg.bg + ';color:' + cfg.color + ';' +
      'border-bottom:1px solid ' + cfg.border + ';' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'transition:all 0.4s ease;' + pulse;

    banner.innerHTML = '<span style="margin-right:8px">' + cfg.icon + '</span>' +
      'THREAT LEVEL: ' + level + ' — ' + cfg.text +
      '<span style="margin-left:16px;opacity:0.6;font-size:0.7rem">Updated ' +
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>';

    document.body.insertBefore(banner, document.body.firstChild);

    // Push nav down to make room
    var nav = document.querySelector('.nav');
    if (nav) nav.style.top = banner.offsetHeight + 'px';

    // Inject pulse keyframes if HIGH
    if (level === 'HIGH' && !document.getElementById('cerberusPulseStyle')) {
      var style = document.createElement('style');
      style.id = 'cerberusPulseStyle';
      style.textContent = '@keyframes cerberus-pulse{0%,100%{opacity:1}50%{opacity:0.7}}';
      document.head.appendChild(style);
    }
  }

  // ─── QOL #10: SMART FAVICON ───
  function applySmartFavicon(level) {
    level = level || 'MODERATE';
    var colors = { LOW: '#30c860', MODERATE: '#e8a020', ELEVATED: '#e88c28', HIGH: '#e04050' };
    var fill = colors[level] || colors.MODERATE;

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<path d="M32 4L8 16v16c0 14.4 10.2 27.8 24 32 13.8-4.2 24-17.6 24-32V16L32 4z" ' +
      'fill="' + fill + '" opacity="0.9"/>' +
      '<path d="M32 12l-18 9v12c0 11 7.8 21.3 18 24.5 10.2-3.2 18-13.5 18-24.5V21L32 12z" ' +
      'fill="#050507"/>' +
      '<text x="32" y="42" text-anchor="middle" font-size="22" font-weight="bold" ' +
      'fill="' + fill + '" font-family="sans-serif">C</text></svg>';

    var encoded = 'data:image/svg+xml,' + encodeURIComponent(svg);
    var link = document.querySelector('link[rel="icon"]');
    if (link) {
      link.href = encoded;
    } else {
      link = document.createElement('link');
      link.rel = 'icon';
      link.href = encoded;
      document.head.appendChild(link);
    }
  }

  // ─── TODO #25: CROSS-PAGE EVENT PROPAGATION ───
  // Write events to localStorage, other pages react
  CERBERUS.publishEvent = function (type, data) {
    var event = { type: type, data: data, timestamp: Date.now(), page: location.pathname };
    localStorage.setItem('cerberus_event', JSON.stringify(event));
    // Trigger on current page too
    document.dispatchEvent(new CustomEvent('cerberus:crossEvent', { detail: event }));
  };

  // Listen for events from other tabs
  window.addEventListener('storage', function (e) {
    if (e.key === 'cerberus_event' && e.newValue) {
      try {
        var event = JSON.parse(e.newValue);
        document.dispatchEvent(new CustomEvent('cerberus:crossEvent', { detail: event }));
      } catch (err) { /* ignore */ }
    }
  });

  // ─── QOL #6: PAGE TRANSITION ANIMATIONS ───
  function initPageTransitions() {
    // Fade in on load
    document.body.style.opacity = '0';
    document.body.style.transition = 'opacity 0.3s ease';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.style.opacity = '1';
      });
    });

    // Intercept nav clicks for smooth transitions
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href');
      // Only intercept internal page navigations (not anchors, not external)
      if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto:') || link.target === '_blank') return;
      // Must be a site-internal link
      if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || (!href.includes('://'))) {
        e.preventDefault();
        document.body.style.opacity = '0';
        setTimeout(function () { window.location.href = href; }, 250);
      }
    });
  }

  // ─── INIT ───
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      fetchState();
      initPageTransitions();
    });
  } else {
    fetchState();
    initPageTransitions();
  }

})();
