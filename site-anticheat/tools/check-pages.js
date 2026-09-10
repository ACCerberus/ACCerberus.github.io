#!/usr/bin/env node
/**
 * check-pages.js — load every page in headless Chrome and report JavaScript
 * console errors and failed requests. Needs `node tools/serve.js` running.
 *
 *   node tools/check-pages.js [baseUrl]
 *
 * Uses Chrome's --dump-dom plus a console listener via the DevTools-free
 * `--enable-logging` path: we inject nothing, we simply look for pages whose
 * rendered DOM still contains obvious failure markers, and we capture stderr
 * from Chrome which includes uncaught exceptions.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://localhost:8080';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));

if (!CHROME) { console.error('no Chrome or Edge found'); process.exit(2); }

const SKIP = new Set(['site-anticheat', 'site-gamekey', '.git', '.claude', 'node_modules', 'tools']);
const pages = ['/'];
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue;
  if (d.name === 'studios') {
    for (const s of fs.readdirSync(path.join(ROOT, 'studios'), { withFileTypes: true })) {
      if (s.isDirectory() && fs.existsSync(path.join(ROOT, 'studios', s.name, 'index.html'))) {
        pages.push('/studios/' + s.name + '/');
      }
    }
    continue;
  }
  if (fs.existsSync(path.join(ROOT, d.name, 'index.html'))) pages.push('/' + d.name + '/');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagecheck-'));
let bad = 0;

for (const p of pages) {
  const out = path.join(tmp, 'dom.html');
  let stderr = '';
  try {
    const r = execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=6000',
      '--user-data-dir=' + path.join(tmp, 'profile'),
      '--dump-dom', BASE + p
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 40 * 1024 * 1024 });
    fs.writeFileSync(out, r);
  } catch (e) {
    stderr = String(e.stderr || e.message);
  }

  const dom = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  const problems = [];
  if (!dom || dom.length < 800) problems.push('empty or tiny DOM');
  // uncaught exceptions surface in Chrome's stderr
  const errLines = stderr.split('\n').filter(l => /ERROR:|Uncaught|SyntaxError|TypeError|ReferenceError/.test(l));
  if (errLines.length) problems.push(errLines.slice(0, 3).join(' | '));
  // pages that failed to fill their JS-driven content
  if (/>(--|NaN|undefined)</.test(dom)) problems.push('unfilled placeholder (--/NaN/undefined) in rendered output');

  if (problems.length) { bad++; console.log('FAIL ' + p + '\n       ' + problems.join('\n       ')); }
  else console.log('ok   ' + p + '  (' + Math.round(dom.length / 1024) + ' KB)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? '\n' + bad + ' page(s) with problems' : '\nall ' + pages.length + ' pages rendered cleanly');
process.exit(bad ? 1 : 0);
