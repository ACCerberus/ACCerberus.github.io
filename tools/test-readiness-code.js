#!/usr/bin/env node
'use strict';
/*
 * tools/test-readiness-code.js — proves the readiness code is one format, not two.
 *
 *   node tools/test-readiness-code.js         encoder/decoder round-trips + README vector
 *   node tools/test-readiness-code.js --ps    also runs the real PowerShell script and
 *                                             checks its code against the JS decoder
 *
 * The PowerShell encoder and the JavaScript decoder are separate implementations
 * of the same 60-bit layout. If they ever disagree, a player's code decodes to
 * the wrong advice on the website — so this checks them against each other on
 * real output from this machine, not against a fixture.
 *
 * --ps asserts *consistency*, never a particular verdict. On a machine without
 * Secure Boot, SECURE_BOOT legitimately fails; run non-elevated and TEST_SIGNING
 * is legitimately skipped. Both are correct results and the test must pass.
 *
 * No dependencies. Node 18+.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const R = require(path.join(ROOT, 'js', 'cerberus-readiness.js'));

const PS_SCRIPT = path.join(ROOT, 'tools', 'packages', 'readiness-check', 'Cerberus-ReadinessCheck.ps1');
const README = path.join(ROOT, 'tools', 'packages', 'readiness-check', 'README.md');
const CONFIG = path.join(ROOT, 'tools', 'releases.config.json');

const RUN_PS = process.argv.includes('--ps');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ok    ' + name);
  } else {
    failed += 1;
    console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

/* --------------------------------------------------- 1. round-trip fuzz */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundTrips() {
  section('Round-trips (200 random field sets)');

  const rand = mulberry32(20260909);
  const pick = (n) => Math.floor(rand() * n);
  const seen = new Set();
  let mismatches = 0;
  let badDecodes = 0;
  let verdictMismatches = 0;

  for (let i = 0; i < 200; i++) {
    const statuses = [];
    for (let k = 0; k < 14; k++) {
      statuses.push(R.STATUS_NAMES[pick(4)]);
    }
    const fields = {
      statuses: statuses,
      ramBucket: pick(9),
      diskBucket: pick(6),
      driverCount: pick(16),
      tpm: pick(3),
      osClass: pick(7)
    };

    const code = R.encode(fields);
    seen.add(code);

    if (!/^CRC1-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code)) {
      badDecodes += 1;
      continue;
    }

    const d = R.decode(code);
    if (!d.ok) {
      badDecodes += 1;
      continue;
    }

    const same =
      d.statuses.join(',') === statuses.join(',') &&
      d.system.ramBucket === fields.ramBucket &&
      d.system.diskBucket === fields.diskBucket &&
      d.system.driverCount === fields.driverCount &&
      d.system.tpm === fields.tpm &&
      d.system.osClass === fields.osClass &&
      d.version === R.VERSION &&
      d.reserved === 0;
    if (!same) { mismatches += 1; }

    if (d.verdict !== R.verdictOf(statuses)) { verdictMismatches += 1; }

    /* Normalisation: lowercase, no dashes, no prefix, O/I/L folded. */
    const mangled = code.replace(/-/g, '').toLowerCase().replace(/^crc1/, '');
    const d2 = R.decode(mangled);
    if (!d2.ok || d2.code !== code) { badDecodes += 1; }
  }

  check('200/200 field sets encode to a well-formed code', badDecodes === 0,
        badDecodes + ' code(s) failed to decode or normalise');
  check('200/200 field sets survive encode -> decode intact', mismatches === 0,
        mismatches + ' mismatch(es)');
  check('verdict rule agrees on every set', verdictMismatches === 0,
        verdictMismatches + ' mismatch(es)');
  check('codes are well distributed (no accidental collisions)', seen.size === 200,
        seen.size + ' distinct codes from 200 field sets');
}

/* ----------------------------------------------------- 2. rejection cases */

