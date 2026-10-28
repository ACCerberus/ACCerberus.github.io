/** Tiny SVG time-series chart for the detail card: one series, recessive grid, direct labels on
 *  highlighted points, hover readout. Returns an SVG element (append it or use outerHTML). */

import { el } from './ui.js?v=2.0.9c-3';

const W = 330; const PAD = { l: 34, r: 10, t: 14, b: 22 };

/**
 * points:     [{ t: epoch ms, v: number }] sorted by t
 * highlights: [{ t, v, label }] drawn as dots with a direct label
 * opts:       { unit: 'ft', height: 130, zero: false (draw a 0 line), now: epoch ms | null, fmtV: fn }
 */
export function timeChart(points, highlights = [], opts = {}) {
  const H = opts.height || 130;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tchart', width: '100%', height: H, role: 'img', 'aria-label': opts.title || 'chart' });
  if (points.length < 2) { svg.append(el('text', { x: W / 2, y: H / 2, class: 'tc-muted', 'text-anchor': 'middle', text: 'No data' })); return svg; }
  const fmtV = opts.fmtV || ((v) => `${v.toFixed(1)}${opts.unit ? ' ' + opts.unit : ''}`);
  const t0 = points[0].t; const t1 = points[points.length - 1].t;
  let vMin = Math.min(...points.map((p) => p.v)); let vMax = Math.max(...points.map((p) => p.v));
  if (opts.zero) { vMin = Math.min(vMin, 0); vMax = Math.max(vMax, 0); }
  const span = (vMax - vMin) || 1; vMin -= span * 0.12; vMax += span * 0.12;
  const x = (t) => PAD.l + ((t - t0) / ((t1 - t0) || 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - vMin) / (vMax - vMin)) * (H - PAD.t - PAD.b);

  // Recessive grid: 3 horizontal lines with value labels, time ticks every 6 h
  for (let i = 0; i <= 2; i++) {
    const v = vMin + ((vMax - vMin) * i) / 2;
    svg.append(el('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: 'tc-grid' }));
    svg.append(el('text', { x: PAD.l - 4, y: y(v) + 3, class: 'tc-axis', 'text-anchor': 'end', text: fmtV(v).replace(/\s.*/, '') }));
  }
  const hours = (t1 - t0) / 3600000;
  const step = hours > 72 ? 24 : hours > 30 ? 12 : 6;
  const first = new Date(t0); first.setMinutes(0, 0, 0); first.setHours(Math.ceil(first.getHours() / step) * step);
  for (let t = first.getTime(); t <= t1; t += step * 3600000) {
    const d = new Date(t);
    const label = step >= 24 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : `${String(d.getHours()).padStart(2, '0')}:00`;
    svg.append(el('text', { x: x(t), y: H - 6, class: 'tc-axis', 'text-anchor': 'middle', text: label }));
  }
  if (opts.zero) svg.append(el('line', { x1: PAD.l, x2: W - PAD.r, y1: y(0), y2: y(0), class: 'tc-zero' }));

  // Series
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  svg.append(el('path', { d: `${d} L${x(t1).toFixed(1)},${y(vMin)} L${x(t0).toFixed(1)},${y(vMin)} Z`, class: 'tc-area' }));
  svg.append(el('path', { d, class: 'tc-line' }));

  // "Now" marker
  if (opts.now && opts.now >= t0 && opts.now <= t1) {
    svg.append(el('line', { x1: x(opts.now), x2: x(opts.now), y1: PAD.t, y2: H - PAD.b, class: 'tc-now' }));
    svg.append(el('text', { x: x(opts.now) + 3, y: PAD.t + 9, class: 'tc-axis', text: 'now' }));
  }

  // Direct labels on highlights (alternate above/below to avoid collisions)
  highlights.forEach((h, i) => {
    const px = x(h.t); const py = y(h.v);
    svg.append(el('circle', { cx: px, cy: py, r: 4, class: 'tc-dot' }));
    const above = i % 2 === 0 ? h.v >= (vMin + vMax) / 2 : h.v > (vMin + vMax) / 2;
    const ty = above ? py - 8 : py + 14;
    const anchor = px < PAD.l + 30 ? 'start' : px > W - PAD.r - 30 ? 'end' : 'middle';
    svg.append(el('text', { x: px, y: ty, class: 'tc-label', 'text-anchor': anchor, text: h.label }));
  });

  // Hover readout: nearest point
  const cross = el('line', { y1: PAD.t, y2: H - PAD.b, class: 'tc-cross', visibility: 'hidden' });
  const dot = el('circle', { r: 3.5, class: 'tc-hover', visibility: 'hidden' });
  const txt = el('text', { class: 'tc-readout', 'text-anchor': 'middle', visibility: 'hidden' });
  svg.append(cross, dot, txt);
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((mx - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = x(best.t); const py = y(best.v);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    const when = new Date(best.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    txt.textContent = `${when} · ${fmtV(best.v)}`;
    txt.setAttribute('x', Math.max(PAD.l + 50, Math.min(W - PAD.r - 50, px))); txt.setAttribute('y', PAD.t + 9); txt.setAttribute('visibility', 'visible');
  });
  svg.addEventListener('mouseleave', () => [cross, dot, txt].forEach((n) => n.setAttribute('visibility', 'hidden')));
  return svg;
}

/** Smooth a sparse high/low series (tide extremes) into a cosine curve sampled every `stepMin`. */
export function interpolateExtremes(extremes, stepMin = 15) {
  const out = [];
  for (let i = 0; i < extremes.length - 1; i++) {
    const a = extremes[i]; const b = extremes[i + 1];
    for (let t = a.t; t < b.t; t += stepMin * 60000) {
      const f = (t - a.t) / (b.t - a.t);
      out.push({ t, v: a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2 });
    }
  }
  if (extremes.length) out.push({ t: extremes[extremes.length - 1].t, v: extremes[extremes.length - 1].v });
  return out;
}

/** Parse NOAA / USGS time strings ("2026-05-04 06:12", ISO) into epoch ms (local). */
export function parseTime(s) {
  if (!s) return NaN;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  return d.getTime();
}
