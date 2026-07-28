/**
 * Cerberus Market — Shared Module
 * Loaded on every page. Provides:
 *  - State feed-through from data/state.json + data/catalog.json, merged with CerberusEngine
 *  - Dynamic deals/demand banner (replaces the old threat-level banner)
 *  - Smart favicon (recolors by demand level)
 *  - Cross-tab event propagation (localStorage + storage event)
 *  - Page transition animations
 *  - Command palette (Ctrl+K)
 *  - Site-wide toast notifications (marketplace-themed + engine ambient events)
 *  - Nav cart badge (localStorage-backed, cross-tab synced)
 *  - Shared cover-tile renderer (CERBERUS.coverTileHTML) for CSS-only game "cover art"
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

  function safeFetchJSON(url) {
    return fetch(url)
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  // ─── 1. STATE FEED-THROUGH ───
  // Fetches state.json + catalog.json in parallel, overrides stale fields with
  // engine-derived live values, and exposes everything globally.
  CERBERUS.state = null;
  CERBERUS.catalog = [];
  CERBERUS.stateReady = new Promise(function (resolve) {
    CERBERUS._resolveState = resolve;
  });

  function fetchState() {
    var cacheBust = '?t=' + Math.floor(Date.now() / 60000);
    Promise.all([
      safeFetchJSON('/data/state.json' + cacheBust),
      safeFetchJSON('/data/catalog.json' + cacheBust)
    ]).then(function (results) {
      var data = results[0];
      var catalog = results[1] || [];
      CERBERUS.catalog = catalog;

      var E = window.CerberusEngine;
      var snap = E ? E.snapshot() : null;

      if (!data) {
        // Fallback defaults — aligned with engine values
        data = {
          activeListings: snap ? snap.activeListings : 1800,
          onlineBuyers: snap ? snap.onlineBuyers : 90,
          dailyOrdersPlaced: snap ? snap.dailyOrdersPlaced : 140,
          dailyKeysDelivered: snap ? snap.dailyKeysDelivered : 135,
          totalKeysSold: snap ? snap.totalKeysSold : 44000,
          demandLevel: snap ? snap.demandLevel : 'LOW',
          flashSale: snap ? snap.flashSale : { isActive: false },
          disputeFreeStreak: snap ? snap.disputeFreeStreak : 20,
          platformVersion: snap ? snap.platformVersion : 'v0.5.0.0b',
          checkoutSuccessRate: snap ? snap.performance.checkoutSuccessRate : 98.5,
          avgDeliveryTime: snap ? snap.performance.avgDeliveryTime : 10
        };
      }

      if (snap) {
        // Override stale JSON values with live engine-derived ones
        data.activeListings = snap.activeListings;
        data.onlineBuyers = snap.onlineBuyers;
        data.dailyOrdersPlaced = snap.dailyOrdersPlaced;
        data.dailyKeysDelivered = snap.dailyKeysDelivered;
        data.totalKeysSold = snap.totalKeysSold;
        data.demandLevel = snap.demandLevel;
        data.flashSale = snap.flashSale;
        data.disputeFreeStreak = snap.disputeFreeStreak;
        data.fraudChecksPerformed = snap.fraudChecksPerformed;
        data.buyerProtectionClaims = snap.buyerProtectionClaims;
        data.checkoutSuccessRate = snap.performance.checkoutSuccessRate;
        data.avgDeliveryTime = snap.performance.avgDeliveryTime;
        data.nextScheduledMaint = snap.nextMaintenance.toISOString();
        data.lastHeartbeat = snap.lastHeartbeat.toISOString();
        data.dailyDigest = snap.dailyDigest;
      }

      CERBERUS.state = data;
      CERBERUS._resolveState(data);
      applyDemandBanner(data.demandLevel, data.flashSale, catalog);
      applySmartFavicon(data.demandLevel);
      document.dispatchEvent(new CustomEvent('cerberus:state', { detail: data }));
    });
  }

  // ─── DYNAMIC DEALS / DEMAND BANNER ───
  // Only shown for ELEVATED / SURGE demand (same show/hide pattern as the
  // original threat-level banner). LOW / MODERATE render nothing.
  var bannerConfig = {
    LOW:      { show: false },
    MODERATE: { show: false },
    ELEVATED: { bg: 'rgba(232,140,40,0.14)', border: 'rgba(232,140,40,0.4)', color: '#e88c28', icon: '\u{1F4C8}', show: true, pulse: false },
    SURGE:    { bg: 'rgba(224,64,80,0.14)',  border: 'rgba(224,64,80,0.4)',  color: '#e04050', icon: '\u{1F525}', show: true, pulse: true }
  };

  function bannerMessage(level, flashSale, catalog) {
    var title = null;
    if (flashSale && flashSale.featuredIndex != null && catalog && catalog[flashSale.featuredIndex]) {
      title = catalog[flashSale.featuredIndex].title;
    }
    if (flashSale && flashSale.isActive) {
      if (flashSale.phaseName === 'LIVE') {
        return 'FLASH SALE LIVE — up to ' + flashSale.discountPct + '% off' + (title ? ' ' + title : ' select titles');
      }
      if (flashSale.phaseName === 'ENDING_SOON') {
        return 'Flash sale ending soon — up to ' + flashSale.discountPct + '% off' + (title ? ' ' + title : '');
      }
    }
    if (level === 'SURGE') return 'Marketplace demand is surging right now';
    return 'Demand is elevated — catalog moving fast';
  }

  function applyDemandBanner(level, flashSale, catalog) {
    level = level || 'MODERATE';
    var cfg = bannerConfig[level] || bannerConfig.MODERATE;
    var existing = document.getElementById('cerberusDemandBanner');
    if (existing) existing.remove();
    if (!cfg.show) {
      var nav = document.querySelector('.nav');
      if (nav) nav.style.top = '0px';
      return;
    }

    var banner = document.createElement('div');
    banner.id = 'cerberusDemandBanner';
    banner.setAttribute('role', 'status');
    var pulse = cfg.pulse ? 'animation:cerberus-pulse 2s ease-in-out infinite;' : '';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;' +
      'padding:8px 20px;text-align:center;font-size:0.78rem;font-weight:600;' +
      'font-family:Inter,-apple-system,sans-serif;letter-spacing:0.5px;' +
      'background:' + cfg.bg + ';color:' + cfg.color + ';' +
      'border-bottom:1px solid ' + cfg.border + ';' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'transition:all 0.4s ease;' + pulse;

    banner.innerHTML = '<span style="margin-right:8px">' + cfg.icon + '</span>' +
      bannerMessage(level, flashSale, catalog) +
      '<span style="margin-left:16px;opacity:0.6;font-size:0.7rem">Updated ' +
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>';

    document.body.insertBefore(banner, document.body.firstChild);

    // Push nav down to make room
    var nav2 = document.querySelector('.nav');
    if (nav2) nav2.style.top = banner.offsetHeight + 'px';

    if (cfg.pulse && !document.getElementById('cerberusPulseStyle')) {
      var style = document.createElement('style');
      style.id = 'cerberusPulseStyle';
      style.textContent = '@keyframes cerberus-pulse{0%,100%{opacity:1}50%{opacity:0.7}}';
      document.head.appendChild(style);
    }
  }

  // ─── SMART FAVICON ───
  // Recolors by demand level (green=calm, amber=busy, orange=elevated, red=surge).
  // Motif: stylized price tag (punch hole + "C") instead of the old shield.
  function applySmartFavicon(level) {
    level = level || 'MODERATE';
    var colors = { LOW: '#30c860', MODERATE: '#e8a020', ELEVATED: '#e88c28', SURGE: '#e04050' };
    var fill = colors[level] || colors.MODERATE;

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<path d="M6 26 L26 6 H54 A4 4 0 0 1 58 10 V38 L38 58 A4 4 0 0 1 32 58 L6 32 A4 4 0 0 1 6 26 Z" ' +
      'fill="' + fill + '" opacity="0.92"/>' +
      '<circle cx="43" cy="19" r="6" fill="#050507"/>' +
      '<text x="30" y="46" text-anchor="middle" font-size="17" font-weight="bold" ' +
      'fill="#050507" font-family="sans-serif">C</text></svg>';

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

  // ─── CROSS-TAB EVENT PROPAGATION ───
  // Write events to localStorage, other pages react via 'cerberus:crossEvent'.
  // Used by cart/checkout pages, e.g. CERBERUS.publishEvent('cart-updated', {...}).
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

  // ─── PAGE TRANSITION ANIMATIONS ───
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

  // ─── COMMAND PALETTE (Ctrl+K) ───
  function initCommandPalette() {
    var pages = [
      { name: 'Home', desc: 'Main landing page', url: '/' },
      { name: 'Browse Catalog', desc: 'Browse all game keys', url: '/catalog/' },
      { name: 'Deals & News', desc: 'Flash sales and marketplace news', url: '/deals/' },
      { name: 'Market Trends', desc: 'Genre demand and pricing trends', url: '/trends/' },
      { name: 'Sellers', desc: 'Browse verified sellers', url: '/sellers/' },
      { name: 'Sell on Cerberus Market', desc: 'Become a seller', url: '/sell/' },
      { name: 'Cart', desc: 'Your shopping cart', url: '/cart/' },
      { name: 'Order & Delivery Status', desc: 'Track an order or key delivery', url: '/status/' },
      { name: 'Changelog', desc: 'Version history & updates', url: '/changelog/' },
      { name: 'Privacy Policy', desc: 'How we handle your data', url: '/privacy/' },
      { name: 'Terms of Service', desc: 'Marketplace terms', url: '/terms/' },
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

  // ─── TOAST NOTIFICATIONS (site-wide) ───
  function initToasts() {
    // Don't add if already exists (a page may already have its own container)
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
      { icon: 'ok', text: '<strong>Key delivered</strong> — order fulfilled in under 15 seconds' },
      { icon: 'info', text: '<strong>Price sync</strong> — regional catalog cache refreshed' },
      { icon: 'ok', text: '<strong>Seller verified</strong> — new seller completed identity check' },
      { icon: 'ok', text: '<strong>Restock pushed</strong> — new listings synced across all regions' },
      { icon: 'ok', text: '<strong>Fraud check passed</strong> — checkout batch cleared automated review' },
      { icon: 'block', text: '<strong>Listing flagged</strong> — pricing anomaly held for manual review' },
      { icon: 'info', text: '<strong>Payout processed</strong> — seller settlement batch completed' },
      { icon: 'ok', text: '<strong>Dispute resolved</strong> — replacement key issued to buyer' },
      { icon: 'block', text: '<strong>Redemption blocked</strong> — region-locked key mismatch caught before delivery' },
      { icon: 'info', text: '<strong>Search index rebuilt</strong> — catalog relevance scores refreshed' },
      { icon: 'ok', text: '<strong>Buyer protection claim closed</strong> — refund issued within SLA' },
      { icon: 'info', text: '<strong>Webhook delivered</strong> — order confirmation sent to seller integration' },
    ];

    // Phase-aware flash-sale messages (filled in once state/catalog are ready)
    var phaseMsgs = {
      ANNOUNCED: [
        { icon: 'info', text: '<strong>Flash sale announced</strong> — {title} discount window opens soon' },
        { icon: 'ok', text: '<strong>Sellers prepping inventory</strong> — ahead of the {title} flash sale' },
      ],
      LIVE: [
        { icon: 'ok', text: '<strong>Flash sale live</strong> — up to {discount}% off {title}' },
        { icon: 'info', text: '<strong>Surge traffic</strong> — {title} flash sale driving demand up' },
      ],
      ENDING_SOON: [
        { icon: 'info', text: '<strong>Flash sale ending soon</strong> — last chance on {title}' },
        { icon: 'ok', text: '<strong>Restocking</strong> — {title} inventory topped up to meet demand' },
      ],
      ENDED: [
        { icon: 'info', text: '<strong>Flash sale ended</strong> — {title} pricing returning to baseline' },
      ],
      COOLDOWN: [
        { icon: 'info', text: '<strong>Marketplace cooling down</strong> — after the {title} flash sale' },
      ]
    };

    var msgs = baseMsgs.slice();
    CERBERUS.stateReady.then(function (state) {
      var sale = state && state.flashSale;
      if (sale && sale.isActive && sale.phaseName) {
        var title = 'the featured title';
        if (sale.featuredIndex != null && CERBERUS.catalog && CERBERUS.catalog[sale.featuredIndex]) {
          title = CERBERUS.catalog[sale.featuredIndex].title;
        }
        var phasePool = phaseMsgs[sale.phaseName] || [];
        phasePool.forEach(function (m) {
          var text = m.text.replace('{discount}', sale.discountPct).replace(/\{title\}/g, title);
          msgs.push({ icon: m.icon, text: text });
        });
      }
    });

    function showToast() {
      var msg = msgs[Math.floor(Math.random() * msgs.length)];
      var toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = '<div class="toast-icon toast-icon-' + msg.icon + '">' +
        (msg.icon === 'block' ? 'X' : msg.icon === 'ok' ? '✓' : '!') +
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
    // After 45-90s on page, show contextual ambient events from the engine
    // (restocks, seller verifications, price syncs, sales ticks, payouts, ...).
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

  // ─── NAV CART BADGE ───
  // Cart shape: localStorage['cerberus_cart'] is a JSON array of
  //   { listingId: string, qty: number }
  // Cart/checkout pages built later read & write this same key directly, then
  // call CERBERUS.publishEvent('cart-updated', {...}) so every open tab
  // (including this one) re-renders the #navCartCount badge in the nav.
  CERBERUS.getCart = function () {
    try {
      var raw = localStorage.getItem('cerberus_cart');
      var cart = raw ? JSON.parse(raw) : [];
      return Array.isArray(cart) ? cart : [];
    } catch (e) { return []; }
  };

  CERBERUS.cartCount = function () {
    var cart = CERBERUS.getCart();
    var total = 0;
    for (var i = 0; i < cart.length; i++) total += (cart[i].qty || 1);
    return total;
  };

  function renderCartBadge() {
    var badge = document.getElementById('navCartCount');
    if (!badge) return;
    var count = CERBERUS.cartCount();
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }

  function initCartBadge() {
    renderCartBadge();
    document.addEventListener('cerberus:crossEvent', function (e) {
      if (e.detail && e.detail.type === 'cart-updated') renderCartBadge();
    });
    window.addEventListener('storage', function (e) {
      if (e.key === 'cerberus_cart') renderCartBadge();
    });
  }

  // ─── SHARED COVER-TILE RENDERER ───
  // The site has zero raster images. Every "cover art" tile is a deterministic
  // CSS gradient (derived from catalog.json's gradientSeed) plus a genre glyph
  // and the game title, with a bottom scrim for legibility.
  //
  // Usage:
  //   var game = catalog[0]; // an entry from data/catalog.json
  //   el.innerHTML = CERBERUS.coverTileHTML(game, { size: 'md' });
  //
  //   // Catalog grid card:
  //   CERBERUS.coverTileHTML(game, { size: 'md' });
  //   // Cart line-item thumbnail (compact, single-line title):
  //   CERBERUS.coverTileHTML(game, { size: 'sm' });
  //   // Homepage hero / featured banner:
  //   CERBERUS.coverTileHTML(game, { size: 'lg', badge: '-40%' });
  //
  // opts: { size: 'sm'|'md'|'lg' (default 'md'), showTitle: bool (default true),
  //         badge: string|null (e.g. a discount ribbon), className: string }
  var GENRE_GLYPHS = {
    'FPS': '\u{1F3AF}',
    'RPG': '⚔️',
    'Battle Royale': '\u{1FA82}',
    'Strategy': '♟️',
    'Simulation': '\u{1F6E0}️',
    'Horror': '\u{1F47B}',
    'Racing': '\u{1F3CE}️',
    'Sports': '\u{1F3C6}',
    'Survival': '\u{1F3D5}️',
    'Fighting': '\u{1F94A}',
    'Puzzle': '\u{1F9E9}',
    'Adventure': '\u{1F5FA}️'
  };

  function injectCoverTileStyles() {
    if (document.getElementById('cerberusCoverTileStyle')) return;
    var style = document.createElement('style');
    style.id = 'cerberusCoverTileStyle';
    style.textContent =
      '.cover-tile{position:relative;overflow:hidden;width:100%;aspect-ratio:3/4;border-radius:14px;display:block;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.06);}' +
      '.cover-tile-sm{aspect-ratio:1/1;border-radius:8px;}' +
      '.cover-tile-lg{aspect-ratio:16/9;border-radius:18px;}' +
      '.cover-tile-glyph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:3rem;opacity:0.82;filter:drop-shadow(0 6px 16px rgba(0,0,0,0.35));}' +
      '.cover-tile-sm .cover-tile-glyph{font-size:1.5rem;}' +
      '.cover-tile-lg .cover-tile-glyph{font-size:4.5rem;}' +
      '.cover-tile-badge{position:absolute;top:8px;right:8px;background:rgba(5,5,7,0.75);color:#e8a020;font-family:"JetBrains Mono",monospace;font-size:0.68rem;font-weight:700;padding:3px 8px;border-radius:6px;border:1px solid rgba(232,160,32,0.35);z-index:2;}' +
      '.cover-tile-scrim{position:absolute;left:0;right:0;bottom:0;padding:10px 12px 12px;background:linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0));}' +
      '.cover-tile-title{font-family:Sora,-apple-system,sans-serif;font-weight:700;font-size:0.82rem;color:#f4f5f7;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 2px 6px rgba(0,0,0,0.5);}' +
      '.cover-tile-sm .cover-tile-title{font-size:0.64rem;-webkit-line-clamp:1;}' +
      '.cover-tile-sm .cover-tile-scrim{padding:6px 8px 8px;}' +
      '.cover-tile-lg .cover-tile-title{font-size:1.35rem;}' +
      '.cover-tile-lg .cover-tile-scrim{padding:20px 24px 24px;}';
    document.head.appendChild(style);
  }

  CERBERUS.coverTileHTML = function (game, opts) {
    opts = opts || {};
    var size = opts.size || 'md';
    var showTitle = opts.showTitle !== false;
    injectCoverTileStyles();

    var seed = (game && typeof game.gradientSeed === 'number') ? game.gradientSeed : 0;
    var hue = (seed * 47) % 360;
    var hue2 = (hue + 40) % 360;
    var bg = 'linear-gradient(135deg, hsl(' + hue + ',60%,40%) 0%, hsl(' + hue2 + ',68%,24%) 100%)';

    var genre = (game && game.genre) || '';
    var glyph = GENRE_GLYPHS[genre] || '\u{1F3AE}';
    var title = (game && game.title) ? String(game.title) : '';
    var safeTitle = title.replace(/"/g, '&quot;');

    var badgeHtml = opts.badge ? '<div class="cover-tile-badge">' + opts.badge + '</div>' : '';
    var titleHtml = showTitle ? '<div class="cover-tile-scrim"><div class="cover-tile-title">' + title + '</div></div>' : '';
    var extraClass = opts.className ? ' ' + opts.className : '';

    return '<div class="cover-tile cover-tile-' + size + extraClass + '" style="background:' + bg + '" title="' + safeTitle + '">' +
      badgeHtml +
      '<div class="cover-tile-glyph">' + glyph + '</div>' +
      titleHtml +
      '</div>';
  };

  // ─── INIT ───
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      fetchState();
      initPageTransitions();
      initToasts();
      initCommandPalette();
      initCartBadge();
    });
  } else {
    fetchState();
    initPageTransitions();
    initToasts();
    initCommandPalette();
    initCartBadge();
  }

})();
