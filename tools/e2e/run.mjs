// Arc end-to-end acceptance checks (dev-only; never imported by the app).
//   node run.mjs [baseURL] [distDir]
// Drives the real UI in headless Chrome. Covers SPEC section 14:
//  M2: wasm boots, arc.version(), IndexedDB persists, offline shell, SW update banner
//  M3-M5 flows: quick add -> plan -> complete -> skip -> drift -> review -> approve -> undo;
//  guided routine; ICS import then export; backup export then import; postcard save.
// Also asserts: no console errors, no requests to any other origin.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] || 'http://localhost:8090/';
const dist = process.argv[3] || new URL('../../dist/', import.meta.url).pathname;
const NOW = '2026-11-03T09:00:00+05:30';
const tmp = mkdtempSync(join(tmpdir(), 'arc-e2e-'));

const results = [];
const problems = [];
const ok = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`); results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`); if (!cond) process.exitCode = 1; };

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Kolkata', acceptDownloads: true });
const page = await ctx.newPage();
const origin = new URL(base).origin;
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`other-origin request: ${u}`); });
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

const url = (hash = 'today') => `${base}?now=${encodeURIComponent(NOW)}#/${hash}`;
const booted = () => page.waitForFunction(() => globalThis.__arcCore, null, { timeout: 20000 });
const S = (fn) => page.evaluate(fn);
const wait = (ms) => page.waitForTimeout(ms);
const go = async (hash) => { await page.evaluate((h) => { location.hash = `#/${h}`; }, hash); await wait(700); };

// ---------------- M2 ----------------
await page.goto(url());
await booted();
await page.waitForFunction(() => globalThis.__arcBoot);
const boot = await S(() => globalThis.__arcCore);
const version = await S(() => globalThis.__arc.call('version').version);
ok('wasm core boots and arc.version() answers', version === '1.0.0', `v${version}, boot ${boot.ms} ms`);

// onboarding appears on first run; skip it via the UI
await page.waitForSelector('text=Hello! When does your day run?', { timeout: 5000 });
ok('first run shows onboarding', true);
await page.click('text=Skip for now');
await wait(500);

// ---------------- quick add -> plan ----------------
await page.click('.nav-plus');
await page.fill('#qa-input', 'stats assignment due fri 3h');
await wait(400);
const chips = await page.$$eval('.chip', (cs) => cs.map((c) => c.textContent.trim()));
ok('quick add parses into chips', chips.some((c) => c.includes('assignment')) && chips.some((c) => c.includes('3 h')), chips.join(' | '));
await page.click('[data-save]');
await wait(900);
const planned = await S(() => {
  const { S } = globalThis.__arc;
  const it = S.items.find((i) => i.title === 'Stats assignment');
  return { id: it && it.id, blocks: S.plan.blocks.filter((b) => b.itemId === (it && it.id) && b.kind === 'work').length };
});
ok('quick add saves the item and the planner places blocks', planned.id && planned.blocks >= 4, `${planned.blocks} work blocks`);
const persistedBlockIDs = await S(() => {
  const it = globalThis.__arc.S.items.find((i) => i.title === 'Stats assignment');
  return globalThis.__arc.S.plan.blocks.filter((b) => b.itemId === it.id).map((b) => b.id);
});

// IndexedDB persists across reload
await page.reload();
await booted();
const persisted = await S(() => globalThis.__arc.S.items.some((i) => i.title === 'Stats assignment'));
ok('IndexedDB keeps items across a reload', persisted);
const persistedBlocks = await page.evaluate((ids) => ids.every((id) => globalThis.__arc.S.plan.blocks.some((b) => b.id === id)), persistedBlockIDs);
ok('planned blocks survive a reload', persistedBlockIDs.length > 0 && persistedBlocks, `${persistedBlockIDs.length} blocks`);

// Personal quick-add text must parse, save, and receive a persisted plan block.
await page.click('.nav-plus');
await page.fill('#qa-input', 'study DBMS tomorrow 6pm 90 min');
await wait(400);
await page.click('[data-save]');
await wait(900);
const customQuickAdd = await S(() => {
  const item = globalThis.__arc.S.items.find((i) => i.title === 'Study DBMS');
  const block = item && globalThis.__arc.S.plan.blocks.find((b) => b.itemId === item.id);
  const proposed = item && globalThis.__arc.S.proposal && globalThis.__arc.S.proposal.proposed.blocks.some((b) => b.itemId === item.id);
  return { item: !!item, type: item && item.type, scheduled: !!block || !!proposed, start: item && item.start, end: item && item.end };
});
ok('custom quick-add text saves its parsed event and plan', customQuickAdd.item && customQuickAdd.scheduled && customQuickAdd.start.includes('18:00') && customQuickAdd.end.includes('19:30'), `${customQuickAdd.type} ${customQuickAdd.start}–${customQuickAdd.end}`);

