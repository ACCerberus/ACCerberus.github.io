#!/usr/bin/env node
'use strict';
/*
 * tools/build-releases.js — build the public download packages.
 *
 *   node tools/build-releases.js            build zips, manifest, SHA256SUMS, signature
 *   node tools/build-releases.js --check    rebuild in memory and report any drift
 *   node tools/build-releases.js --gen-key  create the Ed25519 release signing key
 *
 * What it does, in order:
 *   1. reads tools/releases.config.json
 *   2. for each package: asserts the declared version matches package.json AND
 *      the version literal inside the source (so the two can never drift)
 *   3. greps every shipped script for network-capable constructs and refuses to
 *      publish if any match — the README tells users to run the same check
 *   4. substitutes the README test vector, computed with the real encoder from
 *      js/cerberus-readiness.js
 *   5. writes a deterministic zip with an in-zip SHA256SUMS.txt
 *   6. removes superseded zips
 *   7. writes data/releases.json and downloads/SHA256SUMS.txt
 *   8. signs SHA256SUMS.txt with Ed25519 and verifies the signature it just made
 *
 * The signing key lives at ~/.cerberus-release-key.pem and must never be in the
 * repository. *.pem is gitignored; this script refuses to read a key from
 * inside the working tree.
 *
 * No dependencies. Node 18+.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createZip } = require('./lib/zip.js');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'releases.config.json');

/* Windows PowerShell constructs that can reach the network or spawn something.
 * Kept identical to the one-liner printed in the Readiness Check README. */
const NETWORK_PATTERN =
  /Invoke-WebRequest|Invoke-RestMethod|System\.Net|WebClient|HttpClient|Sockets|Start-Process|ComputerName|Test-Connection/;

/* Text extensions get their line endings normalised so the archive is identical
 * regardless of how git checked the tree out (core.autocrlf is on here). */
const CRLF_EXT = new Set(['.ps1', '.psm1', '.psd1', '.cmd', '.bat']);
const LF_EXT = new Set([
  '.md', '.txt', '.json', '.h', '.hpp', '.c', '.cpp', '.cs', '.cmake',
  '.yml', '.yaml', '.js', '.gitignore'
]);

/* ------------------------------------------------------------------ util */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const CHECK_MODE = flag('--check');
const GEN_KEY = flag('--gen-key');
const QUIET = flag('--quiet');

let problems = 0;

function log(...a) { if (!QUIET) { console.log(...a); } }
function ok(msg) { log('  ✓ ' + msg); }
function warn(msg) { log('  ! ' + msg); }
function fail(msg) { problems += 1; console.error('  ✗ ' + msg); }

