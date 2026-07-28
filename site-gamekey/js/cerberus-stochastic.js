(function() {
  'use strict';
  var CS = {};
  window.CerberusStochastic = CS;

  // ─── Helpers (delegate to CerberusEngine when available) ───

  CS.seeded = function(seed) {
    if (window.CerberusEngine) return CerberusEngine.seeded(seed);
    var x = Math.sin(seed) * 43758.5453;
    return x - Math.floor(x);
  };

  CS.daySeed = function() {
    if (window.CerberusEngine) return CerberusEngine.daySeed();
    var d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };

  // ─── Multipliers ───

  // Time-of-day multiplier (24 values representing hourly marketplace traffic)
  CS._todMultipliers = [
    0.3, 0.25, 0.2, 0.2, 0.25, 0.3,   // 00-05: Dead hours
    0.5, 0.7, 0.9, 1.0, 1.1, 1.2,     // 06-11: Morning ramp
    1.3, 1.4, 1.5, 1.6, 1.6, 1.5,     // 12-17: Peak hours (APAC+EU)
    1.4, 1.3, 1.2, 1.0, 0.7, 0.5      // 18-23: NA peak then decline
  ];

  CS.diurnalMultiplier = function(hour) {
    hour = (hour === undefined) ? new Date().getUTCHours() : hour;
    return CS._todMultipliers[hour % 24];
  };

  // Day-of-week multiplier (weekend shopping boost)
  CS.weeklyMultiplier = function(dayOfWeek) {
    dayOfWeek = (dayOfWeek === undefined) ? new Date().getUTCDay() : dayOfWeek;
    // 0=Sun, 6=Sat
    var mults = [1.2, 0.9, 0.95, 1.0, 1.0, 1.1, 1.2];
    return mults[dayOfWeek];
  };

  // Flash-sale cycle - exponential recovery with oscillation
  // Models the pattern: sale announced -> live -> ending soon -> cooldown -> next drop
  CS.saleCycle = function(daysSinceLastSale) {
    var d = Math.max(0, daysSinceLastSale);
    return 0.2 + 0.7 * (1 - Math.exp(-d / 8)) * (1 + 0.1 * Math.sin(d * 0.3));
  };

  // Flash-sale stage name (0-3)
  CS.saleStage = function(daysSinceLastSale) {
    var d = Math.max(0, daysSinceLastSale);
    if (d <= 1) return { stage: 0, label: 'SALE LIVE', color: '#30c860' };
    if (d <= 2) return { stage: 1, label: 'ENDING SOON', color: '#e8a020' };
    if (d <= 4) return { stage: 2, label: 'COOLDOWN', color: '#e87830' };
    return { stage: 3, label: 'AWAITING NEXT DROP', color: '#7a8290' };
  };

  // Brownian random walk - smooth step toward a target with noise
  CS.brownianStep = function(current, target, stepSize, seed) {
    var noise = (CS.seeded(seed) - 0.5) * 2; // -1 to 1
    var drift = (target - current) * 0.1; // Pull toward target
    return current + drift + noise * stepSize;
  };

  // Composite multiplier combining all factors
  CS.compositeMultiplier = function(hour, dayOfWeek, seed) {
    var tod = CS.diurnalMultiplier(hour);
    var dow = CS.weeklyMultiplier(dayOfWeek);
    var noise = 0.95 + CS.seeded(seed || CS.daySeed()) * 0.1; // 0.95-1.05
    return tod * dow * noise;
  };

  // ─── Generators ───

  // Generate a value within range, influenced by time of day
  CS.timeAwareValue = function(base, variance, hour, seed) {
    var mult = CS.diurnalMultiplier(hour);
    var noise = CS.seeded(seed || CS.daySeed()) * variance;
    return Math.round(base * mult + noise);
  };

  // Clamp a value within bounds
  CS.clamp = function(val, min, max) {
    return Math.max(min, Math.min(max, val));
  };

  // Price index - normalized average catalog price relative to list price
  // (100 = full price, lower = deeper average discounting across the site)
  CS.priceIndex = function(seed) {
    if (window.CerberusEngine) {
      var sale = CerberusEngine.flashSaleEvent();
      var base = sale.isActive ? (100 - sale.discountPct * 0.6) : 92;
      return CS.clamp(Math.round(base * 10) / 10, 55, 100);
    }
    var base = 90 - CS.diurnalMultiplier() * 3;
    var noise = (CS.seeded(seed || CS.daySeed() * 201) - 0.5) * 6;
    return CS.clamp(Math.round((base + noise) * 10) / 10, 55, 100);
  };

  // Category (genre) popularity score for a given category index (0-11)
  CS.categoryPopularity = function(categoryIndex, seed) {
    categoryIndex = categoryIndex || 0;
    var base = 50 + CS.diurnalMultiplier() * 8;
    var noise = (CS.seeded(seed || CS.daySeed() * 401 + categoryIndex * 17) - 0.5) * 22;
    return CS.clamp(Math.round(base + noise), 20, 96);
  };

  // Deal confidence score (94-99) - rough "how good is this deal" indicator
  CS.dealConfidence = function(seed) {
    var base = 96.5;
    var noise = (CS.seeded(seed || CS.daySeed() * 301) - 0.5) * 3;
    return CS.clamp(Math.round((base + noise) * 100) / 100, 94, 99);
  };

  // "Keys sold today" hourly time-series (24 values)
  CS.hourlySalesSeries = function(now) {
    now = now || new Date();
    var ds = window.CerberusEngine ? CerberusEngine.daySeed(now) : CS.daySeed();
    var series = [];
    for (var h = 0; h < 24; h++) {
      var tod = CS.diurnalMultiplier(h);
      var val = Math.round(tod * 9 + CS.seeded(ds * 601 + h * 13) * 5);
      series.push(CS.clamp(val, 0, 22));
    }
    return series;
  };

  // Total catalog entries ever listed (growing counter, includes sold/expired)
  CS.catalogSizeGrowth = function() {
    var ref = new Date('2025-10-01').getTime();
    var now = Date.now();
    var daysSinceRef = (now - ref) / 86400000;
    var base = 850;
    var growth = Math.floor(daysSinceRef * 0.45);
    var noise = Math.floor(CS.seeded(CS.daySeed() * 701) * 4);
    return base + growth + noise;
  };

  // Platform build version string, consistent with engine
  CS.platformVersion = function() {
    if (window.CerberusEngine) return CerberusEngine.CONFIG.platformVersion;
    return 'v0.5.0.0b';
  };

  // Format a relative time string
  CS.relativeTime = function(timestamp) {
    var diff = Date.now() - new Date(timestamp).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  };

})();