// ---------------- complete (keyboard path on the focus card) ----------------
await wait(800);
const first = await S(() => {
  const { S } = globalThis.__arc;
  const b = S.plan.blocks.filter((x) => x.kind === 'work' && x.status === 'planned').sort((a, c) => a.start.localeCompare(c.start))[0];
  return b.id;
});
await page.focus('.focus-card');
await page.keyboard.press('ArrowRight');
await wait(1800);
const afterDone = await S(() => {
  const { S } = globalThis.__arc;
  const it = S.items.find((i) => i.title === 'Stats assignment');
  return { done: S.plan.blocks.filter((b) => b.kind === 'work' && b.status === 'done').length, doneMin: it.doneMin || 0 };
});
ok('finishing the focus card marks the block done and adds DoneMin', afterDone.done === 1 && afterDone.doneMin > 0, `doneMin ${afterDone.doneMin}`);
const live = await page.textContent('#live');
ok('completion is announced in the live region', /finished/i.test(live || ''), live);

// ---------------- skip -> drift -> review -> approve -> undo ----------------
await page.focus('.focus-card');
await page.keyboard.press('ArrowUp');
await wait(1600);
const skipped = await S(() => globalThis.__arc.S.plan.blocks.filter((b) => b.status === 'skipped').length);
ok('swipe-up path puts a block to sleep (sleeping-in)', skipped === 1);
const shelf = await page.$('.shelf-chip');
ok('the sleeping-in shelf shows it', !!shelf);
await page.waitForSelector('.pill-drift', { timeout: 4000 });
ok('drift pill appears', true);
await page.click('.pill-drift');
await wait(1500);
const nChanges = await page.$$eval('[data-change]', (r) => r.length);
ok('review shows the proposed changes', nChanges >= 1, `${nChanges} changes`);
const beforeApprove = await S(() => JSON.stringify(globalThis.__arc.S.plan.blocks));
await page.click('[data-approve]');
await wait(1500);
const afterApprove = await S(() => ({ plan: JSON.stringify(globalThis.__arc.S.plan.blocks), moved: globalThis.__arc.S.plan.blocks.filter((b) => b.status === 'moved').length, drifted: globalThis.__arc.S.drifted }));
ok('approving applies the plan (the sleeping block re-homed)', afterApprove.plan !== beforeApprove && afterApprove.moved === 1 && !afterApprove.drifted);
await page.click('.toast-btn');
await wait(900);
const afterUndo = await S(() => JSON.stringify(globalThis.__arc.S.plan.blocks));
ok('undo restores the previous plan', afterUndo === beforeApprove);

// ---------------- guided routine ----------------
await page.click('.nav-plus');
await page.fill('#qa-input', 'meds every morning with food');
await wait(400);
await page.click('[data-save]');
await wait(700);
await go('routines');
const tiles = await page.$$eval('[data-tile]', (t) => t.map((x) => x.getAttribute('aria-label')));
ok('routines grid shows the new routine', tiles.some((t) => t.startsWith('Meds')), tiles.join(', '));
await page.click('[data-play="morning"]');
await wait(1200);
await page.click('[data-done]');
await wait(2200);
const finale = await page.$('.guided-finale');
const medsDone = await S(() => { const { S } = globalThis.__arc; const it = S.items.find((i) => i.title === 'Meds'); return S.plan.blocks.some((b) => b.itemId === it.id && b.status === 'done'); });
ok('guided flow completes the routine and celebrates', !!finale && medsDone);
await page.click('text=Back to routines');
await wait(800);

// ---------------- ICS import then export ----------------
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:lec-1@uni', 'DTSTART;TZID=Asia/Kolkata:20261104T110000', 'DTEND;TZID=Asia/Kolkata:20261104T120000',
  'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4', 'SUMMARY:Organic chemistry lecture', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:lab-1@uni', 'DTSTART:20261105T083000Z', 'DTEND:20261105T103000Z', 'SUMMARY:Chem lab', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
writeFileSync(join(tmp, 'timetable.ics'), ics);
await go('settings');
await page.setInputFiles('[data-ics]', join(tmp, 'timetable.ics'));
await page.waitForSelector('[data-ics-ok]');
const preview = await page.textContent('[data-ics-preview]');
ok('ICS import previews before confirming', /Organic chemistry lecture/.test(preview) && /4×/.test(preview));
await page.click('[data-ics-ok]');
await wait(800);
const events = await S(() => globalThis.__arc.S.items.filter((i) => i.type === 'event').length);
ok('ICS import adds the events', events === 5, `${events} events`);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-ics-export]')]);
const icsPath = join(tmp, 'out.ics');
await dl.saveAs(icsPath);
const out = readFileSync(icsPath, 'utf8');
ok('ICS export downloads a calendar with routines (RRULE + VALARM) and events', out.startsWith('BEGIN:VCALENDAR\r\n') && /RRULE:FREQ=DAILY/.test(out) && /BEGIN:VALARM/.test(out) && /Organic chemistry lecture/.test(out), dl.suggestedFilename());