function rejections() {
  section('Rejection');

  const good = R.encode({
    statuses: new Array(14).fill('PASS'),
    ramBucket: 5, diskBucket: 4, driverCount: 2, tpm: 2, osClass: 4
  });

  check('a valid code is accepted', R.decode(good).ok === true);
  check('empty input is rejected', R.decode('').error === 'EMPTY');
  check('truncated code is rejected', R.decode('CRC1-2000-003T').ok === false,
        'got ' + JSON.stringify(R.decode('CRC1-2000-003T')));
  check('a code missing three symbols is rejected on length',
        R.decode('CRC1-2000-003T-EM').error === 'LENGTH');
  check('long code is rejected', R.decode(good + 'ZZ').error === 'LENGTH');
  check('a bare 12-symbol body still decodes', R.decode(R.normalize(good)).ok === true);
  check('a body that happens to start with CRC1 is not mis-stripped',
        R.normalize('CRC1' + R.normalize(good).slice(4)).length === 12);
  check('illegal symbol is rejected', R.decode('CRC1-2000-003U-EM1$').ok === false);

  /* Flip one symbol in the payload; the checksum must catch it. */
  let caught = 0;
  const body = R.normalize(good);
  for (let i = 0; i < 12; i++) {
    for (let s = 0; s < R.ALPHABET.length; s++) {
      const ch = R.ALPHABET[s];
      if (ch === body[i]) { continue; }
      const mutated = body.slice(0, i) + ch + body.slice(i + 1);
      if (!R.decode(mutated).ok) { caught += 1; }
      break;
    }
  }
  check('single-symbol typos are caught in all 12 positions', caught === 12,
        'caught ' + caught + '/12');

  /* Every check id is unique, indexed 0..13, and carries usable guidance. */
  const ids = new Set(R.CHECKS.map((c) => c.id));
  check('CHECKS has 14 unique entries indexed 0..13',
        R.CHECKS.length === 14 && ids.size === 14 &&
        R.CHECKS.every((c, i) => c.index === i));
  check('every check declares layer 1, 3 or null',
        R.CHECKS.every((c) => c.layer === 1 || c.layer === 3 || c.layer === null));
  check('every check has a "why" and non-empty guidance for its failure modes',
        R.CHECKS.every((c) => {
          if (!c.why || c.why.length < 40) { return false; }
          const g = c.guidance || {};
          return typeof g.WARN === 'string' && typeof g.FAIL === 'string' &&
                 typeof g.SKIP === 'string' && g.SKIP.length > 0 &&
                 (g.WARN.length > 0 || g.FAIL.length > 0);
        }));
}

/* -------------------------------------------------- 3. README test vector */

function readmeVector() {
  section('README test vector');

  if (!fs.existsSync(CONFIG) || !fs.existsSync(README)) {
    check('README and config are present', false, 'missing ' + CONFIG + ' or ' + README);
    return;
  }

  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const pkg = (config.packages || []).find((p) => p.id === 'readiness-check');
  if (!pkg || !pkg.readmeTestVector) {
    check('readiness-check declares a README test vector', false);
    return;
  }

  const expected = R.encode(pkg.readmeTestVector.fields);
  const text = fs.readFileSync(README, 'utf8');
  const open = pkg.readmeTestVector.openMarker;
  const close = pkg.readmeTestVector.closeMarker;
  const i = text.indexOf(open);
  const j = text.indexOf(close);

  check('test-vector markers are present in README.md', i !== -1 && j > i);
  if (i === -1 || j <= i) { return; }

  const block = text.slice(i + open.length, j);
  check('README carries the current test vector (' + expected + ')',
        block.indexOf(expected) !== -1,
        'block does not contain ' + expected + ' — run `node tools/build-releases.js`');

  const decoded = R.decode(expected);
  check('the README vector decodes to 14 PASS and verdict READY',
        decoded.ok && decoded.verdict === 'READY' && decoded.counts.PASS === 14);
}

/* --------------------------------------------- 4. PowerShell cross-check */

