/**
 * Cerberus Analytics Logic Engine
 * Single source of truth for all metrics across the site.
 * Every number derives from world config + seeded PRNG + temporal curves.
 */
(function() {
  'use strict';

  // ─── Mulberry32 PRNG (better distribution than Math.sin hack) ───
  function mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Seeded random: returns [0, 1) for a given seed
  function seeded(seed) {
    return mulberry32(seed)();
  }

  // Seeded integer in [min, max] inclusive
  function seededInt(seed, min, max) {
    return min + Math.floor(seeded(seed) * (max - min + 1));
  }

  // Day seed — consistent value per calendar day
  function daySeed(now) {
    var d = now || new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  // Week seed — consistent value per calendar week
  function weekSeed(now) {
    var d = now || new Date();
    var onejan = new Date(d.getFullYear(), 0, 1);
    var weekNum = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    return d.getFullYear() * 100 + weekNum;
  }

  // Days since epoch (ms timestamp to day count)
  function daysSince(epochMs, now) {
    now = now || new Date();
    return Math.max(0, (now.getTime() - epochMs) / 86400000);
  }

  // ─── WORLD CONFIG (central truth) ───
  var CONFIG = {
    games: 3,
    avgConcurrentPerGame: 160,
    peakCCU: 480,
    cheatPrevalence: 0.035,
    falsePositiveRate: 0.0014,
    blendedDetectionRate: 0.78,
    regions: [
      { name: 'US-East', weight: 0.40, tzOffset: -5 },
      { name: 'EU-West', weight: 0.35, tzOffset: 1 },
      { name: 'AP-Southeast', weight: 0.25, tzOffset: 8 }
    ],
    banWaveMin: 5,
    banWaveMax: 15,
    autoBanRatio: 0.65,
    behavioralModel: 'bm-3.1.4',
    engineVersion: 'v0.4.2.0b',
    versionReleaseDate: new Date('2026-05-12').getTime(),
    signatureDbBase: 4200,
    signatureDbGrowthPerDay: 3.5,
    signatureDbEpoch: new Date('2025-10-01').getTime(),
    launchDate: new Date('2025-10-01').getTime(),
    // Detection rates per category (realistic beta range 58-92%)
    detectionCategories: [
      { name: 'Aimbot / Aim Assist',    base: 89, drift: 3 },
      { name: 'Wallhack / ESP',         base: 84, drift: 4 },
      { name: 'DMA External',           base: 72, drift: 5 },
      { name: 'Kernel Driver',          base: 78, drift: 4 },
      { name: 'Speed / Teleport',       base: 65, drift: 5 },
      { name: 'HWID Spoof',             base: 58, drift: 4 }
    ],
    // Diurnal curves per region (local hour -> activity weight)
    // Gaming peaks: ~18-23 local time
    diurnalCurve: [
      0.08, 0.05, 0.03, 0.03, 0.04, 0.06,  // 00-05
      0.10, 0.15, 0.20, 0.25, 0.30, 0.35,  // 06-11
      0.45, 0.55, 0.65, 0.75, 0.85, 0.92,  // 12-17
      1.00, 1.00, 0.95, 0.85, 0.60, 0.30   // 18-23
    ],
    weeklyMultipliers: [1.15, 0.88, 0.92, 0.95, 1.00, 1.08, 1.18], // Sun-Sat
    // Cheat provider names for arms race events
    cheatProviders: [
      'PhantomOverlay', 'GhostWare', 'VoidEngine', 'NexusCheat',
      'PrismHack', 'CobaltEFI', 'HydraDMA', 'SpecterRing'
    ]
  };

  // ─── TEMPORAL FUNCTIONS ───

  // Cosine interpolation between two values
  function cosInterp(a, b, t) {
    var f = (1 - Math.cos(t * Math.PI)) / 2;
    return a * (1 - f) + b * f;
  }

  // Composite diurnal multiplier from 3 regions' local gaming peaks
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
      // Cosine interpolation between current and next hour
      var activity = cosInterp(
        CONFIG.diurnalCurve[localHour],
        CONFIG.diurnalCurve[nextHour],
        localFrac
      );
      total += activity * region.weight;
    }
    return total;
  }

  // Weekly multiplier
  function weeklyMultiplier(now) {
    now = now || new Date();
    return CONFIG.weeklyMultipliers[now.getUTCDay()];
  }

  // Day noise — small daily variation
  function dayNoise(now) {
    var ds = daySeed(now);
    return 0.92 + seeded(ds * 7919) * 0.16; // 0.92 - 1.08
  }

  // ─── ARMS RACE EVENTS ───
  // ~2 days per month, signatures spike 15-40 instead of 3-4.
  // Returns { isSpike, spikeSigs, provider, threatLevel } for a given day.
  function armsRaceEvent(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var ws = weekSeed(now);
    // Each week has a seeded chance of containing a spike day
    var weekHasSpike = seeded(ws * 4391) < 0.45; // ~45% of weeks -> ~2 per month
    if (!weekHasSpike) {
      return { isSpike: false, spikeSigs: 0, provider: null, threatLevel: 'LOW' };
    }
    // Which day of the week is the spike? (0-6)
    var spikeDay = Math.floor(seeded(ws * 5503) * 7);
    var todayDow = (now || new Date()).getUTCDay();
    if (todayDow !== spikeDay) {
      return { isSpike: false, spikeSigs: 0, provider: null, threatLevel: 'LOW' };
    }
    // Spike day!
    var spikeSigs = seededInt(ds * 6607, 15, 40);
    var providerIdx = Math.floor(seeded(ds * 7703) * CONFIG.cheatProviders.length);
    var provider = CONFIG.cheatProviders[providerIdx];
    return {
      isSpike: true,
      spikeSigs: spikeSigs,
      provider: provider,
      threatLevel: 'ELEVATED'
    };
  }

  // Threat level for the day (considers arms race + random degradation)
  function threatLevel(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var arc = armsRaceEvent(now);
    if (arc.isSpike) return 'ELEVATED';
    // Small chance of HIGH on non-spike days (rare, ~2% of days)
    if (seeded(ds * 8807) < 0.02) return 'HIGH';
    // ~8% chance of MODERATE
    if (seeded(ds * 9901) < 0.08) return 'MODERATE';
    return 'LOW';
  }

  // ─── DERIVED METRICS ───

  function activeSessions(now) {
    now = now || new Date();
    var base = CONFIG.peakCCU;
    var mult = diurnalMultiplier(now) * weeklyMultiplier(now) * dayNoise(now);
    var val = Math.round(base * mult);
    // Clamp to realistic range
    return Math.max(40, Math.min(540, val));
  }

  // Hourly detection count (for computing daily totals)
  function hourlyDetections(now) {
    now = now || new Date();
    var sessions = activeSessions(now);
    var cheaters = sessions * CONFIG.cheatPrevalence;
    var detected = cheaters * CONFIG.blendedDetectionRate;
    return Math.max(0, detected);
  }

  // Daily detections — integrate over 24 hours using seeded samples
  function dailyDetections(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var total = 0;
    for (var h = 0; h < 24; h++) {
      var sample = new Date(now);
      sample.setUTCHours(h, 30, 0, 0);
      total += hourlyDetections(sample);
    }
    // Scale the integrated sum to daily unique detections (beta scale)
    // The integration gives ~140 which represents hourly concurrent detections summed;
    // actual unique detections per day are much lower due to session overlap.
    total = total * 0.15;
    // Add day-specific noise
    var noise = (seeded(ds * 1303) - 0.5) * 6;
    // Arms race spike days get a detection burst
    var arc = armsRaceEvent(now);
    var spikeBoost = arc.isSpike ? seededInt(ds * 1307, 4, 12) : 0;
    var maxDet = arc.isSpike ? 50 : 38;
    return Math.max(8, Math.min(maxDet, Math.round(total + noise + spikeBoost)));
  }

  // Daily bans (subset of detections)
  function dailyBans(now) {
    return Math.round(dailyDetections(now) * CONFIG.autoBanRatio);
  }

  // Total bans since launch
  function totalBans(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    // Average ~15 bans/day, with some variation
    var ds = daySeed(now);
    var avgDaily = 15 + (seeded(ds * 2207) - 0.5) * 4;
    return Math.round(dsl * avgDaily);
  }

  // Signature DB count — includes arms race spikes
  function signatureCount(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var dse = daysSince(CONFIG.signatureDbEpoch, now);
    var base = CONFIG.signatureDbBase + Math.floor(dse * CONFIG.signatureDbGrowthPerDay);
    var noise = Math.floor((seeded(ds * 1709) - 0.5) * 10);
    // Add cumulative spike sigs: walk back over recent days and count spike contributions
    var spikeCumulative = 0;
    for (var d = 0; d < Math.min(dse, 90); d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var pastArc = armsRaceEvent(pastDay);
      if (pastArc.isSpike) {
        spikeCumulative += pastArc.spikeSigs;
      }
    }
    return base + noise + spikeCumulative;
  }

  // Signature age distribution
  function signatureDistribution(now) {
    now = now || new Date();
    var total = signatureCount(now);
    var ds = daySeed(now);
    // Fresh sigs: accumulate last 7 days of growth + any spikes
    var fresh = 0;
    for (var d = 0; d < 7; d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var arc = armsRaceEvent(pastDay);
      fresh += CONFIG.signatureDbGrowthPerDay + (arc.isSpike ? arc.spikeSigs : 0);
    }
    fresh = Math.round(fresh);
    // Active sigs: days 7-30
    var active = Math.round(23 * CONFIG.signatureDbGrowthPerDay);
    // Add some noise
    fresh += seededInt(ds * 3301, -2, 4);
    active += seededInt(ds * 3307, -5, 8);
    fresh = Math.max(10, fresh);
    active = Math.max(50, active);
    var legacy = Math.max(0, total - fresh - active);
    return { fresh: fresh, active: active, legacy: legacy, total: total };
  }

  // Per-category detection rates (58-92% range)
  function detectionRates(now) {
    now = now || new Date();
    var ds = daySeed(now);
    return CONFIG.detectionCategories.map(function(cat, i) {
      var drift = (seeded(ds * 307 + i * 41) - 0.5) * cat.drift * 2;
      var rate = cat.base + drift;
      rate = Math.max(cat.base - cat.drift, Math.min(cat.base + cat.drift, rate));
      return { name: cat.name, rate: Math.round(rate * 10) / 10 };
    });
  }

  // Ban wave size (5-15)
  function banWaveSize(now) {
    now = now || new Date();
    var ds = daySeed(now);
    return Math.floor(CONFIG.banWaveMin + seeded(ds * 1889) * (CONFIG.banWaveMax - CONFIG.banWaveMin + 1));
  }

  // NPU utilization (20-45%, scaled by load)
  function npuUtilization(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var loadFactor = diurnalMultiplier(now);
    var base = 20 + loadFactor * 25;
    var noise = (seeded(ds * 2309) - 0.5) * 6;
    var val = Math.round((base + noise) * 10) / 10;
    return Math.max(18, Math.min(48, val));
  }

  // Next event interval for feed (45s - 5min)
  function nextEventInterval() {
    return 45000 + Math.floor(Math.random() * 255000); // 45s to 5min
  }

  // Next toast interval (2-10min)
  function nextToastInterval() {
    return 120000 + Math.floor(Math.random() * 480000); // 2min to 10min
  }

  // Number of pentest scenarios (grows slowly from launch)
  function pentestScenarios(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    return Math.floor(80 + dsl * 0.4);
  }

  // Sessions protected counter (cumulative, grows from launch)
  function sessionsProtected(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    // ~300 sessions/day average
    return Math.round(dsl * 300);
  }

  // ─── DYNAMIC TIMESTAMPS ───

  // Version age: "X days ago" from version release date
  function versionAge(now) {
    now = now || new Date();
    var days = Math.floor(daysSince(CONFIG.versionReleaseDate, now));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }

  // Relative time string from millisecond timestamp
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

  // Next scheduled maintenance: always 3-7 days in the future (seeded)
  function nextMaintenance(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var daysAhead = 3 + Math.floor(seeded(ds * 4409) * 5); // 3-7 days
    var hour = 2 + Math.floor(seeded(ds * 4507) * 4); // 02:00-05:00 UTC
    var d = new Date(now);
    d.setUTCDate(d.getUTCDate() + daysAhead);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  }

  // Simulated "last heartbeat" — within-day, seeded minutes ago
  function lastHeartbeat(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var minuteFrac = now.getMinutes() / 60;
    // Heartbeat happened 1-8 minutes ago, drifts with real time
    var minsAgo = 1 + Math.floor(seeded(ds * 5501 + Math.floor(now.getTime() / 300000)) * 7);
    return new Date(now.getTime() - minsAgo * 60000);
  }

  // ─── FALSE POSITIVE STREAK ───
  // Days since last false positive incident. Resets every ~30-45 days (seeded).
  function fpStreak(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var dsl = daysSince(CONFIG.launchDate, now);
    // Walk backwards to find last FP incident day
    var streakDays = 0;
    for (var d = 0; d < Math.min(dsl, 60); d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var pastDs = daySeed(pastDay);
      // ~2.5% chance per day of a FP incident -> average streak ~30-40 days
      if (seeded(pastDs * 6101) < 0.025) {
        break;
      }
      streakDays++;
    }
    return streakDays;
  }

  // ─── DAILY DIGEST (yesterday vs today comparison) ───
  function dailyDigest(now) {
    now = now || new Date();
    var yesterday = new Date(now.getTime() - 86400000);
    var weekAgo = new Date(now.getTime() - 7 * 86400000);

    var todaySessions = activeSessions(now);
    var todayDetections = dailyDetections(now);
    var todayBans = dailyBans(now);
    var todayFP = seeded(daySeed(now) * 7201) < 0.025 ? seededInt(daySeed(now) * 7203, 1, 3) : 0;

    var yesterdaySessions = activeSessions(yesterday);
    var yesterdayDetections = dailyDetections(yesterday);
    var yesterdayBans = dailyBans(yesterday);
    var yesterdayFP = seeded(daySeed(yesterday) * 7201) < 0.025 ? seededInt(daySeed(yesterday) * 7203, 1, 3) : 0;

    // 7-day trend: average of last 7 days vs previous 7 days
    var recentSessions = 0, priorSessions = 0;
    var recentDetections = 0, priorDetections = 0;
    for (var d = 0; d < 7; d++) {
      var r = new Date(now.getTime() - d * 86400000);
      var p = new Date(now.getTime() - (d + 7) * 86400000);
      recentSessions += activeSessions(r);
      priorSessions += activeSessions(p);
      recentDetections += dailyDetections(r);
      priorDetections += dailyDetections(p);
    }
    var sessionTrend = priorSessions > 0 ? Math.round((recentSessions / priorSessions - 1) * 100) : 0;
    var detectionTrend = priorDetections > 0 ? Math.round((recentDetections / priorDetections - 1) * 100) : 0;

    // Trend narrative
    var narrative = '';
    if (detectionTrend < -5) narrative = 'signature push effective';
    else if (detectionTrend > 10) narrative = 'new cheat variant detected';
    else if (sessionTrend > 5) narrative = 'player base growing';
    else narrative = 'stable baseline';

    return {
      today: { sessions: todaySessions, detections: todayDetections, bans: todayBans, fp: todayFP },
      yesterday: { sessions: yesterdaySessions, detections: yesterdayDetections, bans: yesterdayBans, fp: yesterdayFP },
      trend: { sessions: sessionTrend, detections: detectionTrend, narrative: narrative }
    };
  }

  // ─── LAB-LOG PROGRESS ───
  // Returns seeded progress increment for a lab entry on a given day
  function labProgress(entryIndex, now) {
    now = now || new Date();
    var ds = daySeed(now);
    // Each entry gets 0-2% progress per day (seeded)
    return Math.round(seeded(ds * 8101 + entryIndex * 137) * 20) / 10; // 0.0 - 2.0
  }

  // Simulated last-update time for lab entries (hours ago, within-day)
  function labLastUpdate(entryIndex, now) {
    now = now || new Date();
    var ds = daySeed(now);
    var hoursAgo = 1 + Math.floor(seeded(ds * 8201 + entryIndex * 53) * 18); // 1-18 hours ago
    return new Date(now.getTime() - hoursAgo * 3600000);
  }

  // ─── REGION-SPECIFIC UPTIME ───
  // Independent degradation per service per region
  function regionUptime(serviceId, regionIndex, dayOffset, now) {
    now = now || new Date();
    var ds = daySeed(new Date(now.getTime() - dayOffset * 86400000));
    var roll = seeded(ds * 1013 + serviceId * 307 + regionIndex * 53);
    // ~5% chance per day per region per service of degradation
    return roll < 0.05 ? 'degraded' : 'operational';
  }

  // Full snapshot of all metrics at a point in time
  function snapshot(now) {
    now = now || new Date();
    var arc = armsRaceEvent(now);
    return {
      activeSessions: activeSessions(now),
      dailyDetections: dailyDetections(now),
      dailyBans: dailyBans(now),
      totalBans: totalBans(now),
      signatureCount: signatureCount(now),
      signatureDistribution: signatureDistribution(now),
      detectionRates: detectionRates(now),
      banWaveSize: banWaveSize(now),
      npuUtilization: npuUtilization(now),
      falsePositiveRate: CONFIG.falsePositiveRate * 100,
      blendedDetectionRate: CONFIG.blendedDetectionRate * 100,
      behavioralModel: CONFIG.behavioralModel,
      engineVersion: CONFIG.engineVersion,
      games: CONFIG.games,
      regions: CONFIG.regions.length,
      pentestScenarios: pentestScenarios(now),
      sessionsProtected: sessionsProtected(now),
      nextEventInterval: nextEventInterval(),
      nextToastInterval: nextToastInterval(),
      armsRace: arc,
      threatLevel: threatLevel(now),
      fpStreak: fpStreak(now),
      versionAge: versionAge(now),
      nextMaintenance: nextMaintenance(now),
      lastHeartbeat: lastHeartbeat(now),
      dailyDigest: dailyDigest(now)
    };
  }

  // ─── PUBLIC API ───
  window.CerberusEngine = {
    CONFIG: CONFIG,
    seeded: seeded,
    seededInt: seededInt,
    daySeed: daySeed,
    weekSeed: weekSeed,
    mulberry32: mulberry32,
    diurnalMultiplier: diurnalMultiplier,
    weeklyMultiplier: weeklyMultiplier,
    activeSessions: activeSessions,
    dailyDetections: dailyDetections,
    dailyBans: dailyBans,
    totalBans: totalBans,
    signatureCount: signatureCount,
    signatureDistribution: signatureDistribution,
    detectionRates: detectionRates,
    banWaveSize: banWaveSize,
    npuUtilization: npuUtilization,
    nextEventInterval: nextEventInterval,
    nextToastInterval: nextToastInterval,
    pentestScenarios: pentestScenarios,
    sessionsProtected: sessionsProtected,
    armsRaceEvent: armsRaceEvent,
    threatLevel: threatLevel,
    fpStreak: fpStreak,
    versionAge: versionAge,
    relativeTime: relativeTime,
    nextMaintenance: nextMaintenance,
    lastHeartbeat: lastHeartbeat,
    dailyDigest: dailyDigest,
    labProgress: labProgress,
    labLastUpdate: labLastUpdate,
    regionUptime: regionUptime,
    snapshot: snapshot
  };

})();