function die(msg) {
  console.error('\nbuild-releases: ' + msg + '\n');
  process.exit(1);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function expandHome(p) {
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function walk(dir, base) {
  base = base || dir;
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === '.git' || name === 'node_modules' || name === 'build') { continue; }
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walk(abs, base));
    } else if (stat.isFile()) {
      out.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function normalizeEol(rel, buf) {
  const ext = path.extname(rel).toLowerCase();
  if (!CRLF_EXT.has(ext) && !LF_EXT.has(ext)) {
    return buf;
  }
  const text = buf.toString('utf8');
  if (text.indexOf("\u0000") !== -1) {
    return buf; /* not actually text */
  }
  const lf = text.replace(/\r\n/g, '\n');
  return Buffer.from(CRLF_EXT.has(ext) ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
}

/* --------------------------------------------------------- readiness lib */

function loadReadiness(config) {
  const p = path.join(ROOT, config.readinessLib);
  if (!fs.existsSync(p)) {
    die('readiness library not found: ' + config.readinessLib);
  }
  /* Same module the /readiness/ page runs, loaded rather than re-implemented,
   * so the README test vector can never disagree with the site. */
  return require(p);
}

function buildTestVectorBlock(readiness, spec) {
  const f = spec.fields;
  const code = readiness.encode(f);

  /* Round-trip it: a README vector that does not decode is worse than none. */
  const decoded = readiness.decode(code);
  if (!decoded.ok) {
    die('generated test vector does not decode: ' + decoded.message);
  }
  for (let i = 0; i < 14; i++) {
    if (decoded.statuses[i] !== f.statuses[i]) {
      die('test vector round-trip mismatch at check ' + i);
    }
  }

  const passCount = f.statuses.filter((s) => s === 'PASS').length;
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'];

  const lines = [
    'A run where all ' + words[passCount] + ' checks pass on a machine with ' +
      readiness.RAM_BUCKETS[f.ramBucket] + ' RAM, ' + readiness.DISK_BUCKETS[f.diskBucket] +
      ' free on the system drive, ' + f.driverCount + ' third-party kernel drivers, ' +
      readiness.TPM_LABELS[f.tpm] + ' and ' + readiness.OS_CLASSES[f.osClass] +
      ' encodes to:',
    '',
    '```',
    code,
    '```'
  ];
  return { text: lines.join('\n'), code: code };
}

function substituteTestVector(source, spec, block) {
  const open = spec.openMarker;
  const close = spec.closeMarker;
  const i = source.indexOf(open);
  const j = source.indexOf(close);
  if (i === -1 || j === -1 || j < i) {
    die('test-vector markers not found in ' + spec.file);
  }
  return source.slice(0, i + open.length) + '\n' + block.text + '\n' + source.slice(j);
}

/* -------------------------------------------------------------- packages */

function buildPackage(config, pkg, readiness) {
  const srcDir = path.join(ROOT, pkg.source);
  if (!fs.existsSync(srcDir)) {
    die('package source not found: ' + pkg.source);
  }

  const pkgJsonPath = path.join(srcDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    die(pkg.source + '/package.json is missing');
  }
  const pkgJson = readJson(pkgJsonPath);

  if (pkgJson.id !== pkg.id) {
    die(pkg.source + '/package.json id "' + pkgJson.id + '" != config id "' + pkg.id + '"');
  }
  if (pkgJson.version !== pkg.expectVersion) {
    die(pkg.source + '/package.json version "' + pkgJson.version +
        '" != expectVersion "' + pkg.expectVersion + '" in releases.config.json');
  }
  const version = pkgJson.version;

  const rootFolder = pkg.slug + '-' + version;
  const fileName = rootFolder + '.zip';

  /* --- read the tree ---------------------------------------------------- */
  const relPaths = walk(srcDir);
  if (relPaths.length === 0) {
    die('no files found under ' + pkg.source);
  }

  const files = new Map();
  for (const rel of relPaths) {
    files.set(rel, normalizeEol(rel, fs.readFileSync(path.join(srcDir, rel))));
  }

  /* --- version assertions ---------------------------------------------- */
  for (const assertion of (pkg.versionAssertions || [])) {
    const buf = files.get(assertion.file);
    if (!buf) {
      die(pkg.id + ': version assertion file missing: ' + assertion.file);
    }
    const m = new RegExp(assertion.pattern).exec(buf.toString('utf8'));
    if (!m) {
      die(pkg.id + ': could not find ' + assertion.label + ' in ' + assertion.file);
    }
    if (m[1] !== version) {
      die(pkg.id + ': ' + assertion.label + ' is "' + m[1] + '" in ' + assertion.file +
          ' but package.json says "' + version + '"');
    }
    ok(pkg.id + ': ' + assertion.label + ' == ' + version);
  }

  /* --- zero-network gate ------------------------------------------------ */
  const gateExts = pkg.zeroNetworkGate || [];
  if (gateExts.length > 0) {
    let scanned = 0;
    for (const [rel, buf] of files) {
      if (!gateExts.includes(path.extname(rel).toLowerCase())) { continue; }
      scanned += 1;
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = NETWORK_PATTERN.exec(lines[i]);
        if (m) {
          die(pkg.id + ': network-capable construct "' + m[0] + '" in ' + rel +
              ' line ' + (i + 1) + '. This package is published as offline-only ' +
              'and the README tells users to verify that; refusing to build.');
        }
      }
    }
    ok(pkg.id + ': zero-network gate clean (' + scanned + ' script file(s) scanned)');
  }

  /* --- README test vector ---------------------------------------------- */
  let testVectorCode = null;
  if (pkg.readmeTestVector) {
    const spec = pkg.readmeTestVector;
    const buf = files.get(spec.file);
    if (!buf) {
      die(pkg.id + ': test-vector file missing: ' + spec.file);
    }
    const block = buildTestVectorBlock(readiness, spec);
    testVectorCode = block.code;

    const before = buf.toString('utf8');
    const after = substituteTestVector(before, spec, block);
    files.set(spec.file, Buffer.from(after, 'utf8'));

    /* Keep the working copy in step so `git diff` shows the real content. */
    if (!CHECK_MODE && after !== before) {
      fs.writeFileSync(path.join(srcDir, spec.file), after);
      ok(pkg.id + ': README test vector updated -> ' + block.code);
    } else if (after !== before) {
      fail(pkg.id + ': README test vector is stale (expected ' + block.code + ')');
    } else {
      ok(pkg.id + ': README test vector current -> ' + block.code);
    }
  }

  /* --- in-zip SHA256SUMS.txt ------------------------------------------- */
  const sumLines = [];
  for (const rel of [...files.keys()].sort()) {
    sumLines.push(sha256(files.get(rel)) + '  ' + rel);
  }
  files.set('SHA256SUMS.txt', Buffer.from(sumLines.join('\n') + '\n', 'utf8'));

  /* --- zip -------------------------------------------------------------- */
  const entries = [...files.keys()].sort().map((rel) => ({
    path: rootFolder + '/' + rel,
    data: files.get(rel),
    mode: /\.(ps1|cmd|bat|sh)$/i.test(rel) ? 0o755 : 0o644
  }));

  const zipBuf = createZip(entries, {
    date: new Date(config.releasedAt + 'T00:00:00Z'),
    comment: pkg.name + ' ' + version + ' — https://cerberusac.dev/downloads/'
  });

  return {
    pkg,
    version,
    rootFolder,
    fileName,
    buffer: zipBuf,
    sizeBytes: zipBuf.length,
    sha256: sha256(zipBuf),
    fileCount: entries.length,
    testVectorCode
  };
}

/* --------------------------------------------------------------- signing */

function keyPathFrom(config) {
  const p = path.resolve(expandHome(config.signing.keyPath));
  const rel = path.relative(ROOT, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    die('the release signing key must not live inside the repository (' + p + ')');
  }
  return p;
}

function genKey(config) {
  const keyPath = keyPathFrom(config);
  if (fs.existsSync(keyPath)) {
    die('key already exists at ' + keyPath + ' — delete it deliberately if you ' +
        'really mean to rotate, and remember every published signature becomes ' +
        'unverifiable against the new key.');
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch (e) { /* best effort on Windows */ }

  const spki = publicKey.export({ type: 'spki', format: 'der' });
  log('');
  log('Created Ed25519 release signing key:');
  log('  ' + keyPath);
  log('  key id      ' + config.signing.keyId);
  log('  fingerprint ' + fingerprintOf(spki));
  log('');
  log('Keep it out of the repository and back it up somewhere you can find it.');
  log('Run `node tools/build-releases.js` to publish and sign.');
  log('');
}

function fingerprintOf(spkiDer) {
  const hex = crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 32);
  return (hex.match(/.{2}/g) || []).join(':').toUpperCase();
}

function signSums(config, sumsBuf, downloadsDir) {
  const keyPath = keyPathFrom(config);
  if (!fs.existsSync(keyPath)) {
    warn('no signing key at ' + keyPath + ' — SHA256SUMS.txt will be unsigned.');
    warn('Run `node tools/build-releases.js --gen-key` to create one.');
    return null;
  }

  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    die('signing key at ' + keyPath + ' is ' + privateKey.asymmetricKeyType + ', expected ed25519');
  }
  const publicKey = crypto.createPublicKey(privateKey);

  const signature = crypto.sign(null, sumsBuf, privateKey); /* raw 64 bytes */
  if (signature.length !== 64) {
    die('unexpected Ed25519 signature length: ' + signature.length);
  }
  if (!crypto.verify(null, sumsBuf, publicKey, signature)) {
    die('the signature just produced does not verify — refusing to publish it');
  }

  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  return {
    signature,
    publicKeyPem: Buffer.from(pubPem, 'utf8'),
    fingerprint: fingerprintOf(spkiDer),
    signaturePath: path.join(downloadsDir, config.signing.signatureFile),
    publicKeyPath: path.join(downloadsDir, config.signing.publicKeyFile)
  };
}

