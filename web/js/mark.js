// The in-app logo mark (inline so it takes currentColor). Settings can switch
// between A/B/C at runtime; the home-screen icon changes only via the build.
const cache = {};
let current = document.body.dataset.logo || 'B';

export async function loadMarks(logo) {
  if (logo) current = logo;
  await Promise.all(['A', 'B', 'C'].map(async (k) => {
    if (cache[k]) return;
    try {
      const txt = await fetch(`img/mark-${k}.svg`).then((r) => (r.ok ? r.text() : ''));
      cache[k] = txt.replace('<svg ', '<svg width="100%" height="100%" aria-hidden="true" focusable="false" ');
    } catch (_) { cache[k] = ''; }
  }));
}
export function setMark(logo) { current = logo; document.querySelectorAll('[data-mark]').forEach((el) => { el.innerHTML = cache[current] || ''; }); }
export const markFor = (k) => cache[k] || '';
export function markSVG() { return `<span class="mark" data-mark>${cache[current] || ''}</span>`; }
