// Touch-target audit (dev-only): lists visible interactive elements whose
// effective hit area (box + any ::before/::after "hit" expansion) is < 44 px.
//   node a11y.mjs [baseURL]
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:8090/';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Kolkata' })).newPage();
await page.goto(`${base}?now=${encodeURIComponent('2026-11-03T15:21:40+05:30')}#/today`);
await page.waitForFunction(() => globalThis.__arcCore);
await page.evaluate(async () => { const m = await import('./js/state.js'); await m.loadSample(); });
await page.keyboard.press('Escape');
const small = new Set();
for (const h of ['today', 'routines', 'guided/morning', 'review', 'horizon', 'settings']) {
  await page.evaluate((x) => { location.hash = `#/${x}`; }, h);
  await page.waitForTimeout(1500);
  const found = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [tabindex="0"]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest('[hidden]')) continue;
      let w = r.width, h = r.height;
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content !== 'none' && cs.position === 'absolute' && cs.pointerEvents !== 'none') {
          const t = parseFloat(cs.top) || 0, l = parseFloat(cs.left) || 0, b = parseFloat(cs.bottom) || 0, rr = parseFloat(cs.right) || 0;
          if (t < 0 || b < 0) h = Math.max(h, r.height - t - b);
          if (l < 0 || rr < 0) w = Math.max(w, r.width - l - rr);
        }
      }
      if (el.tagName === 'g' || el.closest('svg')) { const hit = el.querySelector('.node-hit'); if (hit) { const hr = hit.getBoundingClientRect(); w = hr.width; h = hr.height; } }
      if (w < 43.5 || h < 43.5) out.push(`${location.hash} ${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  });
  found.forEach((f) => small.add(f));
}
await browser.close();
console.log(small.size ? [...small].join('\n') : 'all interactive targets >= 44 px');
