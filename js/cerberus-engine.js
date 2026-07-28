/**
 * Cerberus Market Analytics Logic Engine v2
 * Single source of truth for all live-marketplace metrics across the site.
 * Every number derives from world config + seeded PRNG + temporal curves.
 * Features: statistical distributions, multi-timescale seeding,
 * flash-sale lifecycle, correlated metrics, brownian drift,
 * seller ecosystem, checkout/delivery performance, incidents, restocks.
 */
(function() {
  'use strict';

  // ─── Mulberry32 PRNG ───
  function mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function seeded(seed) {
    return mulberry32(seed)();
  }

  function seededInt(seed, min, max) {
    return min + Math.floor(seeded(seed) * (max - min + 1));
  }

  // ─── 1A: STATISTICAL DISTRIBUTION HELPERS ───

  // Box-Muller transform for normal samples (deterministic via seed)
  function normalSample(seed, mean, stddev) {
    var u1 = seeded(seed);
    var u2 = seeded(seed + 7727);
    if (u1 < 0.0001) u1 = 0.0001;
    var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * stddev;
  }

  // Log-normal: exp(normal(mu, sigma))
  function logNormalSample(seed, mu, sigma) {
    return Math.exp(normalSample(seed, mu, sigma));
  }

  // Poisson via inverse transform (good for small lambda)
  function poissonSample(seed, lambda) {
    var L = Math.exp(-lambda);
    var k = 0;
    var p = 1;
    var rng = mulberry32(seed);
    do {
      k++;
      p *= rng();
    } while (p > L && k < 50);
    return k - 1;
  }

  // Beta-distributed value in [lo, hi] using Kumaraswamy approximation
  function betaSample(seed, lo, hi, a, b) {
    var u = seeded(seed);
    if (u < 0.0001) u = 0.0001;
    if (u > 0.9999) u = 0.9999;
    var x = 1 - Math.pow(1 - Math.pow(u, 1 / a), 1 / b);
    return lo + x * (hi - lo);
  }

  // ─── 1B: MULTI-TIMESCALE SEEDING ───

  function daySeed(now) {
    var d = now || new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function weekSeed(now) {
    var d = now || new Date();
    var onejan = new Date(d.getFullYear(), 0, 1);
    var weekNum = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    return d.getFullYear() * 100 + weekNum;
  }

  function hourSeed(now) {
    var d = now || new Date();
    return daySeed(d) * 100 + d.getUTCHours();
  }

  // 5-minute bucket seed for sub-hour granularity
  function minuteSeed(now) {
    var d = now || new Date();
    var bucket = Math.floor(d.getUTCMinutes() / 5);
    return hourSeed(d) * 100 + bucket;
  }

  // Cosine-interpolated smooth transition between hour buckets
  function hourInterpolated(now, seedMult, lo, hi) {
    now = now || new Date();
    var hs = hourSeed(now);
    var nextHs = hourSeed(new Date(now.getTime() + 3600000));
    var valA = lo + seeded(hs * seedMult) * (hi - lo);
    var valB = lo + seeded(nextHs * seedMult) * (hi - lo);
    var t = now.getUTCMinutes() / 60;
    return cosInterp(valA, valB, t);
  }

  function daysSince(epochMs, now) {
    now = now || new Date();
    return Math.max(0, (now.getTime() - epochMs) / 86400000);
  }

  // ─── WORLD CONFIG ───
  var CONFIG = {
    catalogSize: 22,
    sellerCount: 14,
    peakListings: 2600,
    minListings: 1200,
    restockMin: 40,
    restockMax: 160,
    baseCheckoutSuccessRate: 98.6,
    platformVersion: 'v0.5.0.0b',
    launchDate: new Date('2025-10-01').getTime(),
    regions: [
      { name: 'NA', weight: 0.42, tzOffset: -6 },
      { name: 'EU', weight: 0.36, tzOffset: 1 },
      { name: 'APAC', weight: 0.22, tzOffset: 8 }
    ],
    genres: [
      { name: 'FPS',            base: 82, drift: 5 },
      { name: 'RPG',            base: 78, drift: 6 },
      { name: 'Battle Royale',  base: 74, drift: 5 },
      { name: 'Strategy',       base: 61, drift: 4 },
      { name: 'Simulation',     base: 55, drift: 4 },
      { name: 'Horror',         base: 58, drift: 5 },
      { name: 'Racing',         base: 52, drift: 4 },
      { name: 'Sports',         base: 60, drift: 4 },
      { name: 'Survival',       base: 65, drift: 5 },
      { name: 'Fighting',       base: 48, drift: 4 },
      { name: 'Puzzle',         base: 40, drift: 3 },
      { name: 'Adventure',      base: 57, drift: 4 }
    ],
    diurnalCurve: [
      0.08, 0.05, 0.03, 0.03, 0.04, 0.06,
      0.10, 0.15, 0.20, 0.25, 0.30, 0.35,
      0.45, 0.55, 0.65, 0.75, 0.85, 0.92,
      1.00, 1.00, 0.95, 0.85, 0.60, 0.30
    ],
    weeklyMultipliers: [1.15, 0.88, 0.92, 0.95, 1.00, 1.08, 1.18],
    // Brownian drift volatility per metric
    driftVolatility: {
      listings: 40,
      buyers: 6,
      deliveryTime: 0.8,
      checkoutRate: 0.15,
      apiResponse: 6,
      queueDepth: 0.9,
      priceSync: 3
    },
    // Incident root causes per ops category
    incidentCauses: {
      payment: ['Payment gateway timeout', 'Card issuer decline spike', 'Currency conversion API stall', 'Fraud-check false positive', 'Duplicate charge auto-reversal'],
      delivery: ['Key-generation queue backlog', 'Manual delivery batch delay', 'Delivery email service outage', 'Key-pool exhaustion for high-demand title', 'Redemption server rate limiting'],
      seller: ['Seller API sync failure', 'Seller inventory feed desync', 'Bulk listing upload error', 'Seller payout batch delay'],
      infra: ['Regional CDN latency spike', 'Search index rebuild lag', 'Database replica lag', 'Cache invalidation storm', 'Load balancer health-check flap']
    }
  };

  // ─── TEMPORAL FUNCTIONS ───

  function cosInterp(a, b, t) {
    var f = (1 - Math.cos(t * Math.PI)) / 2;
    return a * (1 - f) + b * f;
  }

  function diurnalMultiplier(now) {
    now = now || new Date();
    var utcHour = now.getUTCHours();
    var utcMinute = now.getUTCMinutes();
    var total = 0;
    for (var r = 0; r < CONFIG.regions.length; r++) {
      var region = CONFIG.regions[r];
      var localHour = ((utcHour + region.tzOffset) % 24 + 24) % 24;
      var localFrac = utcMinute / 60;
      var nextHour = (localHour + 1) % 24;
      var activity = cosInterp(
        CONFIG.diurnalCurve[localHour],
        CONFIG.diurnalCurve[nextHour],
        localFrac
      );
      total += activity * region.weight;
    }
    return total;
  }

  function weeklyMultiplier(now) {
    now = now || new Date();
    return CONFIG.weeklyMultipliers[now.getUTCDay()];
  }

  function dayNoise(now) {
    var ds = daySeed(now);
    return 0.92 + seeded(ds * 7919) * 0.16;
  }

  // ─── 1E: BROWNIAN DRIFT ───
  // Smooth minute-level drift for live metrics
  function brownianDrift(metricKey, targetValue, now) {
    now = now || new Date();
    var vol = CONFIG.driftVolatility[metricKey] || 2;
    var ms = minuteSeed(now);
    var nextMs = minuteSeed(new Date(now.getTime() + 300000));
    var driftA = (seeded(ms * 3571 + metricKey.charCodeAt(0) * 17) - 0.5) * 2 * vol;
    var driftB = (seeded(nextMs * 3571 + metricKey.charCodeAt(0) * 17) - 0.5) * 2 * vol;
    var minuteInBucket = (now.getUTCMinutes() % 5) / 5 + (now.getUTCSeconds() / 300);
    var drift = cosInterp(driftA, driftB, minuteInBucket);
    return targetValue + drift;
  }

  // ─── 1C: FLASH-SALE / RESTOCK LIFECYCLE ───

  // Phase config for the 7-day lifecycle
  var SALE_PHASES = [
    { name: 'ANNOUNCED',   heat: 'MODERATE', discountMod: 0,  demandMod: 1.05, dayOffset: 0 },
    { name: 'LIVE',        heat: 'SURGE',    discountMod: 25, demandMod: 1.6,  dayOffset: 1 },
    { name: 'LIVE',        heat: 'SURGE',    discountMod: 30, demandMod: 1.7,  dayOffset: 2 },
    { name: 'LIVE',        heat: 'ELEVATED', discountMod: 22, demandMod: 1.4,  dayOffset: 3 },
    { name: 'ENDING_SOON', heat: 'ELEVATED', discountMod: 15, demandMod: 1.2,  dayOffset: 4 },
    { name: 'ENDED',       heat: 'MODERATE', discountMod: 0,  demandMod: 1.0,  dayOffset: 5 },
    { name: 'COOLDOWN',    heat: 'LOW',      discountMod: 0,  demandMod: 1.0,  dayOffset: 6 }
  ];

  var TIER_MULTIPLIERS = { mega: 1.6, standard: 1.0, micro: 0.55 };

  // Find flash-sale events active on a given day by scanning back 3 weeks
  function _findActiveSaleEvents(now) {
    now = now || new Date();
    var events = [];
    var todayMs = now.getTime();
    // Scan back 21 days for sale start days
    for (var d = 0; d <= 21; d++) {
      var checkDay = new Date(todayMs - d * 86400000);
      var ws = weekSeed(checkDay);
      // Does this week have a sale?
      if (seeded(ws * 4391) >= 0.45) continue;
      // Which day of the week?
      var startDayOfWeek = Math.floor(seeded(ws * 5503) * 7);
      if (checkDay.getUTCDay() !== startDayOfWeek) continue;
      // This is a sale start day
      var ds = daySeed(checkDay);
      var featuredIndex = Math.floor(seeded(ds * 6607) * CONFIG.catalogSize);
      var genreIndex = Math.floor(seeded(ds * 6611) * CONFIG.genres.length);
      var baseDiscount = seededInt(ds * 6701, 15, 55);
      var tierRoll = seeded(ds * 7901);
      var tier = tierRoll < 0.2 ? 'mega' : tierRoll < 0.7 ? 'standard' : 'micro';
      var dayOffset = d; // how many days ago the sale started

      // Only include if within lifecycle window (0-6 days)
      if (dayOffset <= 6) {
        var phase = SALE_PHASES[Math.min(dayOffset, 6)];
        events.push({
          featuredIndex: featuredIndex,
          genreIndex: genreIndex,
          tier: tier,
          tierMultiplier: TIER_MULTIPLIERS[tier],
          baseDiscount: baseDiscount,
          dayOffset: dayOffset,
          phaseName: phase.name,
          phase: phase,
          startDate: checkDay
        });
      }
    }
    return events;
  }

  // Main flash-sale function
  function flashSaleEvent(now) {
    now = now || new Date();
    var events = _findActiveSaleEvents(now);

    if (events.length === 0) {
      return {
        isActive: false, discountPct: 0, featuredIndex: null, genreIndex: null,
        demandLevel: 'LOW', phaseName: null, phase: null, tier: null, tierMultiplier: null,
        dayOffset: -1, events: []
      };
    }

    // Primary event = most recent (lowest dayOffset)
    var primary = events[0];
    for (var i = 1; i < events.length; i++) {
      if (events[i].dayOffset < primary.dayOffset) primary = events[i];
    }

    var jitter = (primary.baseDiscount - 35) * 0.3;
    var discountPct = Math.round((primary.phase.discountMod + jitter) * primary.tierMultiplier);
    discountPct = Math.max(0, Math.min(75, discountPct));

    return {
      isActive: true,
      discountPct: discountPct,
      featuredIndex: primary.featuredIndex,
      genreIndex: primary.genreIndex,
      demandLevel: primary.phase.heat,
      phaseName: primary.phaseName,
      phase: primary.phase,
      tier: primary.tier,
      tierMultiplier: primary.tierMultiplier,
      dayOffset: primary.dayOffset,
      events: events
    };
  }

  // ─── 1D: DEMAND LEVEL (derived from lifecycle phase) ───
  function demandLevel(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var sale = flashSaleEvent(now);
    if (sale.isActive) return sale.demandLevel;
    if (seeded(ds * 8807) < 0.015) return 'ELEVATED';
    if (seeded(ds * 9901) < 0.10) return 'MODERATE';
    return 'LOW';
  }

  // ─── DERIVED METRICS (with flash-sale correlation) ───

  function activeListings(now) {
    now = now || new Date();
    var base = CONFIG.peakListings;
    var mult = diurnalMultiplier(now) * weeklyMultiplier(now) * dayNoise(now);
    var val = Math.round(base * mult);
    val = Math.max(CONFIG.minListings, Math.min(CONFIG.peakListings, val));
    return Math.round(brownianDrift('listings', val, now));
  }

  function onlineBuyers(now) {
    now = now || new Date();
    var base = 170;
    var mult = diurnalMultiplier(now) * weeklyMultiplier(now) * dayNoise(now);
    var val = Math.round(base * mult);
    val = Math.max(40, Math.min(180, val));
    return Math.round(brownianDrift('buyers', val, now));
  }

  function hourlyOrders(now) {
    now = now || new Date();
    var listings = CONFIG.peakListings * diurnalMultiplier(now) * weeklyMultiplier(now) * dayNoise(now);
    listings = Math.max(CONFIG.minListings, Math.min(CONFIG.peakListings, listings));
    var conversionRate = 0.0055;
    return Math.max(0, listings * conversionRate);
  }

  function dailyOrdersPlaced(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var total = 0;
    for (var h = 0; h < 24; h++) {
      var sample = new Date(now);
      sample.setUTCHours(h, 30, 0, 0);
      total += hourlyOrders(sample);
    }
    var noise = (seeded(ds * 1303) - 0.5) * 20;
    // Flash-sale correlated demand boost
    var sale = flashSaleEvent(now);
    var demandBoost = 0;
    if (sale.isActive) {
      demandBoost = Math.round((sale.phase.demandMod - 1) * total) + seededInt(ds * 1307, 5, 25);
    }
    var maxOrders = sale.isActive ? 320 : 260;
    return Math.max(60, Math.min(maxOrders, Math.round(total + noise + demandBoost)));
  }

  // Keys delivered — uses today's orders confirmed with a short fulfillment lag
  function dailyKeysDelivered(now) {
    now = now || new Date();
    var yesterday = new Date(now.getTime() - 86400000);
    var rate = 0.93 + seeded(daySeed(now) * 2209) * 0.05;
    return Math.round(dailyOrdersPlaced(yesterday) * rate);
  }

  function totalKeysSold(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    var ds = daySeed(now);
    var avgDaily = 150 + (seeded(ds * 2207) - 0.5) * 40;
    return Math.round(dsl * avgDaily);
  }

  // Listing freshness distribution — fresh listings correlate with restock boosts during LIVE phase
  function listingsFreshness(now) {
    now = now || new Date();
    var total = activeListings(now);
    var ds = daySeed(now);
    var fresh = 0;
    for (var d = 0; d < 7; d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var pastDs = daySeed(pastDay);
      var dailyNew = 30 + seeded(pastDs * 1709) * 35;
      var sale = flashSaleEvent(pastDay);
      if (sale.isActive && sale.phaseName === 'LIVE') {
        dailyNew += dailyNew * 0.6 * sale.tierMultiplier;
      }
      fresh += dailyNew;
    }
    fresh = Math.round(fresh);
    fresh = Math.min(fresh, Math.round(total * 0.45));
    fresh = Math.max(Math.round(total * 0.05), fresh);
    var active = Math.round(total * 0.38) + seededInt(ds * 3307, -30, 40);
    active = Math.max(Math.round(total * 0.2), active);
    var legacy = Math.max(0, total - fresh - active);
    return { fresh: fresh, active: active, legacy: legacy, total: total };
  }

  // Genre demand — featured genre dips/spikes with the flash-sale lifecycle
  function genreDemand(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var sale = flashSaleEvent(now);
    return CONFIG.genres.map(function(g, i) {
      var drift = (seeded(ds * 307 + i * 41) - 0.5) * g.drift * 2;
      var score = g.base + drift;
      if (sale.isActive && sale.genreIndex === i && sale.phaseName === 'LIVE') {
        score += (sale.phase.demandMod - 1) * 40;
      }
      score = Math.max(g.base - g.drift - 8, Math.min(g.base + g.drift + 15, score));
      return { name: g.name, score: Math.round(score * 10) / 10 };
    });
  }

  function restockBatchSize(now) {
    now = now || new Date();
    var ds = daySeed(now);
    return Math.floor(CONFIG.restockMin + seeded(ds * 1889) * (CONFIG.restockMax - CONFIG.restockMin + 1));
  }

  function nextEventInterval() {
    return 45000 + Math.floor(Math.random() * 255000);
  }

  function nextToastInterval() {
    return 120000 + Math.floor(Math.random() * 480000);
  }

  function fraudChecksPerformed(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    return Math.floor(400 + dsl * 3.2);
  }

  function buyerProtectionClaims(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    return Math.round(dsl * 155);
  }

  // ─── 1F: SELLER ECOSYSTEM ───
  function sellerEcosystem(now) {
    now = now || new Date();
    var ws = weekSeed(now);
    var ds = daySeed(now);
    var sellers = [];
    for (var i = 0; i < CONFIG.sellerCount; i++) {
      var tierRoll = seeded(ws * 2003 + i * 41);
      var tier = tierRoll < 0.15 ? 'top' : tierRoll < 0.55 ? 'verified' : 'standard';
      var actRoll = seeded(ds * 2103 + i * 37);
      var status = actRoll < 0.4 ? 'away' : actRoll < 0.8 ? 'active' : 'active now';
      var repScore = Math.round(betaSample(ds * 2203 + i * 53, 82, 99.6, 3, 1.4) * 10) / 10;
      var lastActiveHours = seededInt(ds * 2303 + i * 53, 0, 48);
      sellers.push({
        index: i,
        tier: tier,
        status: status,
        reputation: repScore,
        lastActive: status === 'active now' ? 'online now' : lastActiveHours + 'h ago'
      });
    }
    return sellers;
  }

  // ─── 1G: CHECKOUT / DELIVERY PERFORMANCE SUITE ───
  function performanceMetrics(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var listings = activeListings(now);
    var sale = flashSaleEvent(now);
    var loadRatio = listings / CONFIG.peakListings;

    // Key delivery time: log-normal (median ~10s), elevated slightly during LIVE
    var deliveryBase = logNormalSample(ds * 3001, Math.log(10), 0.3);
    if (sale.isActive && sale.phaseName === 'LIVE') deliveryBase *= 1.15;
    var avgDeliveryTime = Math.round(brownianDrift('deliveryTime', deliveryBase, now) * 10) / 10;
    avgDeliveryTime = Math.max(3, Math.min(45, avgDeliveryTime));

    // Checkout success: base minus load pressure, dips slightly during LIVE surges
    var checkoutBase = CONFIG.baseCheckoutSuccessRate - loadRatio * 0.8;
    if (sale.isActive && sale.phaseName === 'LIVE') checkoutBase -= 0.6 * sale.tierMultiplier;
    var checkoutSuccessRate = Math.round(brownianDrift('checkoutRate', checkoutBase, now) * 100) / 100;
    checkoutSuccessRate = Math.max(97, Math.min(99.7, checkoutSuccessRate));

    // Payment gateway API response: log-normal
    var apiBase = logNormalSample(ds * 3101, Math.log(140), 0.25);
    var paymentApiResponse = Math.round(brownianDrift('apiResponse', apiBase, now));
    paymentApiResponse = Math.max(60, Math.min(400, paymentApiResponse));

    // Delivery queue depth: correlates with demand surge
    var queueBase = 1 + loadRatio * 6;
    if (sale.isActive) queueBase *= sale.phase.demandMod;
    var deliveryQueueDepth = Math.round(brownianDrift('queueDepth', queueBase, now));
    deliveryQueueDepth = Math.max(0, Math.min(40, deliveryQueueDepth));

    // Regional price-sync latency
    var syncBase = 40 + loadRatio * 30;
    var priceSyncLatency = Math.round(brownianDrift('priceSync', syncBase, now));
    priceSyncLatency = Math.max(20, Math.min(180, priceSyncLatency));

    return {
      avgDeliveryTime: avgDeliveryTime,
      checkoutSuccessRate: checkoutSuccessRate,
      paymentApiResponse: paymentApiResponse,
      deliveryQueueDepth: deliveryQueueDepth,
      priceSyncLatency: priceSyncLatency
    };
  }

  // ─── 1H: INCIDENT GENERATION ───
  function dailyIncidents(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var sale = flashSaleEvent(now);

    // Base rate: ~4% daily chance, flash-sale multiplier while LIVE
    var baseRate = 0.04;
    if (sale.isActive && sale.phaseName === 'LIVE') baseRate *= 3.0;
    var hasIncident = seeded(ds * 4001) < baseRate;
    if (!hasIncident) return [];

    var incidentCount = poissonSample(ds * 4003, sale.isActive ? 1.6 : 0.8);
    incidentCount = Math.max(1, Math.min(3, incidentCount));
    var incidents = [];
    var categoryKeys = ['payment', 'delivery', 'seller', 'infra'];

    for (var i = 0; i < incidentCount; i++) {
      var catKey = categoryKeys[Math.floor(seeded(ds * 4101 + i * 71) * categoryKeys.length)];
      var causes = CONFIG.incidentCauses[catKey];
      var cause = causes[Math.floor(seeded(ds * 4201 + i * 37) * causes.length)];
      // Duration: log-normal (median 20min, some multi-hour)
      var durationMin = Math.round(logNormalSample(ds * 4301 + i * 53, Math.log(20), 0.6));
      durationMin = Math.max(5, Math.min(180, durationMin));
      // Severity correlates with sale tier
      var sevRoll = seeded(ds * 4401 + i * 43);
      var severity;
      if (sale.isActive && sale.tier === 'mega') {
        severity = sevRoll < 0.35 ? 'critical' : sevRoll < 0.75 ? 'high' : 'medium';
      } else if (sale.isActive) {
        severity = sevRoll < 0.12 ? 'critical' : sevRoll < 0.45 ? 'high' : 'medium';
      } else {
        severity = sevRoll < 0.04 ? 'critical' : sevRoll < 0.22 ? 'high' : 'medium';
      }
      var startHour = seededInt(ds * 4501 + i * 61, 0, 23);
      var startMin = seededInt(ds * 4601 + i * 67, 0, 59);
      var regionIdx = Math.floor(seeded(ds * 4701 + i * 73) * CONFIG.regions.length);

      incidents.push({
        category: catKey,
        cause: cause,
        severity: severity,
        durationMinutes: durationMin,
        startHour: startHour,
        startMinute: startMin,
        region: CONFIG.regions[regionIdx].name,
        resolved: true
      });
    }
    return incidents;
  }

  // ─── 1I: RESTOCK / OPS PIPELINE ───
  function dailyRestocks(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var sale = flashSaleEvent(now);
    var events = [];

    // Listing restocks: 2-5/day baseline, more while a sale is LIVE
    var restockCount = seededInt(ds * 5001, 2, 5);
    if (sale.isActive && sale.phaseName === 'LIVE') {
      restockCount += seededInt(ds * 5003, 2, 5);
    }
    for (var i = 0; i < restockCount; i++) {
      var hour = seededInt(ds * 5101 + i * 31, 0, 23);
      var regionIdx = Math.floor(seeded(ds * 5201 + i * 37) * CONFIG.regions.length);
      events.push({
        type: 'restock',
        hour: hour,
        region: CONFIG.regions[regionIdx].name,
        stage: 'complete',
        count: seededInt(ds * 5301 + i * 41, 15, 90)
      });
    }

    // Price-index recalibration: every ~14 days
    var dayCount = Math.floor(daysSince(CONFIG.launchDate, now));
    if (dayCount % 14 === 0 || (dayCount + 1) % 14 === 0) {
      events.push({
        type: 'price-recalibration',
        hour: seededInt(ds * 5403, 2, 6),
        region: 'all',
        stage: dayCount % 14 === 0 ? 'rolling' : 'complete',
        count: null
      });
    }

    // Platform feature release: every ~30 days
    if (dayCount % 30 === 0) {
      events.push({
        type: 'feature-release',
        hour: seededInt(ds * 5501, 2, 5),
        region: 'all',
        stage: 'staged',
        count: null
      });
    }

    return events;
  }

  // ─── DYNAMIC TIMESTAMPS ───

  function platformAge(now) {
    now = now || new Date();
    var days = Math.floor(daysSince(CONFIG.launchDate, now));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }

  function relativeTime(timestampMs, now) {
    now = now || new Date();
    var diff = now.getTime() - timestampMs;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return days + 'd ago';
  }

  // Scheduled payment-processor maintenance window
  function nextMaintenance(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var daysAhead = 3 + Math.floor(seeded(ds * 4409) * 5);
    var hour = 2 + Math.floor(seeded(ds * 4507) * 4);
    var d = new Date(now);
    d.setUTCDate(d.getUTCDate() + daysAhead);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  }

  // Last regional price sync
  function lastHeartbeat(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var minsAgo = 1 + Math.floor(seeded(ds * 5501 + Math.floor(now.getTime() / 300000)) * 7);
    return new Date(now.getTime() - minsAgo * 60000);
  }

  // ─── DISPUTE-FREE STREAK ───
  function disputeFreeStreak(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    var streakDays = 0;
    for (var d = 0; d < Math.min(dsl, 90); d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var pastDs = daySeed(pastDay);
      if (seeded(pastDs * 6101) < 0.02) break;
      streakDays++;
    }
    return streakDays;
  }

  // ─── DAILY DIGEST ───
  function dailyDigest(now) {
    now = now || new Date();
    var yesterday = new Date(now.getTime() - 86400000);

    var todayListings = activeListings(now);
    var todaySales = dailyOrdersPlaced(now);
    var todayDelivered = dailyKeysDelivered(now);
    var todayDisputes = seeded(daySeed(now) * 7201) < 0.02 ? seededInt(daySeed(now) * 7203, 1, 3) : 0;

    var yesterdayListings = activeListings(yesterday);
    var yesterdaySales = dailyOrdersPlaced(yesterday);
    var yesterdayDelivered = dailyKeysDelivered(yesterday);
    var yesterdayDisputes = seeded(daySeed(yesterday) * 7201) < 0.02 ? seededInt(daySeed(yesterday) * 7203, 1, 3) : 0;

    var recentSales = 0, priorSales = 0;
    var recentListings = 0, priorListings = 0;
    for (var d = 0; d < 7; d++) {
      var r = new Date(now.getTime() - d * 86400000);
      var p = new Date(now.getTime() - (d + 7) * 86400000);
      recentSales += dailyOrdersPlaced(r);
      priorSales += dailyOrdersPlaced(p);
      recentListings += activeListings(r);
      priorListings += activeListings(p);
    }
    var salesTrend = priorSales > 0 ? Math.round((recentSales / priorSales - 1) * 100) : 0;
    var listingsTrend = priorListings > 0 ? Math.round((recentListings / priorListings - 1) * 100) : 0;

    var narrative = '';
    if (salesTrend > 10) narrative = 'high demand this week';
    else if (salesTrend < -10) narrative = 'demand cooling off';
    else if (listingsTrend > 8) narrative = 'sellers restocking heavily';
    else narrative = 'stable baseline';

    return {
      today: { sales: todaySales, listings: todayListings, delivered: todayDelivered, disputes: todayDisputes },
      yesterday: { sales: yesterdaySales, listings: yesterdayListings, delivered: yesterdayDelivered, disputes: yesterdayDisputes },
      trend: { sales: salesTrend, listings: listingsTrend, narrative: narrative }
    };
  }

  // ─── LAB-LOG / DEV-LOG PROGRESS ───
  function labProgress(entryIndex, now) {
    now = now || new Date();
    var ds = daySeed(now);
    return Math.round(seeded(ds * 8101 + entryIndex * 137) * 20) / 10;
  }

  function labLastUpdate(entryIndex, now) {
    now = now || new Date();
    var ds = daySeed(now);
    var hoursAgo = 1 + Math.floor(seeded(ds * 8201 + entryIndex * 53) * 18);
    return new Date(now.getTime() - hoursAgo * 3600000);
  }

  // ─── REGION-SPECIFIC UPTIME ───
  function regionUptime(serviceId, regionIndex, dayOffset, now) {
    now = now || new Date();
    var ds = daySeed(new Date(now.getTime() - dayOffset * 86400000));
    var roll = seeded(ds * 1013 + serviceId * 307 + regionIndex * 53);
    return roll < 0.05 ? 'degraded' : 'operational';
  }

  // ─── SELLER INSIGHTS (extended per-seller stats) ───
  function sellerInsights(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var ws = weekSeed(now);
    var sellers = sellerEcosystem(now);

    return sellers.map(function(s, i) {
      var salesBase = s.tier === 'top' ? 420 : s.tier === 'verified' ? 180 : 60;
      var salesVolume = Math.round(salesBase * (0.6 + seeded(ws * 4401 + i * 67) * 0.8));
      var avgRating = Math.min(5, Math.round((4.2 + seeded(ds * 4501 + i * 43) * 0.75) * 10) / 10);
      var avgResponseMinutes = Math.round(2 + seeded(ds * 4601 + i * 31) * 40);

      return {
        index: s.index,
        tier: s.tier,
        status: s.status,
        reputation: s.reputation,
        lastActive: s.lastActive,
        salesVolume: salesVolume,
        avgRating: avgRating,
        avgResponseMinutes: avgResponseMinutes
      };
    });
  }

  // ─── DISPUTE INCIDENT NARRATIVE ───
  var disputeCauses = [
    'buyer claimed key was already redeemed',
    'region-lock mismatch flagged at redemption',
    'delayed manual delivery past SLA window',
    'duplicate order created by a checkout retry'
  ];

  function disputeIncidentNarrative(now) {
    now = now || new Date();
    var streak = disputeFreeStreak(now);
    var incidentDay = new Date(now.getTime() - streak * 86400000);
    var ds = daySeed(incidentDay);
    var causeIdx = Math.floor(seeded(ds * 9103) * disputeCauses.length);
    var affected = 1 + Math.floor(seeded(ds * 9105) * 4);
    var responseMin = 10 + Math.floor(seeded(ds * 9107) * 30);

    return {
      streakDays: streak,
      lastIncident: {
        daysAgo: streak,
        cause: disputeCauses[causeIdx],
        ordersAffected: affected,
        responseMinutes: responseMin,
        resolution: 'Refund issued and replacement key delivered'
      }
    };
  }

  // ─── SELLER PAYOUT SCHEDULE ───
  function payoutSchedule(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var ws = weekSeed(now);
    // 2 payout runs per week, on seeded days
    var payoutDay1 = Math.floor(seeded(ws * 5501) * 7);
    var payoutDay2 = (payoutDay1 + 3 + Math.floor(seeded(ws * 5503) * 2)) % 7;
    var currentDay = now.getUTCDay();
    var isPayoutDay = currentDay === payoutDay1 || currentDay === payoutDay2;
    var payoutHour = 2 + Math.floor(seeded(ds * 5601) * 4);
    var payoutCount = isPayoutDay ? seededInt(ds * 5701, Math.round(CONFIG.sellerCount * 0.4), CONFIG.sellerCount) : 0;
    var daysUntilNext = 0;
    for (var d = 1; d <= 7; d++) {
      var futureDay = (currentDay + d) % 7;
      if (futureDay === payoutDay1 || futureDay === payoutDay2) { daysUntilNext = d; break; }
    }
    if (isPayoutDay) daysUntilNext = 0;

    return {
      isPayoutDay: isPayoutDay,
      payoutHour: payoutHour,
      payoutCount: payoutCount,
      daysUntilNext: daysUntilNext,
      payoutDays: [payoutDay1, payoutDay2]
    };
  }

  // ─── KEY REDEMPTION METRICS ───
  function keyRedemptionMetrics(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var attempts = dailyKeysDelivered(now) * (2 + Math.round(seeded(ds * 6601) * 2));
    var successRate = 97.8 + seeded(ds * 6603) * 1.8;
    var failures = Math.round(attempts * (1 - successRate / 100));
    var failReasons = [
      { reason: 'Region-locked key mismatch', pct: 0 },
      { reason: 'Duplicate redemption attempt', pct: 0 },
      { reason: 'Platform account linking failure', pct: 0 },
      { reason: 'Key formatting / typo error', pct: 0 }
    ];
    failReasons[0].pct = 30 + Math.round(seeded(ds * 6605) * 10);
    failReasons[1].pct = 25 + Math.round(seeded(ds * 6607) * 8);
    failReasons[2].pct = 20 + Math.round(seeded(ds * 6609) * 8);
    failReasons[3].pct = 100 - failReasons[0].pct - failReasons[1].pct - failReasons[2].pct;

    return {
      successRate: Math.round(successRate * 100) / 100,
      totalAttempts: attempts,
      failures: failures,
      failReasons: failReasons
    };
  }

  // ─── AMBIENT TOAST EVENTS ───
  function ambientEvents(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var hour = now.getUTCHours();
    var sale = flashSaleEvent(now);
    var events = [];

    // Restock events (2-4 per day at seeded hours)
    var restockCount = 2 + Math.floor(seeded(ds * 7701) * 3);
    for (var s = 0; s < restockCount; s++) {
      var pushHour = Math.floor(seeded(ds * 7703 + s * 41) * 24);
      var pushCount = 10 + Math.floor(seeded(ds * 7705 + s * 37) * 60);
      events.push({
        type: 'restock',
        hour: pushHour,
        message: pushCount + ' new listings added across the marketplace',
        icon: '📦'
      });
    }

    // Seller verification (seeded, occasional)
    if (seeded(ds * 7801) < 0.07) {
      events.push({
        type: 'seller-verified',
        hour: 6 + Math.floor(seeded(ds * 7803) * 4),
        message: 'A seller just completed identity verification',
        icon: '✅'
      });
    }

    // Region price-sync events
    var syncRegion = CONFIG.regions[Math.floor(seeded(ds * 7901) * CONFIG.regions.length)].name;
    events.push({
      type: 'sync',
      hour: (hour + 23) % 24, // always "just happened"
      message: syncRegion + ' price cache synced — ' + Math.round(seeded(ds * 7903) * 40 + 60) + 'ms',
      icon: '🔄'
    });

    // Flash-sale alert
    if (sale.isActive && sale.phaseName === 'LIVE') {
      events.push({
        type: 'sale',
        hour: hour,
        message: 'Flash sale live — up to ' + sale.discountPct + '% off the featured title',
        icon: '⚡'
      });
    }

    // Rolling sales ticker
    var salesLastHour = 3 + Math.floor(seeded(ds * 7905 + hour * 13) * 18);
    events.push({
      type: 'sales-tick',
      hour: hour,
      message: salesLastHour + ' keys sold in the last hour',
      icon: '🛒'
    });

    // Seller payouts
    var payout = payoutSchedule(now);
    if (payout.isPayoutDay && hour >= payout.payoutHour) {
      events.push({
        type: 'payout',
        hour: payout.payoutHour,
        message: 'Seller payouts processed — ' + payout.payoutCount + ' sellers across ' + CONFIG.regions.length + ' regions',
        icon: '💰'
      });
    }

    // Sort by proximity to current hour
    events.sort(function(a, b) {
      return Math.abs(a.hour - hour) - Math.abs(b.hour - hour);
    });

    return events;
  }

  // ─── 1J: UNIFIED DAILY EVENT SUMMARY ───
  function dailyEventSummary(now) {
    now = now || new Date();
    var sale = flashSaleEvent(now);
    var incidents = dailyIncidents(now);
    var restocks = dailyRestocks(now);
    var perf = performanceMetrics(now);

    var restockPushCount = 0;
    for (var i = 0; i < restocks.length; i++) {
      if (restocks[i].type === 'restock') restockPushCount++;
    }

    var isEventDay = sale.isActive || incidents.length > 0;
    var eventIntensity = 'normal';
    if (sale.isActive && sale.tier === 'mega') eventIntensity = 'high';
    else if (sale.isActive) eventIntensity = 'elevated';
    else if (incidents.length > 1) eventIntensity = 'elevated';

    return {
      flashSale: sale,
      incidents: incidents,
      restocks: restocks,
      performance: perf,
      isEventDay: isEventDay,
      eventIntensity: eventIntensity,
      restockPushCount: restockPushCount,
      demandLevel: demandLevel(now)
    };
  }

  // ─── 1K: EXTENDED SNAPSHOT ───
  function snapshot(now) {
    now = now || new Date();
    var sale = flashSaleEvent(now);
    return {
      activeListings: activeListings(now),
      onlineBuyers: onlineBuyers(now),
      dailyOrdersPlaced: dailyOrdersPlaced(now),
      dailyKeysDelivered: dailyKeysDelivered(now),
      totalKeysSold: totalKeysSold(now),
      listingsFreshness: listingsFreshness(now),
      genreDemand: genreDemand(now),
      restockBatchSize: restockBatchSize(now),
      catalogSize: CONFIG.catalogSize,
      sellerCount: CONFIG.sellerCount,
      regions: CONFIG.regions.length,
      platformVersion: CONFIG.platformVersion,
      fraudChecksPerformed: fraudChecksPerformed(now),
      buyerProtectionClaims: buyerProtectionClaims(now),
      nextEventInterval: nextEventInterval(),
      nextToastInterval: nextToastInterval(),
      flashSale: sale,
      demandLevel: demandLevel(now),
      disputeFreeStreak: disputeFreeStreak(now),
      platformAge: platformAge(now),
      nextMaintenance: nextMaintenance(now),
      lastHeartbeat: lastHeartbeat(now),
      dailyDigest: dailyDigest(now),
      performance: performanceMetrics(now),
      sellers: sellerEcosystem(now),
      incidents: dailyIncidents(now),
      restocks: dailyRestocks(now),
      dailyEventSummary: dailyEventSummary(now)
    };
  }

  // ─── PUBLIC API ───
  window.CerberusEngine = {
    CONFIG: CONFIG,
    seeded: seeded,
    seededInt: seededInt,
    daySeed: daySeed,
    weekSeed: weekSeed,
    hourSeed: hourSeed,
    minuteSeed: minuteSeed,
    mulberry32: mulberry32,
    normalSample: normalSample,
    logNormalSample: logNormalSample,
    poissonSample: poissonSample,
    betaSample: betaSample,
    cosInterp: cosInterp,
    hourInterpolated: hourInterpolated,
    brownianDrift: brownianDrift,
    diurnalMultiplier: diurnalMultiplier,
    weeklyMultiplier: weeklyMultiplier,
    activeListings: activeListings,
    onlineBuyers: onlineBuyers,
    dailyOrdersPlaced: dailyOrdersPlaced,
    dailyKeysDelivered: dailyKeysDelivered,
    totalKeysSold: totalKeysSold,
    listingsFreshness: listingsFreshness,
    genreDemand: genreDemand,
    restockBatchSize: restockBatchSize,
    demandLevel: demandLevel,
    flashSaleEvent: flashSaleEvent,
    nextEventInterval: nextEventInterval,
    nextToastInterval: nextToastInterval,
    fraudChecksPerformed: fraudChecksPerformed,
    buyerProtectionClaims: buyerProtectionClaims,
    platformAge: platformAge,
    relativeTime: relativeTime,
    nextMaintenance: nextMaintenance,
    lastHeartbeat: lastHeartbeat,
    disputeFreeStreak: disputeFreeStreak,
    dailyDigest: dailyDigest,
    labProgress: labProgress,
    labLastUpdate: labLastUpdate,
    regionUptime: regionUptime,
    sellerEcosystem: sellerEcosystem,
    performanceMetrics: performanceMetrics,
    dailyIncidents: dailyIncidents,
    dailyRestocks: dailyRestocks,
    dailyEventSummary: dailyEventSummary,
    sellerInsights: sellerInsights,
    disputeIncidentNarrative: disputeIncidentNarrative,
    payoutSchedule: payoutSchedule,
    keyRedemptionMetrics: keyRedemptionMetrics,
    ambientEvents: ambientEvents,
    snapshot: snapshot
  };

})();
