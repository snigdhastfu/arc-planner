// Day Arc geometry (SPEC section 11). x maps WakeMin..SleepMin to 40..318 in a
// 358x200 viewBox, leaving room for the now marker; y comes from energy windows (high=50, med=110,
// low=170), smoothstep-blended ~40 min at boundaries, sampled every 10 min,
// and drawn as Catmull-Rom -> cubic Bezier. Nodes are evaluated on the same
// spline, so they always sit exactly on the curve.

export const VIEW = { w: 358, h: 200, x0: 40, x1: 318 };
const LEVEL_Y = { high: 50, med: 110, low: 170 };
const EDGE_Y = 175;
const BLEND = 80; // minutes each side of the smoothing window
const EDGE = 50;   // minutes to rise from / settle into sleep

const smooth = (t) => t * t * (3 - 2 * t);
const r1 = (n) => Math.round(n * 10) / 10;

export function createArc(profile) {
  const wake = profile.wakeMin, sleep = profile.sleepMin;
  const span = Math.max(60, sleep - wake);
  const energy = [...(profile.energy || [])].sort((a, b) => a.startMin - b.startMin);
  const rawY = (m) => {
    for (const w of energy) if (m >= w.startMin && m < w.endMin) return LEVEL_Y[w.level] ?? LEVEL_Y.med;
    return LEVEL_Y.med;
  };
  // Smooth the stepped energy levels: sample every 5 min, then a smoothstep-
  // weighted moving average (~2 h window) so the arc reads as gentle hills.
  const raw = [];
  for (let m = wake; m <= sleep; m += 5) raw.push(rawY(m));
  const R = BLEND / 5; // samples each side
  const w = [];
  for (let k = -R; k <= R; k++) w.push(smooth(1 - Math.abs(k) / (R + 1)));
  const sm = raw.map((_, i) => {
    let acc = 0, tot = 0;
    for (let k = -R; k <= R; k++) {
      const j = Math.min(raw.length - 1, Math.max(0, i + k));
      acc += raw[j] * w[k + R]; tot += w[k + R];
    }
    return acc / tot;
  });
  const yAt = (m) => {
    const f = (Math.min(sleep, Math.max(wake, m)) - wake) / 5;
    const i = Math.floor(f), t = f - i;
    let y = sm[i] + ((sm[Math.min(sm.length - 1, i + 1)] ?? sm[i]) - sm[i]) * t;
    // the day rises out of sleep and settles back into it
    const edge = Math.min(m - wake, sleep - m);
    if (edge < EDGE) y = EDGE_Y + (y - EDGE_Y) * smooth(Math.max(0, edge) / EDGE);
    return y;
  };
  const xOf = (m) => VIEW.x0 + ((Math.min(sleep, Math.max(wake, m)) - wake) / span) * (VIEW.x1 - VIEW.x0);
  const minOfX = (x) => wake + ((x - VIEW.x0) / (VIEW.x1 - VIEW.x0)) * span;

  const pts = [];
  for (let m = wake; m < sleep; m += 10) pts.push([xOf(m), yAt(m)]);
  pts.push([xOf(sleep), yAt(sleep)]);

  // Catmull-Rom segments as Bezier control points
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    segs.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  const bez = (s, t) => {
    const u = 1 - t;
    return [
      u * u * u * s[0][0] + 3 * u * u * t * s[1][0] + 3 * u * t * t * s[2][0] + t * t * t * s[3][0],
      u * u * u * s[0][1] + 3 * u * u * t * s[1][1] + 3 * u * t * t * s[2][1] + t * t * t * s[3][1],
    ];
  };
  /** Point on the drawn curve at minute m. */
  const point = (m) => {
    const mm = Math.min(sleep, Math.max(wake, m));
    const f = (mm - wake) / 10;
    const i = Math.min(segs.length - 1, Math.floor(f));
    const segLen = i === segs.length - 1 ? (sleep - (wake + i * 10)) / 10 : 1;
    const t = Math.min(1, (f - i) / (segLen || 1));
    return bez(segs[i], t);
  };
  const pathTo = (mEnd) => {
    const end = Math.min(sleep, Math.max(wake, mEnd));
    let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
    for (let i = 0; i < segs.length; i++) {
      const segStart = wake + i * 10;
      if (segStart >= end) break;
      const s = segs[i];
      const segEnd = Math.min(sleep, segStart + 10);
      if (end >= segEnd) {
        d += ` C${r1(s[1][0])} ${r1(s[1][1])} ${r1(s[2][0])} ${r1(s[2][1])} ${r1(s[3][0])} ${r1(s[3][1])}`;
      } else {
        // split the Bezier at t (de Casteljau) so the solid part ends exactly at now
        const t = (end - segStart) / (segEnd - segStart);
        const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const a = lerp(s[0], s[1]), b = lerp(s[1], s[2]), c = lerp(s[2], s[3]);
        const ab = lerp(a, b), bc = lerp(b, c), p = lerp(ab, bc);
        d += ` C${r1(a[0])} ${r1(a[1])} ${r1(ab[0])} ${r1(ab[1])} ${r1(p[0])} ${r1(p[1])}`;
      }
    }
    return d;
  };
  const full = pathTo(sleep);
  /** Area under the past part of the curve. */
  const areaTo = (mEnd) => {
    const e = point(mEnd);
    return `${pathTo(mEnd)} L${r1(e[0])} ${VIEW.h - 4} L${r1(pts[0][0])} ${VIEW.h - 4} Z`;
  };
  /** Nearest high-energy window start/middle within `range` minutes (magnetic snap). */
  const peakNear = (m, range = 20) => {
    let best = null;
    for (const w of energy) {
      if (w.level !== 'high') continue;
      for (const c of [w.startMin]) if (Math.abs(c - m) <= range && (best === null || Math.abs(c - m) < Math.abs(best - m))) best = c;
    }
    return best;
  };
  return { wake, sleep, span, xOf, minOfX, yAt, point, full, pathTo, areaTo, peakNear, levelAt: (m) => {
    for (const w of energy) if (m >= w.startMin && m < w.endMin) return w.level;
    return 'med';
  } };
}

/** Node radius from block minutes: clamp(8 + minutes/6, 8, 24). */
export const nodeRadius = (minutes) => Math.max(8, Math.min(24, 8 + minutes / 6));

/** Tint for the filled past area: navajo morning, vanilla midday, blush evening. */
export function tintFor(min) {
  if (min < 12 * 60) return 'var(--navajo)';
  if (min < 17 * 60) return 'var(--vanilla)';
  return 'var(--blush)';
}

/** Time-axis labels placed at their true positions. */
export function axisLabels(arc) {
  const out = [];
  const marks = [arc.wake, 12 * 60, 16 * 60, 21 * 60].filter((m, i, a) => m >= arc.wake && m <= arc.sleep && a.indexOf(m) === i);
  for (const m of marks) out.push({ m, x: arc.xOf(m) });
  return out;
}
