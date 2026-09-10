/**
 * Cerberus Anti-Cheat — Release manifest consumer
 * Reads /data/releases.json (written by tools/build-releases.js) and fills
 * any element carrying data-rel="..." with the matching artifact field, so
 * the SDK page, the docs, the dashboard and /downloads/ all show the same
 * file name, size, hash and date without hand-maintained literals.
 *
 * Also exposes the client-side verification helpers used on /downloads/:
 *   sha256File(file)                → hex digest via WebCrypto
 *   verifyFile(file)                → { matched, nameMatch, sha256 }
 *   verifySums(sums, sig, pubPem)   → 'valid' | 'invalid' | 'unsupported'
 *   keyFingerprint(pubPem)          → SHA-256 of the raw SPKI DER
 */

(function () {
  'use strict';

  var R = {};
  window.CerberusReleases = R;

  var MANIFEST_URL = '/data/releases.json';
  var DOWNLOAD_DIR = '/downloads/';
  var COUNTER_PREFIX = 'crb_dl_';

  var _manifest = null;
  var _loading = null;

  // ─── Manifest ───

  // Memoised fetch. Cache-buster changes once a minute (same convention as
  // cerberus-shared.js so a freshly pushed manifest shows up within a minute).
  R.load = function () {
    if (_manifest) return Promise.resolve(_manifest);
    if (_loading) return _loading;
    var bust = '?t=' + Math.floor(Date.now() / 60000);
    _loading = fetch(MANIFEST_URL + bust, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('releases.json HTTP ' + r.status);
        return r.json();
      })
      .then(function (m) {
        if (!m || !m.artifacts || typeof m.artifacts.length !== 'number') throw new Error('releases.json: bad shape');
        _manifest = m;
        return m;
      })
      .catch(function (err) {
        _loading = null; // allow a later retry
        throw err;
      });
    return _loading;
  };

  R.manifest = function () { return _manifest; };

  // Synchronous lookup against the loaded manifest (null until load() resolves).
  R.artifact = function (id) {
    if (!_manifest) return null;
    var list = _manifest.artifacts;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  };

  // Promise flavour for callers that have not awaited load() themselves.
  R.whenArtifact = function (id) {
    return R.load().then(function () { return R.artifact(id); });
  };

  R.fileUrl = function (a) {
    if (!a || !a.file) return null;
    var f = String(a.file);
    if (f.indexOf('/') === 0 || /^https?:\/\//.test(f)) return f;
    return DOWNLOAD_DIR + f;
  };

  // ─── Formatting ───

  R.formatSize = function (bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    var kb = n / 1024;
    if (kb < 10) return kb.toFixed(1) + ' KB';
    if (kb < 1024) return Math.round(kb) + ' KB';
    var mb = kb / 1024;
    if (mb < 10) return mb.toFixed(2) + ' MB';
    return mb.toFixed(1) + ' MB';
  };

  R.formatDate = function (iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  };

  // ─── Rendering ───

  function fieldValue(a, key) {
    switch (key) {
      case 'fileName':   return a.fileName || (a.file ? String(a.file).split('/').pop() : '—');
      case 'size':       return a.sizeBytes != null ? R.formatSize(a.sizeBytes) : '—';
      case 'sha256':     return a.sha256 || '—';
      case 'version':    return a.version || '—';
      case 'releasedAt': return R.formatDate(a.releasedAt);
      case 'name':       return a.name || a.id;
      default:
        var v = a[key];
        if (v == null) return '—';
        if (typeof v === 'string' || typeof v === 'number') return String(v);
        return '—';
    }
  }

  function setHref(el, a) {
    var url = R.fileUrl(a);
    if (url) {
      el.setAttribute('href', url);
      if (el.tagName === 'A') el.setAttribute('download', a.fileName || url.split('/').pop());
      el.removeAttribute('aria-disabled');
    } else {
      el.removeAttribute('href');
      el.setAttribute('aria-disabled', 'true');
    }
  }

  function placeholder(el, reason) {
    var nodes = el.querySelectorAll('[data-rel]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-rel');
      if (key === 'href') {
        nodes[i].removeAttribute('href');
        nodes[i].setAttribute('aria-disabled', 'true');
      } else if (key === 'fileName' || key === 'sha256') {
        nodes[i].textContent = reason;
      } else {
        nodes[i].textContent = '—';
      }
    }
    el.setAttribute('data-rel-state', 'error');
  }

  // Fill every descendant [data-rel] of `el` from the artifact `artifactId`.
  // Resolves to the artifact (or null when the manifest / artifact is missing).
  R.render = function (el, artifactId) {
    if (!el) return Promise.resolve(null);
    var id = artifactId || el.getAttribute('data-artifact');
    return R.load().then(function () {
      var a = R.artifact(id);
      if (!a) { placeholder(el, 'not in manifest'); return null; }
      var nodes = el.querySelectorAll('[data-rel]');
      for (var i = 0; i < nodes.length; i++) {
        var key = nodes[i].getAttribute('data-rel');
        if (key === 'href') setHref(nodes[i], a);
        else nodes[i].textContent = fieldValue(a, key);
      }
      el.setAttribute('data-rel-state', a.file ? 'ready' : 'gated');
      return a;
    }).catch(function () {
      placeholder(el, 'manifest unavailable');
      return null;
    });
  };

  R.renderAll = function (root) {
    var scope = root || document;
    var els = scope.querySelectorAll('[data-artifact]');
    var out = [];
    for (var i = 0; i < els.length; i++) out.push(R.render(els[i], els[i].getAttribute('data-artifact')));
    return Promise.all(out);
  };

  // ─── Hashing / verification ───

  function toHex(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      s += h.length === 1 ? '0' + h : h;
    }
    return s;
  }

  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (typeof x === 'string') return new TextEncoder().encode(x);
    if (x && x.buffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
    throw new Error('unsupported byte source');
  }

  function readFileBytes(file) {
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function subtle() {
    var c = window.crypto || window.msCrypto;
    return c && c.subtle ? c.subtle : null;
  }

  R.sha256Bytes = function (bytes) {
    var s = subtle();
    if (!s) return Promise.reject(new Error('WebCrypto unavailable'));
    return s.digest('SHA-256', toBytes(bytes)).then(toHex);
  };

  R.sha256File = function (file) {
    return readFileBytes(file).then(R.sha256Bytes);
  };

  // Compare a local file against the manifest. `matched` is the artifact whose
  // sha256 equals the file's digest; `nameMatch` is the artifact whose fileName
  // equals the dropped file's name (useful for "right file, wrong bytes").
  R.verifyFile = function (file) {
    var manifestP = R.load().catch(function () { return null; });
    return Promise.all([R.sha256File(file), manifestP]).then(function (res) {
      var hex = res[0];
      var m = res[1];
      var matched = null, nameMatch = null;
      if (m) {
        for (var i = 0; i < m.artifacts.length; i++) {
          var a = m.artifacts[i];
          if (a.sha256 && a.sha256.toLowerCase() === hex) matched = a;
          if (file && file.name && a.fileName === file.name) nameMatch = a;
        }
      }
      return { matched: matched, nameMatch: nameMatch, sha256: hex, manifest: !!m };
    });
  };

  function pemToDer(pem) {
    var b64 = String(pem).replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  R.pemToDer = pemToDer;

  // Ed25519 over the SHA256SUMS.txt bytes. Browser support for Ed25519 in
  // WebCrypto is not universal, so any exception maps to 'unsupported' and the
  // page shows the openssl fallback instead of a misleading failure.
  R.verifySums = function (sumsText, sigBytes, pubPem) {
    return new Promise(function (resolve) {
      try {
        var s = subtle();
        if (!s || typeof s.importKey !== 'function') return resolve('unsupported');
        var der = pemToDer(pubPem);
        var sig = toBytes(sigBytes);
        var data = toBytes(sumsText);
        if (sig.length !== 64) return resolve('invalid');
        s.importKey('spki', der, { name: 'Ed25519' }, false, ['verify'])
          .then(function (key) { return s.verify({ name: 'Ed25519' }, key, sig, data); })
          .then(function (ok) { resolve(ok ? 'valid' : 'invalid'); })
          .catch(function () { resolve('unsupported'); });
      } catch (e) {
        resolve('unsupported');
      }
    });
  };

  // SHA-256 of the raw SPKI DER — the same value `openssl pkey -pubin -outform DER | sha256sum` prints.
  R.keyFingerprint = function (pubPem) {
    try {
      return R.sha256Bytes(pemToDer(pubPem));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  // ─── Download ───

  R.downloadCount = function (id) {
    try { return parseInt(localStorage.getItem(COUNTER_PREFIX + id), 10) || 0; } catch (e) { return 0; }
  };

  function bumpCounter(id) {
    try {
      var n = R.downloadCount(id) + 1;
      localStorage.setItem(COUNTER_PREFIX + id, String(n));
      return n;
    } catch (e) { return 0; }
  }

  // Resolves true when a download was started, false when the artifact has no
  // public file (gated / archived) or the manifest could not be loaded.
  R.download = function (artifactId) {
    return R.load().then(function () {
      var a = R.artifact(artifactId);
      var url = R.fileUrl(a);
      if (!url) return false;
      var link = document.createElement('a');
      link.href = url;
      link.download = a.fileName || url.split('/').pop();
      link.rel = 'noopener';
      link.style.display = 'none';
      // Keep the synthetic click away from the page-transition handler.
      link.addEventListener('click', function (e) { e.stopPropagation(); });
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      bumpCounter(artifactId);
      try {
        document.dispatchEvent(new CustomEvent('cerberus:download', { detail: { id: artifactId, fileName: link.download } }));
      } catch (e) { /* older browsers without CustomEvent constructor */ }
      return true;
    }).catch(function () { return false; });
  };

  // ─── Auto-render ───

  function boot() { R.renderAll(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
