// Quick dev smoke: load the app, load sample data, screenshot Today.
// usage: node smoke.mjs [url] [outDir]
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:8090/';
const out = process.argv[3] || 'shots';
const NOW = '2026-11-03T10:11:40+05:30';

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'Asia/Kolkata' });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${url}?now=${encodeURIComponent(NOW)}#/today`);
await page.waitForFunction(() => globalThis.__arcCore, null, { timeout: 20000 });
console.log('boot', await page.evaluate(() => globalThis.__arcBoot));
await page.evaluate(async () => { const m = await import('./js/state.js'); await m.loadSample(); });
await page.waitForTimeout(400);
await page.evaluate(() => { location.hash = '#/routines'; });
await page.waitForTimeout(300);
await page.evaluate(() => { location.hash = '#/today'; });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/smoke-today.png` });
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
