// Installability check via the DevTools protocol (dev-only).
//   node install.mjs [baseURL]
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://localhost:8090/';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// a persistent (non-incognito) profile, as a real browser would have
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'arc-install-')), { executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const browser = ctx;
const page = await ctx.newPage();
await page.goto(base);
await page.waitForFunction(() => globalThis.__arcCore);
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await page.waitForFunction(() => globalThis.__arcCore);
const cdp = await ctx.newCDPSession(page);
const m = await cdp.send('Page.getAppManifest');
const inst = await cdp.send('Page.getInstallabilityErrors');
const manifest = JSON.parse(m.data);
console.log('manifest url:', m.url.replace(base, './'), '| parse errors:', m.errors.length);
console.log('name:', manifest.name, '| start_url:', manifest.start_url, '| scope:', manifest.scope, '| display:', manifest.display, '| icons:', manifest.icons.map((i) => `${i.sizes}${i.purpose === 'maskable' ? ' maskable' : ''}`).join(', '));
console.log('installability errors:', inst.installabilityErrors.length ? JSON.stringify(inst.installabilityErrors) : 'none (installable)');
await browser.close();
process.exit(inst.installabilityErrors.length || m.errors.length ? 1 : 0);
