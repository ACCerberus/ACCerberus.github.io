#!/usr/bin/env node
/**
 * sync-mirror.js — copy the live root site into site-anticheat/ (the variant
 * source of truth used by switch-site.*), including deletions. Everything at
 * root is mirrored except .git, .claude, the site-* folders and the switch
 * scripts. Prints a summary; --dry-run reports without writing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIRROR = path.join(ROOT, 'site-anticheat');
const DRY = process.argv.includes('--dry-run');
const EXCLUDE = new Set(['.git', '.claude', 'site-anticheat', 'site-gamekey', 'switch-site.ps1', 'switch-site.sh', 'node_modules']);

function walk(dir, base, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + d.name : d.name;
    if (!base && EXCLUDE.has(d.name)) continue;
    if (d.isDirectory()) walk(path.join(dir, d.name), rel, out);
    else out.push(rel);
  }
  return out;
}

const rootFiles = walk(ROOT, '', []);
const mirrorFiles = fs.existsSync(MIRROR) ? walk(MIRROR, '', []) : [];
const rootSet = new Set(rootFiles);
let copied = 0, removed = 0, same = 0;

for (const rel of rootFiles) {
  const src = path.join(ROOT, rel), dst = path.join(MIRROR, rel);
  const a = fs.readFileSync(src);
  if (fs.existsSync(dst) && a.equals(fs.readFileSync(dst))) { same++; continue; }
  copied++;
  if (DRY) { console.log('copy: ' + rel); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
for (const rel of mirrorFiles) {
  if (rootSet.has(rel)) continue;
  removed++;
  if (DRY) { console.log('remove: ' + rel); continue; }
  fs.rmSync(path.join(MIRROR, rel));
}
// prune empty dirs
if (!DRY) {
  const prune = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) prune(path.join(dir, d.name));
    if (dir !== MIRROR && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  prune(MIRROR);
}
console.log((DRY ? 'dry-run: ' : '') + copied + ' copied, ' + removed + ' removed, ' + same + ' unchanged');
