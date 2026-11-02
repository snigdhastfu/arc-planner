// Renders the 16 reference doodles exactly as drawn (paths are never altered).
// Stroke widths follow SPEC section 11 so output matches the mockups' d().
let DOODLES = {};
let KEYWORDS = {};

export async function loadDoodles() {
  const [d, k] = await Promise.all([
    fetch('data/doodles.json').then((r) => r.json()),
    fetch('data/doodle-keywords.json').then((r) => r.json()),
  ]);
  DOODLES = d; KEYWORDS = k;
}
export const doodleNames = () => Object.keys(DOODLES);
export const keywordsFor = (n) => KEYWORDS[n] || [];

const r1 = (n) => Math.round(n * 10) / 10;
/** Stroke width for the main layer at a given rendered size. */
export function strokeFor(size) { return Math.max(1.7, r1((64 / size) * 1.5)); }
const fmt = (n) => n.toFixed(1);

/**
 * doodleSVG(name, size, color) -> inline SVG string.
 * opts: { cls, boil (line boil on screen), draw (paths get data-draw for draw-on), label }
 */
export function doodleSVG(name, size, color, opts = {}) {
  const d = DOODLES[name] || DOODLES.sparkle;
  if (!d) return '';
  const w = strokeFor(size);
  const layers = [
    ['main', w, ''],
    ['thick', r1(w * 1.9), ' opacity=".85"'],
    ['fine', r1(w * 0.55), ''],
    ['dots', r1(w * 1.7), ''],
  ];
  const draw = opts.draw === false ? '' : ' data-draw';
  let paths = '';
  for (const [k, sw, extra] of layers) {
    if (d[k]) paths += `<path${draw} stroke-width="${fmt(sw)}"${extra} d="${d[k]}"/>`;
  }
  const cls = `doodle${opts.cls ? ' ' + opts.cls : ''}`;
  const a11y = opts.label ? ` role="img" aria-label="${opts.label}"` : ' aria-hidden="true"';
  return `<svg class="${cls}" data-doodle="${name}"${opts.boil === false ? '' : ' data-boil'} width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round"${a11y}><g class="dg">${paths}</g></svg>`;
}

/** Same doodle but positioned inside a parent SVG (for the arc and horizon). */
export function doodleInSVG(name, x, y, size, color, opts = {}) {
  return doodleSVG(name, size, color, opts).replace('<svg ', `<svg x="${r1(x)}" y="${r1(y)}" `);
}

/** Local doodle match used only for instant previews; the Go core is authoritative. */
export function localMatch(title) {
  const t = ` ${String(title).toLowerCase().replace(/[^a-z]+/g, ' ')} `;
  let best = '', bestScore = 0;
  for (const n of Object.keys(KEYWORDS).sort()) {
    let s = 0;
    for (const k of KEYWORDS[n]) if (t.includes(` ${k} `)) s += k.length;
    if (s > bestScore) { best = n; bestScore = s; }
  }
  return best;
}