/* -------------------------------------------------------------- manifest */

function buildManifest(config, built, signing) {
  const artifacts = [];

  for (const b of built) {
    const p = b.pkg;
    const a = {
      id: p.id,
      kind: p.kind,
      name: p.name,
      version: b.version,
      status: p.status || 'current',
      public: p.public !== false,
      requiresAccount: p.requiresAccount === true,
      summary: p.summary,
      file: '/' + config.downloadsDir + '/' + b.fileName,
      fileName: b.fileName,
      sizeBytes: b.sizeBytes,
      sha256: b.sha256,
      releasedAt: config.releasedAt,
      minOs: p.minOs,
      runtime: p.runtime || null,
      docsUrl: p.docsUrl,
      notesUrl: p.notesUrl,
      contents: p.contents || []
    };
    if (p.notIncluded) { a.notIncluded = p.notIncluded; }
    if (typeof p.callbackAbi === 'number') { a.callbackAbi = p.callbackAbi; }
    if (p.compatibleEngine) { a.compatibleEngine = p.compatibleEngine; }
    artifacts.push(a);
  }

  for (const extra of (config.extraArtifacts || [])) {
    const a = Object.assign({}, extra);
    delete a.$comment;
    artifacts.push(a);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    generator: config.generator,
    signing: signing
      ? {
          algorithm: config.signing.algorithm,
          keyId: config.signing.keyId,
          fingerprint: signing.fingerprint,
          publicKeyUrl: config.signing.publicKeyUrl,
          sumsUrl: config.signing.sumsUrl,
          signatureUrl: config.signing.signatureUrl
        }
      : null,
    policy: config.policy,
    artifacts
  };
}

