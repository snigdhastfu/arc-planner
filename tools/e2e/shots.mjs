// Screenshot every screen at 390x844 and 1280x800 into tools/e2e/shots/.
// usage: node shots.mjs [baseURL]
// The scene mirrors the mockups: sample data loaded at 08:00 on Tue 3 Nov
// 2026 (Asia/Kolkata), reopened mid-afternoon so the morning has drifted.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'http://localhost:8090/';
const OUT = new URL(process.env.REDUCED ? './shots/reduced/' : './shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const MORNING = '2026-11-03T08:00:00+05:30';
const AFTERNOON = '2026-11-03T15:21:40+05:30';
const EVENING = '2026-11-03T22:05:00+05:30';

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const problems = [];

async function scene(viewport, tag) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, timezoneId: 'Asia/Kolkata', reducedMotion: process.env.REDUCED ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  const origin = new URL(base).origin;
  page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) problems.push(`[${tag}] other-origin request: ${r.url()}`); });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${tag}] console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${tag}] page error: ${e.message}`));
  const open = async (now, hash) => {
    await page.goto(`${base}?now=${encodeURIComponent(now)}#/${hash}`);
    await page.waitForFunction(() => globalThis.__arcCore, null, { timeout: 20000 });
    await page.waitForTimeout(150);
  };
  // first run: onboarding
  await open(MORNING, 'today');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}${tag}-00-onboarding.png` });
  await page.evaluate(async () => { const m = await import('./js/state.js'); await m.loadSample(); });
  await page.keyboard.press('Escape');
  // afternoon: drifted
  await open(AFTERNOON, 'today');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}${tag}-01-today.png` });
  for (const [hash, name, wait] of [['routines', '02-routines', 1600], ['guided/morning', '03-guided', 1400], ['review', '04-review', 2200], ['horizon', '05-horizon', 2000], ['settings', '08-settings', 1400]]) {
    await page.evaluate((h) => { location.hash = `#/${h}`; }, hash);
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${OUT}${tag}-${name}.png` });
  }
  // sheets
  await page.evaluate(() => { location.hash = '#/today'; });
  await page.waitForTimeout(800);
  await page.click('.nav-plus');
  await page.waitForTimeout(500);
  await page.keyboard.type('chem exam nov 20, want 12h prep', { delay: 8 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}${tag}-06-quickadd.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.evaluate(async () => { const m = await import('./js/ui/editor.js'); const s = await import('./js/state.js'); m.openEditor(s.itemById('s-stats')); });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}${tag}-07-editor.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.evaluate(async () => { const m = await import('./js/ui/picker.js'); m.openPicker({ current: 'flask', color: '#B3D7F2' }); });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}${tag}-09-picker.png` });
  await page.keyboard.press('Escape');
  // evening: tuck in postcard
  await open(EVENING, 'today');
  await page.waitForTimeout(1200);
  const tuck = await page.$('.pill-tuck');
  if (tuck) { await tuck.click(); await page.waitForTimeout(4200); await page.screenshot({ path: `${OUT}${tag}-10-postcard.png` }); }
  else problems.push(`[${tag}] no Tuck in pill in the evening`);
  await ctx.close();
}

await scene({ width: 390, height: 844 }, 'm');
await scene({ width: 1280, height: 800 }, 'd');
await browser.close();
console.log(problems.length ? problems.join('\n') : 'no console errors, no other-origin requests');
process.exit(problems.length ? 1 : 0);
