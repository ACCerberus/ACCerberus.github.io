#!/usr/bin/env node
/**
 * check-links.js — resolve every internal href/src in the site against the
 * filesystem and report the ones that do not exist.
 *   node tools/check-links.js
 * Skips the site-* variant folders, external URLs, mailto:, tel:, data: and
 * bare fragments. A link to /foo/ resolves to foo/index.html.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['site-anticheat', 'site-gamekey', '.git', '.claude', 'node_modules', 'tools']);

function htmlFiles(dir, base, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!base && SKIP_DIRS.has(d.name)) continue;
    if (d.name.startsWith('.')) continue;
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) htmlFiles(path.join(dir, d.name), rel, out);
    else if (d.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

const files = htmlFiles(ROOT, '', []);
let checked = 0;
const misses = [];

for (const rel of files) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const dir = path.dirname(rel);
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (!href) continue;
    if (/^(https?:|mailto:|tel:|data:|javascript:|#)/i.test(href)) continue;
    href = href.split('#')[0].split('?')[0];
    if (!href) continue;

    let target;
    if (href.startsWith('/')) target = path.join(ROOT, href);
    else target = path.resolve(ROOT, dir, href);

    if (href.endsWith('/')) target = path.join(target, 'index.html');
    checked++;
    if (fs.existsSync(target)) continue;
    // a directory link written without a trailing slash
    if (fs.existsSync(path.join(target, 'index.html'))) continue;
    misses.push(rel + '  ->  ' + m[1]);
  }
}

console.log('checked ' + checked + ' internal links across ' + files.length + ' html files');
if (!misses.length) { console.log('no broken internal links'); process.exit(0); }
console.log('\nBROKEN (' + misses.length + '):');
for (const x of misses) console.log('  ' + x);
process.exit(1);