// ---------------- backup export then import ----------------
const counts = await S(() => ({ items: globalThis.__arc.S.items.length }));
const [bdl] = await Promise.all([page.waitForEvent('download'), page.click('[data-backup]')]);
const bpath = join(tmp, 'backup.json');
await bdl.saveAs(bpath);
const backup = JSON.parse(readFileSync(bpath, 'utf8'));
ok('backup export has every store', backup.version === 1 && backup.items.length === counts.items && Array.isArray(backup.blocks) && backup.profile);
await S(async () => { const m = await import('./js/state.js'); await m.eraseEverything(); });
await page.waitForLoadState('load');
await booted();
await wait(600);
const emptied = await S(() => globalThis.__arc.S.items.length);
await page.click('text=Skip for now').catch(() => {});
await go('settings');
await page.setInputFiles('[data-restore]', bpath);
await page.waitForSelector('text=Restore it');
await page.click('text=Restore it');
await wait(1200);
const restored = await S(() => globalThis.__arc.S.items.length);
ok('backup import restores after confirmation', emptied === 0 && restored === counts.items, `${emptied} -> ${restored} items`);

// ---------------- postcard save ----------------
await go('settings');
await page.click('[data-tuck]');
await wait(3200);
const [pdl] = await Promise.all([page.waitForEvent('download'), page.click('.sheet [data-save]')]);
const ppath = join(tmp, 'postcard.png');
await pdl.saveAs(ppath);
const png = readFileSync(ppath);
const stored = await S(async () => { const db = await import('./js/store.js'); return (await db.all('postcards')).length; });
ok('postcard saves as PNG and lands in the archive', png.slice(1, 4).toString() === 'PNG' && png.length > 5000 && stored >= 1, `${(png.length / 1024).toFixed(0)} KB`);
await page.keyboard.press('Escape');

// ---------------- deep link ----------------
await page.goto(`${base}?now=${encodeURIComponent(NOW)}&add=${encodeURIComponent('dentist tomorrow 4pm')}#/today`);
await booted();
await page.waitForSelector('#qa-input');
const pre = await page.inputValue('#qa-input');
const cleaned = await S(() => !location.search.includes('add='));
const notSaved = await S(() => !globalThis.__arc.S.items.some((i) => i.title === 'Dentist'));
ok('?add= deep link pre-fills quick add, strips the param, does not auto-save', pre === 'dentist tomorrow 4pm' && cleaned && notSaved);
await page.keyboard.press('Escape');

// ---------------- offline + SW update ----------------
// A private static server for dist/ that we can switch off: real offline.
const { createServer } = await import('node:http');
const { extname } = await import('node:path');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };
let up = true;
const srv = createServer((req, res) => {
  if (!up) { req.socket.destroy(); return; }
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const body = readFileSync(join(dist, p)); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(body); }
  catch (_) { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const off = `http://127.0.0.1:${srv.address().port}/`;
const page2 = await ctx.newPage();
page2.on('console', (m) => { if (m.type() === 'error' && up) problems.push(`console error: ${m.text()}`); });
await page2.goto(`${off}#/today`);
await page2.waitForFunction(() => globalThis.__arcCore, null, { timeout: 20000 });
await page2.evaluate(() => navigator.serviceWorker.ready);
await page2.click('text=Skip for now');
await page2.waitForTimeout(400);
await page2.reload();
await page2.waitForFunction(() => globalThis.__arcCore);
const controlled = await page2.evaluate(() => !!navigator.serviceWorker.controller);
up = false; // server gone: the network is unreachable
await page2.reload();
let offlineOK = false;
try {
  await page2.waitForFunction(() => globalThis.__arcCore, null, { timeout: 10000 });
  offlineOK = await page2.evaluate(() => !!document.querySelector('.nav-plus') && globalThis.__arc.call('version').version === '1.0.0');
} catch (_) { offlineOK = false; }
ok('app shell loads and runs offline (server stopped)', controlled && offlineOK);
up = true;
// simulate a new deploy: change sw.js bytes, then ask the registration to update
const swPath = join(dist, 'sw.js');
const swOrig = readFileSync(swPath, 'utf8');
appendFileSync(swPath, `\n// e2e update ${Date.now()}\n`);
await page2.reload();
await page2.waitForFunction(() => globalThis.__arcCore);
await page2.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
let banner = false;
try { await page2.waitForSelector('[data-update]', { timeout: 8000 }); banner = true; } catch (_) { /* no banner */ }
ok('"A new version is ready, tap to refresh" banner appears (no auto skipWaiting)', banner);
if (banner) {
  await Promise.all([page2.waitForEvent('load', { timeout: 10000 }), page2.click('[data-update]')]);
  await page2.waitForFunction(() => globalThis.__arcCore);
  const fresh = await page2.evaluate(async () => (await caches.keys()).length);
  ok('tapping it activates the new worker, reloads, and old caches are deleted', fresh === 1, `${fresh} cache(s)`);
}
writeFileSync(swPath, swOrig);
srv.close();

await browser.close();

if (problems.length) { console.log('\nProblems:\n' + [...new Set(problems)].join('\n')); process.exitCode = 1; }
else console.log('\nPASS  no console errors and no requests to any other origin');
