'use strict';
/*
 * tools/lib/zip.js — deterministic ZIP writer.
 *
 * The point of this file is that building the same package twice produces a
 * byte-identical archive, so `node tools/build-releases.js --check` can prove
 * the published zip matches the source tree, and the SHA-256 on the downloads
 * page means something.
 *
 * How determinism is achieved:
 *   - entries sorted by path, forward slashes only
 *   - one fixed DOS timestamp for every entry, derived from releasedAt
 *   - no extra fields, no unix extended timestamp, no zip64
 *   - DEFLATE via zlib.deflateRawSync at a fixed level (9)
 *   - stored (level 0) only when deflate does not actually help
 *
 * No dependencies. Node 18+.
 */

const zlib = require('zlib');

/* ---------------------------------------------------------------- CRC-32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  }
  return (c ^ (-1)) >>> 0;
}

/* ------------------------------------------------------------ timestamps */

/**
 * MS-DOS date/time from a Date, interpreted in UTC.
 * DOS time has two-second resolution and a 1980 epoch.
 */
function dosDateTime(date) {
  const year = date.getUTCFullYear();
  if (year < 1980) {
    throw new Error('ZIP timestamps must be 1980 or later, got ' + year);
  }
  const time =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    (Math.floor(date.getUTCSeconds() / 2));
  const dateBits =
    ((year - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate();
  return { time: time & 0xFFFF, date: dateBits & 0xFFFF };
}

/* ------------------------------------------------------------- structure */

const LOCAL_SIG   = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG    = 0x06054b50;

const METHOD_STORE   = 0;
const METHOD_DEFLATE = 8;

/* Version 2.0 — the minimum that understands DEFLATE. */
const VERSION_NEEDED = 20;
/* Made by: 0x03 (unix) << 8 | 20. Keeps external attributes meaningful. */
const VERSION_MADE_BY = (3 << 8) | 20;

/* General purpose flags: bit 11 = filename is UTF-8. */
const FLAG_UTF8 = 0x0800;

function normalizePath(p) {
  const out = String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (out === '' || out.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('Unsafe ZIP entry path: ' + p);
  }
  return out;
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{path: string, data: Buffer|string, mode?: number}>} entries
 * @param {{ date: Date, comment?: string }} options
 * @returns {Buffer}
 */
function createZip(entries, options) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('createZip: no entries');
  }
  const opts = options || {};
  const date = opts.date instanceof Date ? opts.date : new Date(opts.date);
  if (isNaN(date.getTime())) {
    throw new Error('createZip: options.date is required and must be a valid date');
  }
  const { time: dosTime, date: dosDate } = dosDateTime(date);

  /* Normalise, reject duplicates, then sort so the archive order is a pure
   * function of the entry set. */
  const seen = new Set();
  const prepared = entries.map((e) => {
    const path = normalizePath(e.path);
    if (seen.has(path)) {
      throw new Error('createZip: duplicate entry path: ' + path);
    }
    seen.add(path);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    /* 0100644 regular file / 0100755 executable, shifted into the high word. */
    const mode = typeof e.mode === 'number' ? e.mode : 0o644;
    return { path, data, mode };
  });

  prepared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of prepared) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);

    let method = METHOD_DEFLATE;
    let payload = zlib.deflateRawSync(entry.data, { level: 9 });
    if (payload.length >= entry.data.length) {
      /* Deflate did not help — store instead. Smaller and still deterministic. */
      method = METHOD_STORE;
      payload = entry.data;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); /* no extra field */

    localChunks.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); /* extra field length   */
    central.writeUInt16LE(0, 32); /* file comment length  */
    central.writeUInt16LE(0, 34); /* disk number start    */
    central.writeUInt16LE(0, 36); /* internal attributes  */
    central.writeUInt32LE(((0o100000 | entry.mode) >>> 0) * 65536, 38); /* external attributes */
    central.writeUInt32LE(offset, 42);

    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const commentBuf = Buffer.from(opts.comment ? String(opts.comment) : '', 'utf8');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);                     /* this disk                       */
  eocd.writeUInt16LE(0, 6);                     /* disk with central directory     */
  eocd.writeUInt16LE(prepared.length, 8);       /* entries on this disk            */
  eocd.writeUInt16LE(prepared.length, 10);      /* total entries                   */
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);               /* offset of central directory     */
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([Buffer.concat(localChunks), centralDirectory, eocd, commentBuf]);
}

module.exports = { createZip, crc32, dosDateTime };
