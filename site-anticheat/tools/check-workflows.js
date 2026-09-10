#!/usr/bin/env node
/**
 * check-workflows.js — sanity-check the GitHub Actions workflows without a
 * YAML library: verify the step/run structure parses, then extract every
 * `run:` block and syntax-check it with `bash -n`.
 *   node tools/check-workflows.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['.github/workflows/content-engine.yml', '.github/workflows/heartbeat.yml'];

let failures = 0;

for (const rel of files) {
  const full = path.join(ROOT, rel);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  const steps = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameM = line.match(/^(\s*)- name:\s*(.+)$/);
    if (nameM) { cur = { name: nameM[2].trim(), line: i + 1, run: null }; steps.push(cur); continue; }
    const runM = line.match(/^(\s*)run:\s*\|\s*$/);
    if (runM && cur) {
      const indent = runM[1].length + 2;
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') { body.push(''); continue; }
        const lead = l.match(/^\s*/)[0].length;
        if (lead < indent) break;
        body.push(l.slice(indent));
      }
      cur.run = body.join('\n');
      cur.runLine = i + 1;
      i = j - 1;
    }
  }

  const withRun = steps.filter(s => s.run);
  console.log('\n' + rel + ': ' + steps.length + ' steps, ' + withRun.length + ' with run blocks');

  // indentation sanity: every line must use spaces only
  const tabbed = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /^\s*\t/.test(l));
  if (tabbed.length) {
    failures++;
    console.log('  TAB INDENTATION at lines: ' + tabbed.map(([n]) => n).join(', '));
  }

  for (const s of withRun) {
    const tmp = path.join(os.tmpdir(), 'wf_' + Math.random().toString(36).slice(2) + '.sh');
    fs.writeFileSync(tmp, s.run);
    try {
      execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
      console.log('  ok   ' + s.name);
    } catch (e) {
      failures++;
      console.log('  BASH ERROR in step "' + s.name + '" (line ' + s.runLine + '):');
      console.log('    ' + String(e.stderr || e.message).trim().split('\n').join('\n    '));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

console.log(failures ? '\n' + failures + ' problem(s)' : '\nall workflow run blocks parse');
process.exit(failures ? 1 : 0);
