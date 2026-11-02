// Deterministic hand-drawn shapes. The same seed (usually an item id) always
// produces the same slightly wobbly outline, so nothing flickers on re-render.
import { drawOn } from './anim.js';

export function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed) {
  let a = typeof seed === 'number' ? seed : hash(String(seed));
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => (Math.round(n * 10) / 10).toString();

/** A slightly irregular rounded rectangle path inside a w x h box. */
export function roughRect(w, h, r, seed, { jitter = 1.1, inset = 1.5 } = {}) {
  const R = rng(seed);
  const j = () => (R() - 0.5) * 2 * jitter;
  r = Math.min(r, (w - inset * 2) / 2, (h - inset * 2) / 2);
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  // start a touch past the top-left corner and overshoot the end, like a pen
  const o = 2 + R() * 3;
  const pts = [
    `M${f(x0 + r - o)} ${f(y0 + j() * 0.4)}`,
    `C${f(x0 + (w * 0.35) + j())} ${f(y0 + j())} ${f(x1 - w * 0.35 + j())} ${f(y0 + j())} ${f(x1 - r)} ${f(y0 + j() * 0.4)}`,
    `Q${f(x1 + j() * 0.3)} ${f(y0 + j() * 0.3)} ${f(x1 + j() * 0.4)} ${f(y0 + r)}`,
    `C${f(x1 + j())} ${f(y0 + h * 0.35 + j())} ${f(x1 + j())} ${f(y1 - h * 0.35 + j())} ${f(x1 + j() * 0.4)} ${f(y1 - r)}`,
    `Q${f(x1 + j() * 0.3)} ${f(y1 + j() * 0.3)} ${f(x1 - r)} ${f(y1 + j() * 0.4)}`,
    `C${f(x1 - w * 0.35 + j())} ${f(y1 + j())} ${f(x0 + w * 0.35 + j())} ${f(y1 + j())} ${f(x0 + r)} ${f(y1 + j() * 0.4)}`,
    `Q${f(x0 + j() * 0.3)} ${f(y1 + j() * 0.3)} ${f(x0 + j() * 0.4)} ${f(y1 - r)}`,
    `C${f(x0 + j())} ${f(y1 - h * 0.35 + j())} ${f(x0 + j())} ${f(y0 + h * 0.35 + j())} ${f(x0 + j() * 0.4)} ${f(y0 + r)}`,
    `Q${f(x0 + j() * 0.3)} ${f(y0 + j() * 0.3)} ${f(x0 + r + o)} ${f(y0 + j() * 0.5)}`,
  ];
  return pts.join(' ');
}

/** A wobbly circle, for rings and stamps. */
export function roughCircle(cx, cy, r, seed, { jitter = 0.8, turns = 1.06 } = {}) {
  const R = rng(seed);
  const n = 10;
  const start = R() * Math.PI * 2;
  const pts = [];
  for (let i = 0; i <= n * turns; i++) {
    const a = start + (i / n) * Math.PI * 2;
    const rr = r + (R() - 0.5) * 2 * jitter;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return catmull(pts);
}

/** A hand-drawn horizontal line with a little waver, for progress strokes. */
export function roughLine(x0, x1, y, seed, { amp = 1.2, segs = 6 } = {}) {
  const R = rng(seed);
  const pts = [];
  for (let i = 0; i <= segs; i++) pts.push([x0 + ((x1 - x0) * i) / segs, y + (i === 0 || i === segs ? 0 : (R() - 0.5) * 2 * amp)]);
  return catmull(pts);
}

/** Catmull-Rom spline through points, as cubic Beziers. */
export function catmull(pts) {
  if (pts.length < 2) return '';
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => entries.forEach((e) => paint(e.target))) : null;

function paint(el) {
  const svg = el.querySelector(':scope > svg.rough');
  if (!svg) return;
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h) return;
  const o = el._rough;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.firstElementChild.setAttribute('d', roughRect(w, h, o.radius, o.seed, { jitter: o.jitter, inset: o.width / 2 + 0.5 }));
}

/**
 * Give an element a hand-drawn border instead of a CSS one. The SVG sits
 * behind the content and redraws on resize. draw=true draws it on.
 */
export function roughBorder(el, { color = 'currentColor', width = 2, radius = 32, seed = 'x', jitter = 1.1, draw = false, delay = 0 } = {}) {
  if (!el) return;
  el._rough = { radius, seed, jitter, width };
  let svg = el.querySelector(':scope > svg.rough');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'rough');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('preserveAspectRatio', 'none');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('data-draw', '');
    svg.appendChild(p);
    el.prepend(svg);
    if (ro) ro.observe(el);
  }
  const p = svg.firstElementChild;
  p.setAttribute('stroke', color);
  p.setAttribute('stroke-width', String(width));
  paint(el);
  if (draw) drawOn(svg, { delay, duration: 700 });
}

/** Deterministic small tilt in degrees for a tile (about +/-1.5). */
export function tilt(seed, max = 1.5) {
  return Math.round((rng(seed)() * 2 - 1) * max * 100) / 100;
}
