(function() {
  'use strict';
  var CS = {};
  window.CerberusStochastic = CS;

  // ─── Helpers ───

  // Seeded random (deterministic) - same sine-based approach used elsewhere
  CS.seeded = function(seed) {
    var x = Math.sin(seed) * 43758.5453;
    return x - Math.floor(x);
  };

  // Day seed - consistent value per calendar day
  CS.daySeed = function() {
    var d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };

  // ─── Multipliers ───

  // Time-of-day multiplier (24 values representing hourly traffic patterns)
  // This reuses the existing todMultipliers pattern from analytics
  CS._todMultipliers = [
    0.3, 0.25, 0.2, 0.2, 0.25, 0.3,   // 00-05: Dead hours
    0.5, 0.7, 0.9, 1.0, 1.1, 1.2,     // 06-11: Morning ramp
    1.3, 1.4, 1.5, 1.6, 1.6, 1.5,     // 12-17: Peak hours (Asia+EU)
    1.4, 1.3, 1.2, 1.0, 0.7, 0.5      // 18-23: NA peak then decline
  ];

  CS.diurnalMultiplier = function(hour) {
    hour = (hour === undefined) ? new Date().getUTCHours() : hour;
    return CS._todMultipliers[hour % 24];
  };

  // Day-of-week multiplier (weekend boost)
  CS.weeklyMultiplier = function(dayOfWeek) {
    dayOfWeek = (dayOfWeek === undefined) ? new Date().getUTCDay() : dayOfWeek;
    // 0=Sun, 6=Sat
    var mults = [1.2, 0.9, 0.95, 1.0, 1.0, 1.1, 1.2];
    return mults[dayOfWeek];
  };

  // Arms race cycle - exponential recovery with oscillation
  // Models the pattern: bypass detected -> analysis -> sigs deploy -> neutralized
  CS.armsRaceCycle = function(daysSinceLastWave) {
    var d = Math.max(0, daysSinceLastWave);
    return 0.2 + 0.7 * (1 - Math.exp(-d / 8)) * (1 + 0.1 * Math.sin(d * 0.3));
  };

  // Arms race stage name (0-3)
  CS.armsRaceStage = function(daysSinceLastWave) {
    var d = Math.max(0, daysSinceLastWave);
    if (d <= 1) return { stage: 0, label: 'BYPASS DETECTED', color: '#e04050' };
    if (d <= 3) return { stage: 1, label: 'ANALYSIS', color: '#e87830' };
    if (d <= 6) return { stage: 2, label: 'SIGS DEPLOYING', color: '#e8a020' };
    return { stage: 3, label: 'NEUTRALIZED', color: '#30c860' };
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

  // Generate NPU utilization (15-55%, hour-based with noise)
  CS.npuUtilization = function(hour, seed) {
    var base = 25 + CS.diurnalMultiplier(hour) * 20;
    var noise = (CS.seeded(seed || CS.daySeed() * 201) - 0.5) * 10;
    return CS.clamp(Math.round((base + noise) * 10) / 10, 15, 55);
  };

  // Generate ML confidence (94-99%)
  CS.mlConfidence = function(seed) {
    var base = 96.5;
    var noise = (CS.seeded(seed || CS.daySeed() * 301) - 0.5) * 3;
    return CS.clamp(Math.round((base + noise) * 100) / 100, 94, 99);
  };

  // Generate DMA anomalies count (0-8)
  CS.dmaAnomalies = function(hour, seed) {
    var base = CS.diurnalMultiplier(hour) * 4;
    var noise = CS.seeded(seed || CS.daySeed() * 401) * 3;
    return CS.clamp(Math.floor(base + noise), 0, 8);
  };

  // Generate obfuscation integrity (99.8-100%)
  CS.obfuscationIntegrity = function(seed) {
    var base = 99.92;
    var noise = (CS.seeded(seed || CS.daySeed() * 501) - 0.5) * 0.15;
    return CS.clamp(Math.round((base + noise) * 100) / 100, 99.8, 100);
  };

  // Generate behavioral model version string
  CS.behavioralModelVersion = function(seed) {
    var s = CS.seeded(seed || CS.daySeed() * 601);
    var major = 7;
    var minor = Math.floor(s * 6); // 0-5
    var patch = Math.floor(CS.seeded((seed || CS.daySeed()) * 602) * 20);
    return 'bm-' + major + '.' + minor + '.' + patch;
  };

  // Generate PCIe firmware DB size (growing counter)
  // Base at a reference date, grows ~2-5 per day
  CS.pcieFirmwareDbSize = function() {
    var ref = new Date('2026-01-01').getTime();
    var now = Date.now();
    var daysSinceRef = (now - ref) / 86400000;
    var base = 1200;
    var growth = Math.floor(daysSinceRef * 3.5);
    var noise = Math.floor(CS.seeded(CS.daySeed() * 701) * 5);
    return base + growth + noise;
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
