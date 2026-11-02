// Offline start test for the web app: a real Chrome with the service worker. Opens the app online, lets the
// service worker save itself, stops the web server ("no signal") and reloads: the app must start, not sit on
// "Loading LightKeeper...". Then the same right after an update (new build token). Exit 1 on failure.
//
//   node tools/test_offline_boot.mjs            (CHROME=path/to/chrome to override the browser)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5399;
const URL0 = `http://127.0.0.1:${PORT}/lightkeeper/`;
const CHROME = process.env.CHROME || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv = null;
const up = () => { srv = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: SITE, stdio: 'ignore' }); };
const down = () => { srv?.kill(); srv = null; };
const versionFile = path.join(SITE, 'lightkeeper', 'version.json');
const swFile = path.join(SITE, 'lightkeeper', 'sw.js');
const original = fs.readFileSync(versionFile, 'utf8');
const originalSw = fs.readFileSync(swFile, 'utf8');
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-offline-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9399', `--user-data-dir=${prof}`, '--no-first-run', '--no-sandbox', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const done = (code) => { down(); chrome.kill(); fs.writeFileSync(versionFile, original); fs.writeFileSync(swFile, originalSw); setTimeout(() => process.exit(code), 300); };

try {
  up();
  let tabs = null;
  for (let i = 0; i < 40 && !tabs; i++) { await sleep(500); tabs = await fetch('http://127.0.0.1:9399/json').then((r) => r.json()).catch(() => null); }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const started = async (label) => {
    for (let t0 = Date.now(); Date.now() - t0 < 30000; await sleep(500)) {
      if (await ev('!!window.lkBooted && !document.getElementById("boot-splash")').catch(() => false)) { console.log(`ok    ${label}`); return; }
    }
    failed += 1;
    console.log(`FAIL  ${label}: stuck on "${await ev('document.getElementById("boot-splash")?.innerText')}"`);
  };
  const swReady = () => ev('new Promise(r=>{const t=setInterval(()=>{if(navigator.serviceWorker.controller){clearInterval(t);r(1)}},300); setTimeout(()=>r(0),20000)})');

  await send('Page.navigate', { url: URL0 });
  await started('starts online');
  if (!(await swReady())) { failed += 1; console.log('FAIL  service worker never took control'); }
  await sleep(5000);                                   // let it finish saving the app files
  down(); await sleep(500);
  await send('Page.reload'); await started('starts with no connection');

  up(); await sleep(1500);
  fs.writeFileSync(versionFile, JSON.stringify({ version: `${JSON.parse(original).version}-test` }) + '\n');
  fs.writeFileSync(swFile, originalSw.replace(/const VERSION = '([^']+)'/, "const VERSION = '$1-test'"));
  await send('Page.reload'); await sleep(3000); await started('updates online'); await sleep(6000);
  down(); await sleep(500);
  await send('Page.reload'); await started('starts with no connection right after an update');
} catch (err) {
  failed += 1; console.log(`FAIL  ${err.message}`);
}
console.log(failed ? `${failed} check(s) failed` : 'Offline start works.');
done(failed ? 1 : 0);
