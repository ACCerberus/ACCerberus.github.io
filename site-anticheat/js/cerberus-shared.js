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

  // ─── Helpers (delegated to CerberusEngine when available) ───
  function daySeed() {
    if (window.CerberusEngine) return CerberusEngine.daySeed();
    var d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function seededRand(seed) {
    if (window.CerberusEngine) return CerberusEngine.seeded(seed);
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
        // Override stale state values with engine-derived ones
        var E = window.CerberusEngine;
        if (E) {
          var snap = E.snapshot();
          data.threatLevel = snap.threatLevel;
          data.signatureDb = snap.signatureCount;
          data.totalBans = snap.totalBans;
          data.activeSessions = snap.activeSessions;
          data.dailyDetections = snap.dailyDetections;
          data.nextScheduledMaint = snap.nextMaintenance.toISOString();
        }
        CERBERUS._resolveState(data);
        applyThreatBanner(data.threatLevel);
        applySmartFavicon(data.threatLevel);
        document.dispatchEvent(new CustomEvent('cerberus:state', { detail: data }));
      })
      .catch(function () {
        // Fallback defaults — aligned with engine values
        var E = window.CerberusEngine;
        var snap = E ? E.snapshot() : null;
        CERBERUS.state = {
          threatLevel: 'LOW',
          signatureDb: snap ? snap.signatureCount : 4910,
          totalBans: snap ? snap.totalBans : 3247,
          engineVersion: snap ? snap.engineVersion : 'v0.5.0.0b',
          activeSessions: snap ? snap.activeSessions : 482,
          dailyDetections: snap ? snap.dailyDetections : 18,
          falsePositiveRate: snap ? snap.falsePositiveRate : 0.14,
          avgScanLatency: 2.4
        };
        CERBERUS._resolveState(CERBERUS.state);
        applyThreatBanner('MODERATE');
        applySmartFavicon('MODERATE');
      });
  }

  // ─── 10. DYNAMIC THREAT LEVEL BANNER ───
  var bannerConfig = {
    LOW:      { bg: 'rgba(48,200,96,0.12)',  border: 'rgba(48,200,96,0.3)',  color: '#30c860', text: 'All Clear', icon: '\u2714', show: false },
    MODERATE: { bg: 'rgba(232,160,32,0.10)', border: 'rgba(232,160,32,0.3)', color: '#e8a020', text: 'Elevated Activity', icon: '\u26a0', show: false },
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

  // ─── QOL #2: COMMAND PALETTE (Ctrl+K) ───
  function initCommandPalette() {
    var pages = [
      { name: 'Home', desc: 'Main landing page', url: '/' },
      { name: 'Analytics Dashboard', desc: 'Live threat monitoring', url: '/analytics/' },
      { name: 'Status Page', desc: 'System health & uptime', url: '/status/' },
      { name: 'Changelog', desc: 'Version history & updates', url: '/changelog/' },
      { name: 'Documentation', desc: 'SDK integration guides', url: '/docs/' },
      { name: 'API Reference', desc: 'REST API endpoints', url: '/api/' },
      { name: 'SDK Download', desc: 'Download SDK package', url: '/sdk/' },
      { name: 'Blog', desc: 'Threat reports & engineering', url: '/blog/' },
      { name: 'Team', desc: 'Engineering team', url: '/team/' },
      { name: 'Request Access', desc: 'Early access application form', url: '/access/' },
      { name: 'Trust Center', desc: 'Security, compliance & disclosure', url: '/trust/' },
      { name: 'Case Studies', desc: 'Closed-beta partner results', url: '/case-studies/' },
      { name: 'Updates', desc: 'How update delivery works', url: '/updates/' },
      { name: 'Privacy Policy', desc: 'Data handling & privacy practices', url: '/privacy/' },
      { name: 'Terms of Service', desc: 'Terms & conditions of use', url: '/terms/' },
      { name: 'Partner Login', desc: 'Partner portal sign-in', url: '/login/' },
    ];

    var overlay = null;

    function open() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.id = 'cmdPalette';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:flex-start;justify-content:center;padding-top:20vh;backdrop-filter:blur(4px);';
      overlay.innerHTML = '<div style="background:#0a0a0f;border:1px solid rgba(255,255,255,0.1);border-radius:14px;width:480px;max-width:90vw;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6);">' +
        '<div style="padding:16px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7084" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
        '<input id="cmdInput" type="text" placeholder="Search pages, actions..." style="flex:1;background:none;border:none;outline:none;color:#eef0f4;font-family:Inter,-apple-system,sans-serif;font-size:0.9rem;" autocomplete="off"/>' +
        '<span style="font-size:0.6rem;color:#6b7084;background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;">ESC</span></div>' +
        '<div id="cmdResults" style="max-height:300px;overflow-y:auto;"></div></div>';
      document.body.appendChild(overlay);

      var input = document.getElementById('cmdInput');
      var results = document.getElementById('cmdResults');
      input.focus();

      function render(query) {
        var q = (query || '').toLowerCase();
        var matches = pages.filter(function (p) {
          return p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q);
        });
        results.innerHTML = matches.map(function (p, i) {
          var active = i === 0 ? 'background:rgba(232,160,32,0.08);' : '';
          return '<a href="' + p.url + '" style="display:flex;align-items:center;gap:12px;padding:12px 16px;text-decoration:none;transition:background 0.15s;' + active + '" ' +
            'onmouseover="this.style.background=\'rgba(232,160,32,0.08)\'" onmouseout="this.style.background=\'\'">' +
            '<div style="width:32px;height:32px;border-radius:8px;background:rgba(232,160,32,0.1);display:flex;align-items:center;justify-content:center;color:#e8a020;font-size:0.75rem;font-weight:700;">' + p.name[0] + '</div>' +
            '<div><div style="color:#eef0f4;font-size:0.82rem;font-weight:500;">' + p.name + '</div>' +
            '<div style="color:#6b7084;font-size:0.7rem;">' + p.desc + '</div></div></a>';
        }).join('');
      }
      render('');

      input.addEventListener('input', function () { render(input.value); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') {
          var first = results.querySelector('a');
          if (first) { first.click(); close(); }
        }
      });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    function close() {
      if (overlay) { overlay.remove(); overlay = null; }
    }

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (overlay) close(); else open();
      }
      if (e.key === 'Escape' && overlay) close();
    });
  }

  // ─── TOAST NOTIFICATIONS ON ALL PAGES ───
  // Extends toast system site-wide (previously only on index.html)
  function initToasts() {
    // Don't add if already exists (index.html has its own)
    if (document.getElementById('toastContainer')) return;

    // Inject toast CSS
    var style = document.createElement('style');
    style.textContent = '.toast-container{position:fixed;bottom:24px;right:24px;z-index:9000;display:flex;flex-direction:column;gap:8px;pointer-events:none}' +
      '.toast{pointer-events:auto;padding:12px 18px;background:rgba(10,10,15,0.95);border:1px solid rgba(255,255,255,0.06);border-radius:10px;font-size:0.78rem;color:#c8ccd4;max-width:360px;display:flex;align-items:flex-start;gap:10px;animation:toastIn 0.3s ease;box-shadow:0 4px 24px rgba(0,0,0,0.4);font-family:Inter,-apple-system,sans-serif}' +
      '.toast.out{animation:toastOut 0.3s ease forwards}' +
      '@keyframes toastIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}' +
      '@keyframes toastOut{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(40px)}}' +
      '.toast-icon{flex-shrink:0;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;margin-top:1px}' +
      '.toast-icon-block{background:rgba(224,64,80,0.15);color:#e04050}' +
      '.toast-icon-ok{background:rgba(48,200,96,0.15);color:#30c860}' +
      '.toast-icon-info{background:rgba(232,160,32,0.15);color:#e8a020}' +
      '.toast-text{line-height:1.4}.toast-text strong{color:#eef0f4}' +
      '.toast-time{font-family:"JetBrains Mono",monospace;font-size:0.6rem;color:#6b7084;margin-top:3px}';
    document.head.appendChild(style);

    var container = document.createElement('div');
    container.className = 'toast-container';
    container.id = 'toastContainer';
    document.body.appendChild(container);

    var baseMsgs = [
      { icon: 'ok', text: '<strong>Signature DB synced</strong> \u2014 US-East + EU-West up to date' },
      { icon: 'info', text: '<strong>Threat intel</strong> \u2014 new loader variant catalogued' },
      { icon: 'ok', text: '<strong>Kernel integrity</strong> \u2014 scan cycle verified' },
      { icon: 'ok', text: '<strong>AI model</strong> \u2014 behavioral engine checkpoint saved' },
      { icon: 'block', text: '<strong>HWID mismatch</strong> \u2014 hardware fingerprint flagged for review' },
      { icon: 'ok', text: '<strong>Pentest batch</strong> \u2014 automated test suite passed 84 scenarios' },
      { icon: 'block', text: '<strong>Kernel anomaly</strong> \u2014 suspicious driver load flagged' },
      { icon: 'info', text: '<strong>Model update</strong> \u2014 behavioral classifier v3.1 deployed to beta' },
      { icon: 'ok', text: '<strong>Session integrity</strong> \u2014 active sessions verified clean' },
      { icon: 'info', text: '<strong>Partner webhook</strong> \u2014 detection event delivered' },
      { icon: 'block', text: '<strong>Memory anomaly</strong> \u2014 RWX region detected in game process' },
      { icon: 'info', text: '<strong>Network sentinel</strong> \u2014 packet integrity check passed' },
    ];
    // Phase-aware arms race messages
    var phaseMsgs = {
      DETECTED: [
        { icon: 'block', text: '<strong>DETECTED</strong> \u2014 new bypass from {provider} identified, scanning intensified' },
        { icon: 'info', text: '<strong>Threat intel</strong> \u2014 {provider} released new build, behavioral AI flagging anomalies' },
      ],
      ANALYSIS: [
        { icon: 'info', text: '<strong>Analysis in progress</strong> \u2014 {provider} variant under reverse engineering' },
        { icon: 'info', text: '<strong>Signature development</strong> \u2014 generating detection patterns for {provider} update' },
      ],
      DEPLOYING: [
        { icon: 'ok', text: '<strong>Deploying signatures</strong> \u2014 {n} new sigs pushed across all regions for {provider}' },
        { icon: 'ok', text: '<strong>Signature burst</strong> \u2014 bulk push complete, detection rate recovering' },
      ],
      NEUTRALIZED: [
        { icon: 'ok', text: '<strong>Threat neutralized</strong> \u2014 {provider} variant fully covered, ban wave processing' },
        { icon: 'info', text: '<strong>Cooldown</strong> \u2014 {provider} bypass neutralized, monitoring for follow-up variants' },
      ]
    };
    var E = window.CerberusEngine;
    var arc = E ? E.armsRaceEvent() : null;
    var msgs = baseMsgs.slice();
    if (arc && arc.isSpike && arc.phaseName) {
      var phasePool = phaseMsgs[arc.phaseName] || phaseMsgs.DETECTED;
      phasePool.forEach(function(m) {
        var text = m.text.replace('{n}', arc.spikeSigs).replace(/\{provider\}/g, arc.provider);
        msgs.push({ icon: m.icon, text: text });
      });
    }

    function showToast() {
      var msg = msgs[Math.floor(Math.random() * msgs.length)];
      var toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = '<div class="toast-icon toast-icon-' + msg.icon + '">' +
        (msg.icon === 'block' ? 'X' : msg.icon === 'ok' ? '\u2713' : '!') +
        '</div><div class="toast-text">' + msg.text +
        '<div class="toast-time">' + new Date().toLocaleTimeString() + '</div></div>';
      container.appendChild(toast);
      setTimeout(function () { toast.classList.add('out'); }, 5000);
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 5300);
      while (container.children.length > 3) container.removeChild(container.firstChild);
    }

    // First toast after 60-120s, then every 2-10min (engine-paced)
    setTimeout(function () {
      showToast();
      function scheduleNext() {
        var E = window.CerberusEngine;
        var delay = E ? E.nextToastInterval() : (120000 + Math.floor(Math.random() * 480000));
        setTimeout(function () { showToast(); scheduleNext(); }, delay);
      }
      scheduleNext();
    }, 60000 + Math.floor(Math.random() * 60000));

    // ─── AMBIENT ENGINE-AWARE TOASTS ───
    // After 45-90s on page, show contextual ambient events from the engine.
    // Then every 3-5min, show the next one. Max 3 per page load.
    (function initAmbientToasts() {
      var E = window.CerberusEngine;
      if (!E || !E.ambientEvents) return;

      var now = new Date();
      var events = E.ambientEvents(now);
      if (!events || !events.length) return;

      var ambientIndex = 0;
      var ambientMax = 3;
      var ambientShown = 0;

      function showAmbientToast() {
        if (ambientShown >= ambientMax || ambientIndex >= events.length) return;
        var evt = events[ambientIndex++];
        ambientShown++;

        var toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = '<div class="toast-icon toast-icon-info">!</div>' +
          '<div class="toast-text">' + evt.icon + ' ' + evt.message +
          '<div class="toast-time">' + new Date().toLocaleTimeString() + '</div></div>';
        container.appendChild(toast);
        setTimeout(function () { toast.classList.add('out'); }, 5000);
        setTimeout(function () { if (toast.parentNode) toast.remove(); }, 5300);
        while (container.children.length > 3) container.removeChild(container.firstChild);

        // Schedule next ambient toast (3-5 minutes)
        if (ambientShown < ambientMax && ambientIndex < events.length) {
          var nextDelay = 180000 + Math.floor(Math.random() * 120000);
          setTimeout(showAmbientToast, nextDelay);
        }
      }

      // First ambient toast after 45-90 seconds
      var initialDelay = 45000 + Math.floor(Math.random() * 45000);
      setTimeout(showAmbientToast, initialDelay);
    })();
  }

  // ─── NAV AUTH STATE ───
  function initNavAuth() {
    if (location.pathname.startsWith('/dashboard/')) return;
    var raw = localStorage.getItem('cerberus_partner');
    if (!raw) return;
    try { var p = JSON.parse(raw); } catch (e) { return; }
    if (!p || !p.name) return;

    var wrap = document.querySelector('.nav-cta-wrap');
    if (!wrap) return;

    var tierShort = (p.tier || 'Argus').split(' ')[0];
    wrap.innerHTML =
      '<span style="font-size:0.75rem;color:var(--text-dim);margin-right:4px;">' + tierShort + '</span>' +
      '<span style="font-size:0.82rem;font-weight:600;color:var(--text-bright);">' + p.name + '</span>' +
      '<a href="/dashboard/" style="padding:8px 16px;border-radius:8px;font-size:0.8rem;font-weight:600;background:var(--accent);color:#050507;text-decoration:none;transition:all 0.2s;letter-spacing:0.3px;margin-left:8px;">Dashboard</a>';
  }


  // ─── INIT ───
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      fetchState();
      initPageTransitions();
      initToasts();
      initCommandPalette();
      initNavAuth();
    });
  } else {
    fetchState();
    initPageTransitions();
    initToasts();
    initCommandPalette();
    initNavAuth();
  }

})();