function stripVolatile(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  delete copy.generatedAt;
  return copy;
}

/* ------------------------------------------------------------------ main */

function main() {
  const config = readJson(CONFIG_PATH);

  if (GEN_KEY) {
    genKey(config);
    return;
  }

  const downloadsDir = path.join(ROOT, config.downloadsDir);
  const manifestPath = path.join(ROOT, config.manifestPath);
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  log('');
  log(CHECK_MODE ? 'Checking release packages for drift...' : 'Building release packages...');
  log('  releasedAt ' + config.releasedAt);
  log('');

  const readiness = loadReadiness(config);

  /* --- 1. build every package ------------------------------------------ */
  const built = [];
  for (const pkg of config.packages) {
    log('[' + pkg.id + ']');
    const b = buildPackage(config, pkg, readiness);
    ok(b.fileName + ' — ' + b.fileCount + ' files, ' +
       (b.sizeBytes / 1024).toFixed(1) + ' KB, sha256 ' + b.sha256.slice(0, 16) + '...');
    built.push(b);
    log('');
  }

  /* --- 2. write / compare zips ----------------------------------------- */
  for (const b of built) {
    const dest = path.join(downloadsDir, b.fileName);
    if (CHECK_MODE) {
      if (!fs.existsSync(dest)) {
        fail('missing: ' + config.downloadsDir + '/' + b.fileName);
      } else {
        const onDisk = fs.readFileSync(dest);
        if (!onDisk.equals(b.buffer)) {
          fail('drift: ' + config.downloadsDir + '/' + b.fileName +
               ' (on disk ' + sha256(onDisk).slice(0, 16) + '..., rebuilt ' +
               b.sha256.slice(0, 16) + '...)');
        } else {
          ok('unchanged: ' + config.downloadsDir + '/' + b.fileName);
        }
      }
    } else {
      fs.writeFileSync(dest, b.buffer);
      ok('wrote ' + config.downloadsDir + '/' + b.fileName);
    }
  }

  /* --- 3. remove superseded zips --------------------------------------- */
  for (const legacy of (config.legacyZips || [])) {
    const p = path.join(downloadsDir, legacy);
    if (!fs.existsSync(p)) { continue; }
    if (CHECK_MODE) {
      fail('superseded zip still present: ' + config.downloadsDir + '/' + legacy);
    } else {
      fs.unlinkSync(p);
      ok('removed superseded ' + config.downloadsDir + '/' + legacy);
    }
  }

  /* --- 4. downloads/SHA256SUMS.txt ------------------------------------- */
  const sumsLines = built
    .slice()
    .sort((a, b) => (a.fileName < b.fileName ? -1 : 1))
    .map((b) => b.sha256 + '  ' + b.fileName);
  const sumsBuf = Buffer.from(sumsLines.join('\n') + '\n', 'utf8');
  const sumsPath = path.join(downloadsDir, config.signing.sumsFile);

  if (CHECK_MODE) {
    const onDisk = fs.existsSync(sumsPath) ? fs.readFileSync(sumsPath) : null;
    if (!onDisk) {
      fail('missing: ' + config.downloadsDir + '/' + config.signing.sumsFile);
    } else if (!onDisk.equals(sumsBuf)) {
      fail('drift: ' + config.downloadsDir + '/' + config.signing.sumsFile);
    } else {
      ok('unchanged: ' + config.downloadsDir + '/' + config.signing.sumsFile);
    }
  } else {
    fs.writeFileSync(sumsPath, sumsBuf);
    ok('wrote ' + config.downloadsDir + '/' + config.signing.sumsFile);
  }

  /* --- 5. signature ----------------------------------------------------- */
  log('');
  log('[signing]');
  const signing = signSums(config, sumsBuf, downloadsDir);
  if (signing) {
    if (CHECK_MODE) {
      /* Ed25519 is deterministic, so the signature bytes must match too. */
      const onDiskSig = fs.existsSync(signing.signaturePath)
        ? fs.readFileSync(signing.signaturePath) : null;
      if (!onDiskSig) {
        fail('missing: ' + config.downloadsDir + '/' + config.signing.signatureFile);
      } else if (!onDiskSig.equals(signing.signature)) {
        fail('drift: ' + config.downloadsDir + '/' + config.signing.signatureFile);
      } else {
        ok('signature verifies against ' + config.signing.keyId);
      }
      const onDiskPub = fs.existsSync(signing.publicKeyPath)
        ? fs.readFileSync(signing.publicKeyPath) : null;
      if (!onDiskPub || !onDiskPub.equals(signing.publicKeyPem)) {
        fail('drift: ' + config.downloadsDir + '/' + config.signing.publicKeyFile);
      } else {
        ok('unchanged: ' + config.downloadsDir + '/' + config.signing.publicKeyFile);
      }
    } else {
      fs.writeFileSync(signing.signaturePath, signing.signature);
      fs.writeFileSync(signing.publicKeyPath, signing.publicKeyPem);
      ok('signed ' + config.signing.sumsFile + ' (' + signing.signature.length + ' bytes, Ed25519)');
      ok('wrote ' + config.downloadsDir + '/' + config.signing.publicKeyFile);
      log('    key id      ' + config.signing.keyId);
      log('    fingerprint ' + signing.fingerprint);
    }
  }

  /* --- 6. manifest ------------------------------------------------------ */
  log('');
  log('[manifest]');
  const manifest = buildManifest(config, built, signing);
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';

  if (CHECK_MODE) {
    if (!fs.existsSync(manifestPath)) {
      fail('missing: ' + config.manifestPath);
    } else {
      const onDisk = readJson(manifestPath);
      const a = JSON.stringify(stripVolatile(onDisk));
      const b = JSON.stringify(stripVolatile(manifest));
      if (a !== b) {
        fail('drift: ' + config.manifestPath + ' (ignoring generatedAt)');
      } else {
        ok('unchanged: ' + config.manifestPath + ' (ignoring generatedAt)');
      }
    }
  } else {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, manifestText);
    ok('wrote ' + config.manifestPath + ' (' + manifest.artifacts.length + ' artifacts)');
  }

  log('');
  if (CHECK_MODE) {
    if (problems === 0) {
      log('No drift. Published packages match the source tree.');
      log('');
      process.exit(0);
    }
    console.error(problems + ' problem(s) found. Run `node tools/build-releases.js` to rebuild.');
    console.error('');
    process.exit(1);
  }

  log('Done. Verify with:');
  log('  node tools/build-releases.js --check');
  log('  node tools/test-readiness-code.js --ps');
  log('  (cd ' + config.downloadsDir + ' && sha256sum -c ' + config.signing.sumsFile + ')');
  log('');
}

try {
  main();
} catch (err) {
  die(err && err.stack ? err.stack : String(err));
}
