/**
 * Cerberus Analytics Logic Engine v2
 * Single source of truth for all metrics across the site.
 * Every number derives from world config + seeded PRNG + temporal curves.
 * Features: statistical distributions, multi-timescale seeding,
 * arms race lifecycle, correlated metrics, brownian drift,
 * provider ecosystem, performance metrics, incidents, deployments.
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
    detectionCategories: [
      { name: 'Aimbot / Aim Assist',    base: 89, drift: 3 },
      { name: 'Wallhack / ESP',         base: 84, drift: 4 },
      { name: 'DMA External',           base: 72, drift: 5 },
      { name: 'Kernel Driver',          base: 78, drift: 4 },
      { name: 'Speed / Teleport',       base: 65, drift: 5 },
      { name: 'HWID Spoof',             base: 58, drift: 4 }
    ],
    diurnalCurve: [
      0.08, 0.05, 0.03, 0.03, 0.04, 0.06,
      0.10, 0.15, 0.20, 0.25, 0.30, 0.35,
      0.45, 0.55, 0.65, 0.75, 0.85, 0.92,
      1.00, 1.00, 0.95, 0.85, 0.60, 0.30
    ],
    weeklyMultipliers: [1.15, 0.88, 0.92, 0.95, 1.00, 1.08, 1.18],
    cheatProviders: [
      'PhantomOverlay', 'GhostWare', 'VoidEngine', 'NexusCheat',
      'PrismHack', 'CobaltEFI', 'HydraDMA', 'SpecterRing'
    ],
    // Brownian drift volatility per metric
    driftVolatility: {
      sessions: 8,
      npu: 1.5,
      latency: 0.15,
      cpu: 0.8,
      memory: 2,
      network: 0.5,
      queueDepth: 1.2,
      apiResponse: 0.3
    },
    // Incident root causes per category
    incidentCauses: {
      kernel: ['Driver communication timeout', 'Minifilter callback stall', 'PTE scan race condition', 'IOCTL buffer overflow protection triggered', 'Hypervisor check false alarm'],
      ai: ['Model inference latency spike', 'Feature extraction pipeline stall', 'Behavioral baseline corruption', 'ONNX runtime memory pressure', 'Input stream desync'],
      network: ['Packet integrity check timeout', 'Cross-player correlation backlog', 'WebSocket connection storm', 'Signature sync CDN failure', 'Rate limiter misconfiguration'],
      hardware: ['PCIe enumeration timeout', 'DMA timing check false positive', 'Firmware DB sync failure', 'TPM attestation timeout', 'GPU shader check stall']
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

  // ─── 1C: ARMS RACE LIFECYCLE ───

  // Phase config for the 7-day lifecycle
  var ARMS_RACE_PHASES = [
    { name: 'DETECTED',     threat: 'HIGH',     detRateMod: -6, banMod: 1.0,  sigPush: false, dayOffset: 0 },
    { name: 'ANALYSIS',     threat: 'ELEVATED',  detRateMod: -3, banMod: 1.1,  sigPush: false, dayOffset: 1 },
    { name: 'ANALYSIS',     threat: 'ELEVATED',  detRateMod: -3, banMod: 1.1,  sigPush: false, dayOffset: 2 },
    { name: 'DEPLOYING',    threat: 'ELEVATED',  detRateMod: +4, banMod: 1.6,  sigPush: true,  dayOffset: 3 },
    { name: 'DEPLOYING',    threat: 'ELEVATED',  detRateMod: +4, banMod: 1.6,  sigPush: true,  dayOffset: 4 },
    { name: 'NEUTRALIZED',  threat: 'MODERATE',  detRateMod: +2, banMod: 1.3,  sigPush: false, dayOffset: 5 },
    { name: 'NEUTRALIZED',  threat: 'MODERATE',  detRateMod: +2, banMod: 1.3,  sigPush: false, dayOffset: 6 },
    { name: 'COOLDOWN',     threat: 'LOW',       detRateMod: 0,  banMod: 1.0,  sigPush: false, dayOffset: 7 }
  ];

  var SEVERITY_MULTIPLIERS = { major: 1.5, moderate: 1.0, minor: 0.6 };

  // Find arms race events active on a given day by scanning back 3 weeks
  function _findActiveArmsRaceEvents(now) {
    now = now || new Date();
    var events = [];
    var todayMs = now.getTime();
    // Scan back 21 days for spike start days
    for (var d = 0; d <= 21; d++) {
      var checkDay = new Date(todayMs - d * 86400000);
      var ws = weekSeed(checkDay);
      // Does this week have a spike?
      if (seeded(ws * 4391) >= 0.45) continue;
      // Which day of the week?
      var spikeDay = Math.floor(seeded(ws * 5503) * 7);
      if (checkDay.getUTCDay() !== spikeDay) continue;
      // This is a spike start day
      var ds = daySeed(checkDay);
      var spikeSigs = seededInt(ds * 6607, 15, 40);
      var providerIdx = Math.floor(seeded(ds * 7703) * CONFIG.cheatProviders.length);
      var provider = CONFIG.cheatProviders[providerIdx];
      var catIdx = Math.floor(seeded(ds * 7801) * CONFIG.detectionCategories.length);
      var affectedCategory = CONFIG.detectionCategories[catIdx].name;
      var sevRoll = seeded(ds * 7901);
      var severity = sevRoll < 0.2 ? 'major' : sevRoll < 0.7 ? 'moderate' : 'minor';
      var dayOffset = d; // how many days ago the spike started

      // Only include if within lifecycle window (0-7 days)
      if (dayOffset <= 7) {
        var phase = ARMS_RACE_PHASES[Math.min(dayOffset, 7)];
        events.push({
          provider: provider,
          affectedCategory: affectedCategory,
          severity: severity,
          severityMultiplier: SEVERITY_MULTIPLIERS[severity],
          dayOffset: dayOffset,
          phaseName: phase.name,
          phase: phase,
          spikeSigs: spikeSigs,
          startDate: checkDay
        });
      }
    }
    return events;
  }

  // Main arms race function — backward compatible + new fields
  function armsRaceEvent(now) {
    now = now || new Date();
    var events = _findActiveArmsRaceEvents(now);

    if (events.length === 0) {
      return {
        isSpike: false, spikeSigs: 0, provider: null, threatLevel: 'LOW',
        phaseName: null, affectedCategory: null, severity: null, dayOffset: -1, events: []
      };
    }

    // Primary event = most recent (lowest dayOffset)
    var primary = events[0];
    for (var i = 1; i < events.length; i++) {
      if (events[i].dayOffset < primary.dayOffset) primary = events[i];
    }

    // Sigs only accumulate during DEPLOYING phase
    var effectiveSigs = (primary.phaseName === 'DEPLOYING') ?
      Math.round(primary.spikeSigs * primary.severityMultiplier) : 0;

    return {
      isSpike: true,
      spikeSigs: effectiveSigs || primary.spikeSigs, // fallback for backward compat
      provider: primary.provider,
      threatLevel: primary.phase.threat,
      phaseName: primary.phaseName,
      affectedCategory: primary.affectedCategory,
      severity: primary.severity,
      dayOffset: primary.dayOffset,
      events: events
    };
  }

  // ─── 1D: THREAT LEVEL (derived from lifecycle phase) ───
  function threatLevel(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var arc = armsRaceEvent(now);
    if (arc.isSpike) return arc.threatLevel;
    if (seeded(ds * 8807) < 0.02) return 'HIGH';
    if (seeded(ds * 9901) < 0.08) return 'MODERATE';
    return 'LOW';
  }

  // ─── DERIVED METRICS (with arms race correlation) ───

  function activeSessions(now) {
    now = now || new Date();
    var base = CONFIG.peakCCU;
    var mult = diurnalMultiplier(now) * weeklyMultiplier(now) * dayNoise(now);
    var val = Math.round(base * mult);
    val = Math.max(40, Math.min(540, val));
    return Math.round(brownianDrift('sessions', val, now));
  }

  function hourlyDetections(now) {
    now = now || new Date();
    var sessions = CONFIG.peakCCU * diurnalMultiplier(now) * weeklyMultiplier(now) * dayNoise(now);
    sessions = Math.max(40, Math.min(540, sessions));
    var cheaters = sessions * CONFIG.cheatPrevalence;
    return Math.max(0, cheaters * CONFIG.blendedDetectionRate);
  }

  function dailyDetections(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var total = 0;
    for (var h = 0; h < 24; h++) {
      var sample = new Date(now);
      sample.setUTCHours(h, 30, 0, 0);
      total += hourlyDetections(sample);
    }
    total = total * 0.15;
    var noise = (seeded(ds * 1303) - 0.5) * 6;
    // Arms race correlated detection boost
    var arc = armsRaceEvent(now);
    var spikeBoost = 0;
    if (arc.isSpike) {
      var banMod = arc.events[0] ? arc.events[0].phase.banMod : 1.0;
      var sevMult = arc.events[0] ? arc.events[0].severityMultiplier : 1.0;
      spikeBoost = Math.round((banMod - 1) * total * sevMult) + seededInt(ds * 1307, 2, 8);
    }
    var maxDet = arc.isSpike ? 50 : 38;
    return Math.max(8, Math.min(maxDet, Math.round(total + noise + spikeBoost)));
  }

  // Daily bans — uses yesterday's detections (1-day investigation lag)
  function dailyBans(now) {
    now = now || new Date();
    var yesterday = new Date(now.getTime() - 86400000);
    return Math.round(dailyDetections(yesterday) * CONFIG.autoBanRatio);
  }

  function totalBans(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    var ds = daySeed(now);
    var avgDaily = 15 + (seeded(ds * 2207) - 0.5) * 4;
    return Math.round(dsl * avgDaily);
  }

  // Signature count — sigs only accumulate during DEPLOYING phase
  function signatureCount(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var dse = daysSince(CONFIG.signatureDbEpoch, now);
    var base = CONFIG.signatureDbBase + Math.floor(dse * CONFIG.signatureDbGrowthPerDay);
    var noise = Math.floor((seeded(ds * 1709) - 0.5) * 10);
    var spikeCumulative = 0;
    for (var d = 0; d < Math.min(dse, 90); d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var pastArc = armsRaceEvent(pastDay);
      if (pastArc.isSpike && pastArc.phaseName === 'DEPLOYING') {
        spikeCumulative += Math.round(pastArc.spikeSigs * (pastArc.events[0] ? pastArc.events[0].severityMultiplier : 1));
      }
    }
    return base + noise + spikeCumulative;
  }

  function signatureDistribution(now) {
    now = now || new Date();
    var total = signatureCount(now);
    var ds = daySeed(now);
    var fresh = 0;
    for (var d = 0; d < 7; d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var arc = armsRaceEvent(pastDay);
      fresh += CONFIG.signatureDbGrowthPerDay + ((arc.isSpike && arc.phaseName === 'DEPLOYING') ? arc.spikeSigs : 0);
    }
    fresh = Math.round(fresh);
    var active = Math.round(23 * CONFIG.signatureDbGrowthPerDay);
    fresh += seededInt(ds * 3301, -2, 4);
    active += seededInt(ds * 3307, -5, 8);
    fresh = Math.max(10, fresh);
    active = Math.max(50, active);
    var legacy = Math.max(0, total - fresh - active);
    return { fresh: fresh, active: active, legacy: legacy, total: total };
  }

  // Detection rates — affected category dips during DETECTED, recovers during DEPLOYING
  function detectionRates(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var arc = armsRaceEvent(now);
    return CONFIG.detectionCategories.map(function(cat, i) {
      var drift = (seeded(ds * 307 + i * 41) - 0.5) * cat.drift * 2;
      var rate = cat.base + drift;
      // Apply arms race lifecycle modifier to affected category
      if (arc.isSpike && arc.affectedCategory === cat.name && arc.events[0]) {
        var mod = arc.events[0].phase.detRateMod * arc.events[0].severityMultiplier;
        rate += mod;
      }
      rate = Math.max(cat.base - cat.drift - 8, Math.min(cat.base + cat.drift + 5, rate));
      return { name: cat.name, rate: Math.round(rate * 10) / 10 };
    });
  }

  function banWaveSize(now) {
    now = now || new Date();
    var ds = daySeed(now);
    return Math.floor(CONFIG.banWaveMin + seeded(ds * 1889) * (CONFIG.banWaveMax - CONFIG.banWaveMin + 1));
  }

  // NPU utilization — elevated during DETECTED/ANALYSIS (extra scanning load)
  function npuUtilization(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var loadFactor = diurnalMultiplier(now);
    var base = 20 + loadFactor * 25;
    var noise = (seeded(ds * 2309) - 0.5) * 6;
    // Arms race NPU boost
    var arc = armsRaceEvent(now);
    var arcBoost = 0;
    if (arc.isSpike && (arc.phaseName === 'DETECTED' || arc.phaseName === 'ANALYSIS')) {
      arcBoost = 3 + seeded(ds * 2311) * 3; // +3-6%
    }
    var val = base + noise + arcBoost;
    val = Math.round(brownianDrift('npu', val, now) * 10) / 10;
    return Math.max(18, Math.min(52, val));
  }

  function nextEventInterval() {
    return 45000 + Math.floor(Math.random() * 255000);
  }

  function nextToastInterval() {
    return 120000 + Math.floor(Math.random() * 480000);
  }

  function pentestScenarios(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    return Math.floor(80 + dsl * 0.4);
  }

  function sessionsProtected(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    return Math.round(dsl * 300);
  }

  // ─── 1F: PROVIDER ECOSYSTEM ───
  function providerEcosystem(now) {
    now = now || new Date();
    var ws = weekSeed(now);
    var ds = daySeed(now);
    var arc = armsRaceEvent(now);
    var providers = CONFIG.cheatProviders.map(function(name, i) {
      var nameHash = 0;
      for (var c = 0; c < name.length; c++) nameHash += name.charCodeAt(c);
      var tier = (nameHash % 3) + 1;
      var actRoll = seeded(ws * 2003 + i * 41);
      var activity = actRoll < 0.3 ? 'dormant' : actRoll < 0.75 ? 'active' : 'aggressive';
      var detRoll = seeded(ds * 2103 + i * 37);
      var detection = detRoll < 0.4 ? 'detected' : detRoll < 0.65 ? 'partial' : detRoll < 0.85 ? 'monitoring' : 'undetected';
      // If this provider is the arms race target, override
      if (arc.isSpike && arc.provider === name) {
        activity = 'aggressive';
        if (arc.phaseName === 'DETECTED') detection = 'partial';
        else if (arc.phaseName === 'ANALYSIS') detection = 'partial';
        else if (arc.phaseName === 'DEPLOYING' || arc.phaseName === 'NEUTRALIZED') detection = 'detected';
      }
      return {
        name: name,
        tier: tier,
        activity: activity,
        detection: detection,
        lastSeen: seededInt(ds * 2203 + i * 53, 1, 72) + 'h ago'
      };
    });
    return providers;
  }

  // ─── 1G: PERFORMANCE METRICS SUITE ───
  function performanceMetrics(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var sessions = activeSessions(now);
    var arc = armsRaceEvent(now);
    var isArcActive = arc.isSpike;
    var arcPhase = arc.phaseName;

    // CPU: base + sessions * perSessionCost, elevated during arms race
    var cpuBase = 12 + (sessions / 540) * 18;
    if (isArcActive && (arcPhase === 'DETECTED' || arcPhase === 'ANALYSIS')) cpuBase += 4;
    var cpu = Math.round(brownianDrift('cpu', cpuBase, now) * 10) / 10;
    cpu = Math.max(8, Math.min(45, cpu));

    // Memory: base + sessions * perSessionMem
    var memBase = 180 + (sessions / 540) * 120;
    var mem = Math.round(brownianDrift('memory', memBase, now));
    mem = Math.max(150, Math.min(380, mem));

    // Network: base + sig sync burst during DEPLOYING
    var netBase = 2.4 + (sessions / 540) * 1.8;
    if (isArcActive && arcPhase === 'DEPLOYING') netBase += 1.5;
    var net = Math.round(brownianDrift('network', netBase, now) * 10) / 10;
    net = Math.max(1.0, Math.min(8.0, net));

    // Scan latency: log-normal (median 2.2ms, sigma 0.35)
    var scanLatency = logNormalSample(ds * 3001, Math.log(2.2), 0.35);
    scanLatency = Math.round(brownianDrift('latency', scanLatency, now) * 100) / 100;
    scanLatency = Math.max(1.2, Math.min(6.0, scanLatency));

    // Queue depth: correlates with detection surge
    var queueBase = 2 + (sessions / 540) * 8;
    if (isArcActive) queueBase *= arc.events[0] ? arc.events[0].phase.banMod : 1.2;
    var queueDepth = Math.round(brownianDrift('queueDepth', queueBase, now));
    queueDepth = Math.max(0, Math.min(30, queueDepth));

    // API response: log-normal, correlates with throughput
    var apiBase = logNormalSample(ds * 3101, Math.log(45), 0.3);
    var apiResponse = Math.round(brownianDrift('apiResponse', apiBase, now) * 10) / 10;
    apiResponse = Math.max(15, Math.min(120, apiResponse));

    return {
      cpu: cpu,
      memory: mem,
      network: net,
      scanLatency: scanLatency,
      queueDepth: queueDepth,
      apiResponse: apiResponse
    };
  }

  // ─── 1H: INCIDENT GENERATION ───
  function dailyIncidents(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var arc = armsRaceEvent(now);

    // Base rate: ~4% daily chance, arms race multiplier 3.5x
    var baseRate = 0.04;
    if (arc.isSpike) baseRate *= 3.5;
    var hasIncident = seeded(ds * 4001) < baseRate;
    if (!hasIncident) return [];

    var incidentCount = poissonSample(ds * 4003, arc.isSpike ? 1.8 : 0.8);
    incidentCount = Math.max(1, Math.min(3, incidentCount));
    var incidents = [];
    var categoryKeys = ['kernel', 'ai', 'network', 'hardware'];

    for (var i = 0; i < incidentCount; i++) {
      var catKey = categoryKeys[Math.floor(seeded(ds * 4101 + i * 71) * categoryKeys.length)];
      var causes = CONFIG.incidentCauses[catKey];
      var cause = causes[Math.floor(seeded(ds * 4201 + i * 37) * causes.length)];
      // Duration: log-normal (median 25min, some multi-hour)
      var durationMin = Math.round(logNormalSample(ds * 4301 + i * 53, Math.log(25), 0.6));
      durationMin = Math.max(5, Math.min(240, durationMin));
      // Severity correlates with arms race severity
      var sevRoll = seeded(ds * 4401 + i * 43);
      var severity;
      if (arc.isSpike && arc.severity === 'major') {
        severity = sevRoll < 0.4 ? 'critical' : sevRoll < 0.8 ? 'high' : 'medium';
      } else if (arc.isSpike) {
        severity = sevRoll < 0.15 ? 'critical' : sevRoll < 0.5 ? 'high' : 'medium';
      } else {
        severity = sevRoll < 0.05 ? 'critical' : sevRoll < 0.25 ? 'high' : 'medium';
      }
      // Start hour (seeded)
      var startHour = seededInt(ds * 4501 + i * 61, 0, 23);
      var startMin = seededInt(ds * 4601 + i * 67, 0, 59);
      // Affected region
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

  // ─── 1I: DEPLOYMENT PIPELINE ───
  function dailyDeployments(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var arc = armsRaceEvent(now);
    var deployments = [];

    // Signature pushes: 2-5/day baseline, more during DEPLOYING
    var sigPushCount = seededInt(ds * 5001, 2, 5);
    if (arc.isSpike && arc.phaseName === 'DEPLOYING') {
      sigPushCount += seededInt(ds * 5003, 2, 4);
    }
    for (var i = 0; i < sigPushCount; i++) {
      var hour = seededInt(ds * 5101 + i * 31, 0, 23);
      var regionIdx = Math.floor(seeded(ds * 5201 + i * 37) * CONFIG.regions.length);
      deployments.push({
        type: 'signature',
        version: 'sig-' + ds + '-' + (i + 1),
        hour: hour,
        region: CONFIG.regions[regionIdx].name,
        stage: 'complete',
        count: seededInt(ds * 5301 + i * 41, 2, 12)
      });
    }

    // Model updates: every ~14 days
    var dayCount = Math.floor(daysSince(CONFIG.launchDate, now));
    if (dayCount % 14 === 0 || (dayCount + 1) % 14 === 0) {
      deployments.push({
        type: 'model',
        version: 'bm-3.' + Math.floor(dayCount / 14) + '.' + seededInt(ds * 5401, 0, 9),
        hour: seededInt(ds * 5403, 2, 6),
        region: 'all',
        stage: dayCount % 14 === 0 ? 'rolling' : 'complete',
        count: null
      });
    }

    // Driver patches: every ~30 days
    if (dayCount % 30 === 0) {
      deployments.push({
        type: 'driver',
        version: CONFIG.engineVersion + '-p' + Math.floor(dayCount / 30),
        hour: seededInt(ds * 5501, 2, 5),
        region: 'all',
        stage: 'staged',
        count: null
      });
    }

    return deployments;
  }

  // ─── DYNAMIC TIMESTAMPS ───

  function versionAge(now) {
    now = now || new Date();
    var days = Math.floor(daysSince(CONFIG.versionReleaseDate, now));
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

  function lastHeartbeat(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var minsAgo = 1 + Math.floor(seeded(ds * 5501 + Math.floor(now.getTime() / 300000)) * 7);
    return new Date(now.getTime() - minsAgo * 60000);
  }

  // ─── FALSE POSITIVE STREAK ───
  function fpStreak(now) {
    now = now || new Date();
    var dsl = daysSince(CONFIG.launchDate, now);
    var streakDays = 0;
    for (var d = 0; d < Math.min(dsl, 60); d++) {
      var pastDay = new Date(now.getTime() - d * 86400000);
      var pastDs = daySeed(pastDay);
      if (seeded(pastDs * 6101) < 0.025) break;
      streakDays++;
    }
    return streakDays;
  }

  // ─── DAILY DIGEST ───
  function dailyDigest(now) {
    now = now || new Date();
    var yesterday = new Date(now.getTime() - 86400000);

    var todaySessions = activeSessions(now);
    var todayDetections = dailyDetections(now);
    var todayBans = dailyBans(now);
    var todayFP = seeded(daySeed(now) * 7201) < 0.025 ? seededInt(daySeed(now) * 7203, 1, 3) : 0;

    var yesterdaySessions = activeSessions(yesterday);
    var yesterdayDetections = dailyDetections(yesterday);
    var yesterdayBans = dailyBans(yesterday);
    var yesterdayFP = seeded(daySeed(yesterday) * 7201) < 0.025 ? seededInt(daySeed(yesterday) * 7203, 1, 3) : 0;

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

  // ─── CHEAT PROVIDER THREAT INTEL ───
  var providerDescriptions = {
    PhantomOverlay: 'ESP/overlay framework targeting DX11/12 games',
    GhostWare: 'Kernel-level aimbot with humanization engine',
    VoidEngine: 'DMA-based read/write framework for PCIe devices',
    NexusCheat: 'Multi-game loader with encrypted payload delivery',
    PrismHack: 'User-mode hook bypass with anti-screenshot',
    CobaltEFI: 'UEFI-persistent rootkit with driver mapping',
    HydraDMA: 'Commodity DMA hardware exploit kit',
    SpecterRing: 'Ring-0 driver mapper with certificate spoofing'
  };

  function providerThreatIntel(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var ws = weekSeed(now);
    var arc = armsRaceEvent(now);
    var providers = providerEcosystem(now);

    return providers.map(function(p, i) {
      var desc = providerDescriptions[p.name] || 'Unknown cheat framework';
      // Revenue estimate (seeded, tier-based)
      var revBase = p.tier === 1 ? 15000 : p.tier === 2 ? 8000 : 3000;
      var revEst = Math.round(revBase * (0.6 + seeded(ws * 4401 + i * 67) * 0.8));
      // Subscriber estimate
      var subBase = p.tier === 1 ? 800 : p.tier === 2 ? 350 : 120;
      var subs = Math.round(subBase * (0.5 + seeded(ds * 4501 + i * 43) * 1.0));
      // Last update (how recently did they push a new version)
      var updateHours = Math.round(2 + seeded(ds * 4601 + i * 31) * 168);
      // Threat score (0-100)
      var threatBase = p.activity === 'aggressive' ? 75 : p.activity === 'active' ? 50 : 20;
      if (p.detection === 'undetected') threatBase += 20;
      else if (p.detection === 'monitoring') threatBase += 10;
      var threat = Math.min(100, Math.max(0, Math.round(threatBase + (seeded(ds * 4701 + i * 29) - 0.5) * 20)));

      return {
        name: p.name,
        description: desc,
        tier: p.tier,
        activity: p.activity,
        detection: p.detection,
        lastSeen: p.lastSeen,
        estimatedSubs: subs,
        estimatedRevenue: revEst,
        lastUpdate: updateHours < 24 ? updateHours + 'h ago' : Math.round(updateHours / 24) + 'd ago',
        threatScore: threat
      };
    });
  }

  // ─── FP INCIDENT NARRATIVE ───
  var fpOverlays = [
    'NVIDIA GeForce Experience overlay v3.28',
    'Discord overlay (game detection module)',
    'Steam overlay (screenshot capture hook)',
    'MSI Afterburner RTSS v7.3.4',
    'AMD Adrenalin metrics overlay',
    'Overwolf platform overlay',
    'Medal.tv clip capture service',
    'Xbox Game Bar (Win11 build 26200)'
  ];
  var fpCauses = [
    'hook pattern matched unsigned code injection signature',
    'memory region permission flags triggered kernel scan',
    'DLL load timing matched known injection cadence',
    'overlay render hook flagged by behavioral heuristic'
  ];

  function fpIncidentNarrative(now) {
    now = now || new Date();
    var streak = fpStreak(now);
    // Find the last FP day (day before streak started)
    var fpDay = new Date(now.getTime() - streak * 86400000);
    var fpDs = daySeed(fpDay);
    var overlayIdx = Math.floor(seeded(fpDs * 9101) * fpOverlays.length);
    var causeIdx = Math.floor(seeded(fpDs * 9103) * fpCauses.length);
    var affected = 1 + Math.floor(seeded(fpDs * 9105) * 6);
    var responseMin = 8 + Math.floor(seeded(fpDs * 9107) * 25);

    return {
      streakDays: streak,
      lastIncident: {
        daysAgo: streak,
        overlay: fpOverlays[overlayIdx],
        cause: fpCauses[causeIdx],
        sessionsAffected: affected,
        responseMinutes: responseMin,
        resolution: 'Whitelist pushed via emergency hotfix pipeline'
      }
    };
  }

  // ─── BAN WAVE SCHEDULE ───
  function banWaveSchedule(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var ws = weekSeed(now);
    // 1-2 waves per week, on seeded days
    var waveDay1 = Math.floor(seeded(ws * 5501) * 7);
    var waveDay2 = (waveDay1 + 2 + Math.floor(seeded(ws * 5503) * 3)) % 7;
    var currentDay = now.getUTCDay();
    var isWaveDay = currentDay === waveDay1 || currentDay === waveDay2;
    // Wave hour: always during low-traffic (2-6 UTC)
    var waveHour = 2 + Math.floor(seeded(ds * 5601) * 4);
    var waveSize = isWaveDay ? banWaveSize(now) : 0;
    // Next wave
    var daysUntilNext = 0;
    for (var d = 1; d <= 7; d++) {
      var futureDay = (currentDay + d) % 7;
      if (futureDay === waveDay1 || futureDay === waveDay2) { daysUntilNext = d; break; }
    }
    if (isWaveDay) daysUntilNext = 0;

    return {
      isWaveDay: isWaveDay,
      waveHour: waveHour,
      waveSize: waveSize,
      daysUntilNext: daysUntilNext,
      waveDays: [waveDay1, waveDay2]
    };
  }

  // ─── DRIVER LOAD METRICS ───
  function driverLoadMetrics(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var sessions = sessionsProtected(now);
    var successRate = 99.4 + seeded(ds * 6601) * 0.5; // 99.4-99.9%
    var failures = Math.round(sessions * (1 - successRate / 100));
    var failReasons = [
      { reason: 'Secure Boot policy conflict', pct: 38 + Math.round(seeded(ds * 6603) * 10) },
      { reason: 'Incompatible kernel patch (KB' + (5030000 + Math.floor(seeded(ds * 6605) * 999)) + ')', pct: 0 },
      { reason: 'Third-party AV kernel hook conflict', pct: 0 },
      { reason: 'Virtualization platform interference', pct: 0 }
    ];
    // Distribute remaining percentage
    failReasons[1].pct = 25 + Math.round(seeded(ds * 6607) * 8);
    failReasons[2].pct = 20 + Math.round(seeded(ds * 6609) * 8);
    failReasons[3].pct = 100 - failReasons[0].pct - failReasons[1].pct - failReasons[2].pct;

    return {
      successRate: Math.round(successRate * 100) / 100,
      totalAttempts: sessions,
      failures: failures,
      failReasons: failReasons
    };
  }

  // ─── AMBIENT TOAST EVENTS ───
  function ambientEvents(now) {
    now = now || new Date();
    var ds = daySeed(now);
    var hour = now.getUTCHours();
    var arc = armsRaceEvent(now);
    var events = [];

    // Signature push events (2-4 per day at seeded hours)
    var sigPushCount = 2 + Math.floor(seeded(ds * 7701) * 3);
    for (var s = 0; s < sigPushCount; s++) {
      var pushHour = Math.floor(seeded(ds * 7703 + s * 41) * 24);
      var pushSigs = 3 + Math.floor(seeded(ds * 7705 + s * 37) * 12);
      events.push({
        type: 'signature',
        hour: pushHour,
        message: pushSigs + ' new signatures deployed to all regions',
        icon: '\uD83D\uDCC4'
      });
    }

    // Model update (seeded, ~every 14 days)
    if (seeded(ds * 7801) < 0.07) {
      events.push({
        type: 'model',
        hour: 6 + Math.floor(seeded(ds * 7803) * 4),
        message: 'Behavioral model weights hot-swapped — v3.' + Math.floor(seeded(ds * 7805) * 6 + 2) + '.' + Math.floor(seeded(ds * 7807) * 40),
        icon: '\uD83E\uDDE0'
      });
    }

    // Region sync events
    var syncRegion = ['US-East', 'EU-West', 'AP-Southeast'][Math.floor(seeded(ds * 7901) * 3)];
    events.push({
      type: 'sync',
      hour: (hour + 23) % 24, // always "just happened"
      message: syncRegion + ' signature cache synced — ' + Math.round(seeded(ds * 7903) * 20 + 80) + 'ms',
      icon: '\uD83D\uDD04'
    });

    // Arms race alert
    if (arc.isSpike) {
      events.push({
        type: 'threat',
        hour: hour,
        message: 'Arms race active — ' + arc.provider + ' ' + arc.phaseName.toLowerCase(),
        icon: '\u26A0\uFE0F'
      });
    }

    // Ban wave
    var wave = banWaveSchedule(now);
    if (wave.isWaveDay && hour >= wave.waveHour) {
      events.push({
        type: 'ban',
        hour: wave.waveHour,
        message: 'Ban wave executed — ' + wave.waveSize + ' accounts across ' + CONFIG.regions.length + ' regions',
        icon: '\uD83D\uDEAB'
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
    var arc = armsRaceEvent(now);
    var incidents = dailyIncidents(now);
    var deployments = dailyDeployments(now);
    var perf = performanceMetrics(now);

    var sigPushCount = 0;
    for (var i = 0; i < deployments.length; i++) {
      if (deployments[i].type === 'signature') sigPushCount++;
    }

    var isEventDay = arc.isSpike || incidents.length > 0;
    var eventIntensity = 'normal';
    if (arc.isSpike && arc.severity === 'major') eventIntensity = 'high';
    else if (arc.isSpike) eventIntensity = 'elevated';
    else if (incidents.length > 1) eventIntensity = 'elevated';

    return {
      armsRace: arc,
      incidents: incidents,
      deployments: deployments,
      performance: perf,
      isEventDay: isEventDay,
      eventIntensity: eventIntensity,
      signaturePushCount: sigPushCount,
      threatLevel: threatLevel(now)
    };
  }

  // ─── 1K: EXTENDED SNAPSHOT ───
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
      dailyDigest: dailyDigest(now),
      // New v2 fields
      performance: performanceMetrics(now),
      providers: providerEcosystem(now),
      incidents: dailyIncidents(now),
      deployments: dailyDeployments(now),
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
    providerEcosystem: providerEcosystem,
    performanceMetrics: performanceMetrics,
    dailyIncidents: dailyIncidents,
    dailyDeployments: dailyDeployments,
    dailyEventSummary: dailyEventSummary,
    providerThreatIntel: providerThreatIntel,
    fpIncidentNarrative: fpIncidentNarrative,
    banWaveSchedule: banWaveSchedule,
    driverLoadMetrics: driverLoadMetrics,
    ambientEvents: ambientEvents,
    snapshot: snapshot
  };

})();
