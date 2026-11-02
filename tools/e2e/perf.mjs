// Performance budget checks (SPEC/prompt 3.9), dev-only.
//   node perf.mjs [baseURL]
// - Frame timing during the main interactions at 4x CPU throttling (CDP).
// - Cold load on a mid-range phone profile: 4x CPU, ~9 Mbps / 60 ms RTT.
// Frame times come from requestAnimationFrame deltas sampled in the page.
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://localhost:8090/';
const NOW = '2026-11-03T15:21:40+05:30';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--disable-gpu-vsync'] });
const report = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'Asia/Kolkata', hasTouch: false });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp };
}

const startMeter = (page) => page.evaluate(() => {
  globalThis.__fr = [];
  let last = performance.now();
  const loop = (t) => { globalThis.__fr.push(t - last); last = t; if (globalThis.__fr) globalThis.__frRaf = requestAnimationFrame(loop); };
  globalThis.__frRaf = requestAnimationFrame(loop);
});
const stopMeter = (page) => page.evaluate(() => {
  cancelAnimationFrame(globalThis.__frRaf);
  const f = globalThis.__fr.slice(1);
  globalThis.__fr = null;
  const total = f.reduce((a, b) => a + b, 0);
  const sorted = [...f].sort((a, b) => a - b);
  return { frames: f.length, fps: +(1000 * f.length / total).toFixed(1), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), worst: +sorted[sorted.length - 1].toFixed(1), janky: f.filter((x) => x > 25).length };
});

async function measure(name, page, fn) {
  await startMeter(page);
  await fn();
  const r = await stopMeter(page);
  report.push({ name, ...r });
}

// ---- interactions at 4x CPU --------------------------------------------------
{
  const { ctx, page, cdp } = await newPage();
  await page.goto(`${base}?now=${encodeURIComponent('2026-11-03T08:00:00+05:30')}#/today`);
  await page.waitForFunction(() => globalThis.__arcCore);
  await page.evaluate(async () => { const m = await import('./js/state.js'); await m.loadSample(); });
  await page.goto(`${base}?now=${encodeURIComponent(NOW)}#/today`);
  await page.waitForFunction(() => globalThis.__arcCore);
  await page.waitForTimeout(2500);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // focus card: slow drag right then release below threshold (spring back)
  const card = await page.$('.focus-card');
  const b = await card.boundingBox();
  await measure('Focus card drag + spring back', page, async () => {
    await page.mouse.move(b.x + 60, b.y + 60);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) { await page.mouse.move(b.x + 60 + i * 2.5, b.y + 60 + Math.sin(i / 5) * 4); }
    await page.mouse.up();
    await page.waitForTimeout(700);
  });
  // arc node drag (a future work block)
  const node = await page.evaluate(() => {
    const { S } = globalThis.__arc;
    const nowMs = Date.parse(S.plan.generatedAt);
    const fut = [...document.querySelectorAll('[data-node]')].find((g) => { const b = S.plan.blocks.find((x) => x.id === g.dataset.node); return b && b.kind === 'work' && new Date(b.start) > new Date(); });
    if (!fut) return null;
    const r = fut.querySelector('.node-shape').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (node) {
    await measure('Arc node drag with snapping', page, async () => {
      await page.mouse.move(node.x, node.y);
      await page.mouse.down();
      for (let i = 0; i < 40; i++) await page.mouse.move(node.x + i * 1.5, node.y);
      await page.keyboard.press('Escape');
      await page.mouse.move(node.x, node.y);
      await page.mouse.up();
      await page.waitForTimeout(500);
    });
  }
  // finish via swipe: stamp, burst, card flight, next card rises
  await measure('Swipe-to-finish celebration', page, async () => {
    const c = await page.$('.focus-card');
    const bb = await c.boundingBox();
    await page.mouse.move(bb.x + 40, bb.y + 60);
    await page.mouse.down();
    for (let i = 0; i < 24; i++) await page.mouse.move(bb.x + 40 + i * 9, bb.y + 60);
    await page.mouse.up();
    await page.waitForTimeout(1800);
  });
  // routines: tiles spring in with draw-on doodles
  await measure('Routines entrance (tiles spring + draw-on)', page, async () => {
    await page.evaluate(() => { location.hash = '#/routines'; });
    await page.waitForTimeout(1500);
  });
  // horizon: capsules rise, then fisheye scrub
  await page.evaluate(() => { location.hash = '#/horizon'; });
  await page.waitForTimeout(1500);
  const chart = await (await page.$('[data-chart]')).boundingBox();
  await measure('Horizon fisheye scrub', page, async () => {
    for (let i = 0; i <= 50; i++) await page.mouse.move(chart.x + 10 + (chart.width - 20) * (i / 50), chart.y + chart.height * 0.7);
    await page.waitForTimeout(200);
  });
  // quick add sheet: open (morph), drag down, dismiss
  await measure('Quick-add sheet open + drag-dismiss', page, async () => {
    await page.click('.nav-plus');
    await page.waitForTimeout(500);
    const sh = await (await page.$('.sheet-grab')).boundingBox();
    await page.mouse.move(sh.x + sh.width / 2, sh.y + 5);
    await page.mouse.down();
    for (let i = 0; i < 25; i++) await page.mouse.move(sh.x + sh.width / 2, sh.y + 5 + i * 12);
    await page.mouse.up();
    await page.waitForTimeout(600);
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await ctx.close();
}

// ---- cold load on a mid-range phone profile ------------------------------------
const loads = [];
for (let run = 0; run < 3; run++) {
  const { ctx, page, cdp } = await newPage();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (2 * 1024 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`${base}#/today`, { waitUntil: 'commit' });
  await page.waitForFunction(() => globalThis.__arcBoot, null, { timeout: 60000 });
  const shell = await page.evaluate(() => Math.round(performance.now()));
  await page.waitForFunction(() => globalThis.__arcCore, null, { timeout: 60000 });
  const t = await page.evaluate((shell) => {
    const fp = performance.getEntriesByName('first-contentful-paint')[0];
    return { fcp: fp ? Math.round(fp.startTime) : null, shell, core: Math.round(performance.now()) };
  }, shell);
  loads.push(t);
  await ctx.close();
}
await browser.close();

console.log('Frame timing at 4x CPU throttling (rAF deltas):');
for (const r of report) console.log(`  ${r.name.padEnd(44)} ${String(r.fps).padStart(5)} fps   p95 ${r.p95} ms   worst ${r.worst} ms   frames>25ms ${r.janky}/${r.frames}`);
console.log('\nCold load, 4x CPU, 9 Mbps / 60 ms RTT, cache disabled (3 runs):');
loads.forEach((l, i) => console.log(`  run ${i + 1}: first paint ${l.fcp} ms, shell interactive ${l.shell} ms, planner (wasm) ready ${l.core} ms`));
