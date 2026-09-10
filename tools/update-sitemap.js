#!/usr/bin/env node
/**
 * update-sitemap.js — keep sitemap.xml in step with the pages that actually
 * exist. Adds any missing marketing page, refreshes <lastmod> for pages whose
 * file changed today, and never removes a hand-tuned entry's priority.
 *
 *   node tools/update-sitemap.js [--touch path,path,...]
 *
 * Pages under /studios/ are the fictional partner sites; they get a lower
 * priority and a monthly changefreq. /login/ and /dashboard/ stay out (they
 * are disallowed in robots.txt).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITEMAP = path.join(ROOT, 'sitemap.xml');
const BASE = 'https://cerberusac.dev';
const TODAY = new Date().toISOString().slice(0, 10);

const EXCLUDE = new Set(['login', 'dashboard', 'site-anticheat', 'site-gamekey', 'tools', 'js', 'css', 'data', 'downloads', 'node_modules']);
const PRIORITY = {
  '/': '1.0', '/docs/': '0.8', '/sdk/': '0.8', '/api/': '0.8', '/plans/': '0.8',
  '/downloads/': '0.7', '/readiness/': '0.7', '/access/': '0.7', '/appeal/': '0.7'
};

function discover() {
  const urls = ['/'];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || EXCLUDE.has(d.name)) continue;
    if (d.name === 'studios') {
      for (const s of fs.readdirSync(path.join(ROOT, 'studios'), { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        if (fs.existsSync(path.join(ROOT, 'studios', s.name, 'index.html'))) urls.push('/studios/' + s.name + '/');
      }
      continue;
    }
    if (fs.existsSync(path.join(ROOT, d.name, 'index.html'))) urls.push('/' + d.name + '/');
  }
  // /downloads/ has an index.html but its directory is excluded above
  if (fs.existsSync(path.join(ROOT, 'downloads', 'index.html'))) urls.push('/downloads/');
  return urls;
}

const xml = fs.readFileSync(SITEMAP, 'utf8');
const existing = new Map();
const blockRe = /<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g;
let m;
while ((m = blockRe.exec(xml))) existing.set(m[1].replace(BASE, ''), m[0]);

const touch = new Set();
const ti = process.argv.indexOf('--touch');
if (ti !== -1 && process.argv[ti + 1]) process.argv[ti + 1].split(',').forEach(p => touch.add(p.trim()));

const wanted = discover();
const out = [];
let added = 0, touched = 0;

for (const url of wanted) {
  const isStudio = url.startsWith('/studios/');
  const prio = PRIORITY[url] || (isStudio ? '0.4' : '0.6');
  const freq = isStudio ? 'monthly' : (PRIORITY[url] ? 'weekly' : 'monthly');
  let block = existing.get(url);
  if (!block) {
    added++;
    block = '  <url>\n    <loc>' + BASE + url + '</loc>\n    <lastmod>' + TODAY +
      '</lastmod>\n    <changefreq>' + freq + '</changefreq>\n    <priority>' + prio + '</priority>\n  </url>';
  } else if (touch.has(url)) {
    touched++;
    block = block.replace(/<lastmod>[^<]*<\/lastmod>/, '<lastmod>' + TODAY + '</lastmod>');
  }
  out.push(block.replace(/^\s*<url>/, '  <url>'));
}

const stale = [...existing.keys()].filter(u => !wanted.includes(u));
const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  out.join('\n') + '\n</urlset>\n';
fs.writeFileSync(SITEMAP, body);

console.log('sitemap: ' + wanted.length + ' urls (' + added + ' added, ' + touched + ' lastmod refreshed)');
if (stale.length) console.log('dropped (no index.html on disk): ' + stale.join(', '));