function powershell() {
  section('PowerShell encoder vs JavaScript decoder (--ps)');

  if (process.platform !== 'win32') {
    console.log('  skip  not running on Windows');
    return;
  }
  if (!fs.existsSync(PS_SCRIPT)) {
    check('the readiness script is present', false, PS_SCRIPT);
    return;
  }

  let stdout;
  let exitCode = 0;
  try {
    stdout = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', PS_SCRIPT, '-Json', '-NoReport'
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    /* Exit codes 1 and 2 are verdicts, not failures. */
    exitCode = typeof err.status === 'number' ? err.status : -1;
    stdout = err.stdout || '';
    if (exitCode !== 1 && exitCode !== 2) {
      check('the script ran (exit 0, 1 or 2)', false,
            'exit ' + exitCode + (err.stderr ? '\n          ' + err.stderr : ''));
      return;
    }
  }

  check('-Json printed only JSON (nothing else on stdout)',
        stdout.trim().startsWith('{') && stdout.trim().endsWith('}'),
        'first 120 chars: ' + JSON.stringify(stdout.slice(0, 120)));

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (e) {
    check('stdout parses as JSON', false, String(e.message));
    return;
  }

  check('report declares schema cerberus-readiness-report/1',
        report.schema === 'cerberus-readiness-report/1', String(report.schema));
  check('report carries a readinessCode', typeof report.readinessCode === 'string');
  check('report carries 14 checks', Array.isArray(report.checks) && report.checks.length === 14);
  if (!report.readinessCode || !Array.isArray(report.checks)) { return; }

  console.log('        code    ' + report.readinessCode);
  console.log('        verdict ' + report.verdict + '   (exit ' + exitCode + ', elevated: ' +
              report.elevated + ')');

  const decoded = R.decode(report.readinessCode);
  check('the emitted code decodes', decoded.ok, decoded.message);
  if (!decoded.ok) { return; }

  /* --- statuses --------------------------------------------------------- */
  const sorted = report.checks.slice().sort((a, b) => a.index - b.index);
  let statusMismatch = null;
  let idMismatch = null;
  for (let i = 0; i < 14; i++) {
    if (sorted[i].index !== i) {
      idMismatch = 'check at position ' + i + ' has index ' + sorted[i].index;
      break;
    }
    if (sorted[i].id !== R.CHECKS[i].id) {
      idMismatch = 'check ' + i + ': script says ' + sorted[i].id +
                   ', JS says ' + R.CHECKS[i].id;
      break;
    }
    if (sorted[i].status !== decoded.statuses[i]) {
      statusMismatch = 'check ' + i + ' (' + sorted[i].id + '): JSON says ' +
                       sorted[i].status + ', code says ' + decoded.statuses[i];
      break;
    }
  }
  check('check ids and order match the JS CHECKS table', idMismatch === null, idMismatch);
  check('all 14 statuses in the code match checks[].status', statusMismatch === null,
        statusMismatch);

  /* --- verdict ---------------------------------------------------------- */
  check('the decoded verdict matches the script verdict',
        decoded.verdict === report.verdict,
        'code says ' + decoded.verdict + ', script says ' + report.verdict);
  const expectedExit = { READY: 0, READY_WITH_WARNINGS: 1, NOT_READY: 2 }[report.verdict];
  check('the exit code matches the verdict', exitCode === expectedExit,
        'exit ' + exitCode + ', expected ' + expectedExit + ' for ' + report.verdict);

  /* --- system buckets --------------------------------------------------- */
  const sys = report.system || {};

  const ramBucket = (gb) => {
    if (gb == null) { return 0; }
    if (gb >= 64) { return 8; }
    if (gb >= 32) { return 7; }
    if (gb >= 24) { return 6; }
    if (gb >= 16) { return 5; }
    if (gb >= 12) { return 4; }
    if (gb >= 8) { return 3; }
    if (gb >= 4) { return 2; }
    return 1;
  };
  const diskBucket = (gb) => {
    if (gb == null) { return 0; }
    if (gb >= 50) { return 5; }
    if (gb >= 10) { return 4; }
    if (gb >= 2) { return 3; }
    if (gb >= 0.5) { return 2; }
    return 1;
  };
  const tpmCode = (spec) => (spec === '2.0' ? 2 : spec === '1.2' ? 1 : 0);

  check('RAM bucket in the code matches system.ramGB (' + sys.ramGB + ' GB)',
        decoded.system.ramBucket === ramBucket(sys.ramGB),
        'code ' + decoded.system.ramBucket + ' (' + decoded.system.ram + '), expected ' +
        ramBucket(sys.ramGB));

  check('disk bucket in the code matches system.freeDiskGB (' + sys.freeDiskGB + ' GB)',
        decoded.system.diskBucket === diskBucket(sys.freeDiskGB),
        'code ' + decoded.system.diskBucket + ', expected ' + diskBucket(sys.freeDiskGB));

  const expectedDrivers = sys.thirdPartyDriverCount == null
    ? 0 : Math.min(15, sys.thirdPartyDriverCount);
  check('driver count in the code matches system.thirdPartyDriverCount (' +
        sys.thirdPartyDriverCount + ')',
        decoded.system.driverCount === expectedDrivers,
        'code ' + decoded.system.driverCount + ', expected ' + expectedDrivers);

  check('TPM field in the code matches system.tpmSpec (' + sys.tpmSpec + ')',
        decoded.system.tpm === tpmCode(sys.tpmSpec),
        'code ' + decoded.system.tpm + ' (' + decoded.system.tpmText + '), expected ' +
        tpmCode(sys.tpmSpec));

  check('OS class in the code matches system.osClass (' + sys.osClass + ')',
        decoded.system.osClass === sys.osClass,
        'code ' + decoded.system.osClass + ' (' + decoded.system.osClassText + '), expected ' +
        sys.osClass);

  /* --- privacy ---------------------------------------------------------- */
  const blob = JSON.stringify(report);
  const forbidden = [];
  const hostname = require('os').hostname();
  const username = process.env.USERNAME || process.env.USER || '';
  if (hostname && blob.toLowerCase().includes(hostname.toLowerCase())) {
    forbidden.push('machine name');
  }
  if (username && username.length > 2 && blob.toLowerCase().includes(username.toLowerCase())) {
    forbidden.push('user name');
  }
  if (/\.sys\b/i.test(blob)) { forbidden.push('a driver file name'); }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(blob)) { forbidden.push('an IP address'); }
  check('the report contains no machine name, user name, driver name or address',
        forbidden.length === 0, 'found: ' + forbidden.join(', '));

  /* --- re-encode -------------------------------------------------------- */
  const reencoded = R.encode({
    statuses: sorted.map((c) => c.status),
    ramBucket: decoded.system.ramBucket,
    diskBucket: decoded.system.diskBucket,
    driverCount: decoded.system.driverCount,
    tpm: decoded.system.tpm,
    osClass: decoded.system.osClass
  });
  check('re-encoding the report in JavaScript reproduces the PowerShell code',
        reencoded === decoded.code,
        'JS produced ' + reencoded + ', PowerShell produced ' + decoded.code);
}

/* ------------------------------------------------------------------ main */

console.log('cerberus readiness code — format v' + R.VERSION);

roundTrips();
rejections();
readmeVector();
if (RUN_PS) {
  powershell();
} else {
  section('PowerShell cross-check');
  console.log('  skip  pass --ps to run the real script and cross-check its code');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
