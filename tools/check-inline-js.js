#!/usr/bin/env node
/**
 * check-inline-js.js — parse every inline <script> in every page.
 *
 * A syntax error in an inline script kills the whole block silently: the page
 * still renders, still returns 200, and still looks fine in a DOM dump, but
 * nothing it wired up actually works. That is exactly how a broken Download
 * button shipped once. This check exists so it cannot happen again.
 *
 *   node tools/check-inline-js.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['site-gamekey', '.git', '.claude', 'node_modules']);

function htmlFiles(dir, base, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!base && SKIP.has(d.name)) continue;
    if (d.name.startsWith('.')) continue;
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) htmlFiles(path.join(dir, d.name), rel, out);
    else if (d.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

const files = htmlFiles(ROOT, '', []);
let scripts = 0, broken = 0;

for (const rel of files) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m, idx = 0;
  while ((m = re.exec(html))) {
    idx++;
    const attrs = m[1] || '';
    const body = m[2];
    // JSON-LD and other non-JS script types are not JavaScript
    if (/type\s*=\s*["'](?!text\/javascript|application\/javascript|module)/i.test(attrs)) continue;
    if (!body.trim()) continue;
    scripts++;
    try {
      new vm.Script(body, { filename: rel + ' #' + idx });
    } catch (e) {
      broken++;
      const line = html.slice(0, m.index).split('\n').length;
      console.log('BROKEN  ' + rel + '  (inline script #' + idx + ', near line ' + line + ')');
      console.log('        ' + String(e.message).split('\n')[0]);
    }
  }
}

console.log('\nparsed ' + scripts + ' inline scripts across ' + files.length + ' html files');
console.log(broken ? broken + ' BROKEN' : 'all inline scripts parse');
process.exit(broken ? 1 : 0);
