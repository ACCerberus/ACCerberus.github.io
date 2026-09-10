#!/usr/bin/env node
/**
 * rebuild-nav.js — regenerate the <div class="nav-links"> block on every
 * marketing page from a single source-of-truth mapping, so all pages stay
 * consistent. Idempotent. Sets class="active" on the page's own link and
 * "current" on its dropdown.
 *
 *   node tools/rebuild-nav.js            # rewrite
 *   node tools/rebuild-nav.js --dry-run  # report only
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const NAV = [
  { label: 'Developers', items: [
    ['/docs/', 'Docs'], ['/api/', 'API'], ['/sdk/', 'SDK'], ['/changelog/', 'Changelog'], ['/integrations/', 'Integrations']
  ]},
  { label: 'Live Data', items: [
    ['/analytics/', 'Analytics'], ['/operations/', 'Operations'], ['/status/', 'Status']
  ]},
  { label: 'Company', items: [
    ['/team/', 'Team'], ['/case-studies/', 'Case Studies'], ['/trust/', 'Trust'], ['/about/', 'About']
  ]},
  { label: 'Resources', items: [
    ['/plans/', 'Plans'], ['/downloads/', 'Downloads'], ['/readiness/', 'Readiness Check'], ['/blog/', 'Blog'], ['/updates/', 'Updates']
  ]},
];

const SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const SKIP_DIRS = new Set(['site-anticheat', 'site-gamekey', 'dashboard', 'studios', 'css', 'js', 'data', 'downloads', 'tools', 'node_modules', '.git', '.github', '.claude', '.well-known']);

function buildBlock(pagePath) {
  let out = '<div class="nav-links">\n';
  out += '      <a href="/"' + (pagePath === '/' ? ' class="active"' : '') + '>Home</a>\n';
  for (const group of NAV) {
    const isCurrent = group.items.some(([href]) => href === pagePath);
    out += '      <div class="nav-dropdown' + (isCurrent ? ' current' : '') + '">\n';
    out += '        <button class="nav-dropdown-trigger" type="button">' + group.label + ' ' + SVG + '</button>\n';
    out += '        <div class="nav-dropdown-menu">\n';
    for (const [href, label] of group.items) {
      out += '          <a href="' + href + '"' + (href === pagePath ? ' class="active"' : '') + '>' + label + '</a>\n';
    }
    out += '        </div>\n      </div>\n';
  }
  out += '    </div>';
  return out;
}

function pages() {
  const list = [path.join(ROOT, 'index.html')];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue;
    const p = path.join(ROOT, d.name, 'index.html');
    if (fs.existsSync(p)) list.push(p);
  }
  return list;
}

let changed = 0, skipped = 0;
for (const file of pages()) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const pagePath = rel === 'index.html' ? '/' : '/' + rel.replace(/\/index\.html$/, '') + '/';
  const html = fs.readFileSync(file, 'utf8');
  const re = /<div class="nav-links">[\s\S]*?\n    <\/div>(?=\s*<div class="nav-cta-wrap">)/;
  if (!re.test(html)) { console.log('SKIP (no nav-links block before nav-cta-wrap): ' + rel); skipped++; continue; }
  const next = html.replace(re, buildBlock(pagePath));
  if (next === html) continue;
  changed++;
  if (DRY) console.log('would update: ' + rel);
  else { fs.writeFileSync(file, next); console.log('updated: ' + rel); }
}
console.log((DRY ? 'dry-run: ' : '') + changed + ' page(s) changed, ' + skipped + ' skipped');
