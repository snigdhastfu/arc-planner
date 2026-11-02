// Boot: service worker, IndexedDB, wasm core, then render.
import { loadCore, call } from './bridge.js';
import { loadDoodles } from './doodle.js';
import { loadMarks } from './mark.js';
import { S, initLocal, initCore, subscribe } from './state.js';
import { route, start, onRoute, go } from './router.js';
import { motion, viewTransition, set, to, forgetBoil } from './anim.js';
import { renderNav, setActive } from './ui/nav.js';
import { setSound } from './sound.js';
import { pick } from './copy.js';
import { closeAllSheets } from './ui/sheet.js';
import { roughBorder } from './rough.js';
import { storageStatus } from './store.js';
import { toast } from './dom.js';

const screens = {
  today: () => import('./ui/today.js'),
  routines: () => import('./ui/routines.js'),
  horizon: () => import('./ui/horizon.js'),
  review: () => import('./ui/review.js'),
  settings: () => import('./ui/settings.js'),
  guided: () => import('./ui/guided.js'),
};

let current = null; // { name, api }
let userAskedUpdate = false;
const bootLine = document.querySelector('.boot-line');
if (bootLine) bootLine.textContent = pick('loading');

// ---- service worker + update banner --------------------------------------------------
async function registerSW() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    const offer = (w) => { if (w && navigator.serviceWorker.controller) showUpdate(w); };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    // Reload only when the user asked for the new version (a first install
    // also fires controllerchange via clients.claim(), and must not reload).
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (userAskedUpdate && !reloading) { reloading = true; location.reload(); }
    });
  } catch (e) {
    console.warn('SW registration failed', e);
    if (globalThis.__arcBootReportError) globalThis.__arcBootReportError('Service worker registration failed', e);
  }
}
function showUpdate(worker) {
  const slot = document.getElementById('banner-slot');
  if (slot.querySelector('[data-update]')) return;
  const b = document.createElement('button');
  b.className = 'banner banner-update';
  b.type = 'button';
  b.dataset.update = '';
  b.textContent = 'A new version is ready, tap to refresh';
  slot.appendChild(b);
  roughBorder(b, { color: 'var(--teal)', width: 1.5, radius: 22, seed: 'update', draw: true });
  set(b, { y: -20, opacity: 0 }); to(b, { y: 0, opacity: 1 }, 'bouncy');
  b.addEventListener('click', () => { userAskedUpdate = true; b.textContent = 'Refreshing…'; worker.postMessage('SKIP_WAITING'); });
}

function storageBanner() {
  const slot = document.getElementById('banner-slot');
  const existing = slot.querySelector('[data-storage]');
  if (S.persistent) { if (existing) existing.remove(); return; }
  const message = S.storage.backend === 'memory'
    ? 'Arc is running in memory only. Your changes will not survive closing this tab.'
    : 'Arc is using local storage because IndexedDB is unavailable.';
  if (existing) { existing.textContent = message; return; }
  const d = document.createElement('div');
  d.className = 'banner';
  d.setAttribute('role', 'status');
  d.dataset.storage = '';
  d.textContent = message;
  slot.appendChild(d);
  roughBorder(d, { color: 'var(--navajo)', width: 1.5, radius: 20, seed: 'mem' });
}

function sampleBanner() {
  const slot = document.getElementById('banner-slot');
  const existing = slot.querySelector('[data-sample-banner]');
  const hasSample = S.items.some((item) => item.sample || item.id.startsWith('s-'));
  if (!hasSample) { if (existing) existing.remove(); return; }
  if (existing) return;
  const d = document.createElement('button');
  d.className = 'banner';
  d.type = 'button';
  d.dataset.sampleBanner = '';
  d.textContent = 'Sample week is loaded. Tap to manage sample data in Settings.';
  slot.appendChild(d);
  roughBorder(d, { color: 'var(--teal)', width: 1.5, radius: 20, seed: 'sample' });
  d.addEventListener('click', () => go('settings'));
}

function memoryNotice() {
  if (S.storage.backend !== 'memory') return;
  let shown = false;
  try { shown = sessionStorage.getItem('arc-memory-notice') === 'shown'; } catch (_) {}
  if (shown) return;
  try { sessionStorage.setItem('arc-memory-notice', 'shown'); } catch (_) {}
  const error = S.storage.idbError;
  const reason = error ? `${error.name}: ${error.message}` : 'IndexedDB and localStorage are unavailable.';
  toast(`Arc is in memory-only mode. IndexedDB failed: ${reason}`, { ms: 9000 });
}

addEventListener('arc-storagechange', () => {
  S.storage = storageStatus();
  S.persistent = S.storage.backend === 'indexedDB';
  if (globalThis.__arcBoot) {
    storageBanner();
    memoryNotice();
  }
});

// ---- routing --------------------------------------------------------------------------
async function show(r, prev) {
  closeAllSheets();
  const mod = await (screens[r.name] || screens.today)();
  const el = document.getElementById('screen');
  const swap = () => {
    if (current && current.api && current.api.unmount) current.api.unmount();
    forgetBoil(el);
    el.className = `screen screen-${r.name}`;
    el.scrollTop = 0;
    const api = mod.mount(el, r.params);
    current = { name: r.name, api };
    document.getElementById('app').dataset.route = r.name;
    setActive(r.name);
  };
  if (!prev) { swap(); return; }
  await viewTransition(swap);
  window.scrollTo(0, 0);
  el.focus({ preventScroll: true });
}

// ---- boot ------------------------------------------------------------------------------
async function boot() {
  const t0 = performance.now();
  if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('registering the service worker');
  let swTimer;
  await Promise.race([
    registerSW(),
    new Promise((resolve) => { swTimer = setTimeout(resolve, 1500); }),
  ]);
  clearTimeout(swTimer);

  if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('reading IndexedDB');
  await initLocal();
  if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('loading app data');
  await Promise.all([loadDoodles(), loadMarks(document.body.dataset.logo)]);

  await loadCore();
  if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('reading IndexedDB');
  await initCore();
  globalThis.__arcCore = { ms: Math.round(performance.now() - t0) };

  motion.set(S.meta.motion || 'full');
  document.body.classList.toggle('gentle', S.meta.motion === 'gentle');
  setSound(!!S.meta.sound);
  if (S.meta.logo) { const { setMark } = await import('./mark.js'); setMark(S.meta.logo); }

  renderNav(document.getElementById('nav'), async (btn) => {
    const { openQuickAdd } = await import('./ui/quickadd.js');
    openQuickAdd({ from: btn });
  });

  for (const name of Object.keys(screens)) route(name, () => {});
  let initialRender;
  onRoute((r, prev) => {
    const rendering = show(r, prev);
    if (!prev) initialRender = rendering;
  });
  subscribe((reason, detail) => {
    if (reason === 'erased') { location.hash = '#/today'; location.reload(); return; }
    if (current && current.api && current.api.update) current.api.update(reason, detail);
    if (reason === 'plan' || reason === 'item-added' || reason === 'item-edited' || reason === 'items-cleared') sampleBanner();
  });

  // reveal: let the boot doodle finish its stroke at least briefly
  const app = document.getElementById('app');
  const bootEl = document.getElementById('boot');
  const minShow = motion.reduced ? 0 : Math.max(0, 450 - (performance.now() - t0));
  if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('starting the app screen');
  setTimeout(async () => {
    try {
      app.hidden = false;
      start();
      await initialRender;
      storageBanner();
      sampleBanner();
      memoryNotice();
      await afterStart();
      if (globalThis.__arcBootFinish) globalThis.__arcBootFinish();
      bootEl.classList.add('out');
      setTimeout(() => bootEl.remove(), 400);
      globalThis.__arcBoot = { ms: Math.round(performance.now() - t0) };
    } catch (e) {
      if (globalThis.__arcBootReportError) globalThis.__arcBootReportError('Boot failed', e);
      else throw e;
    }
  }, minShow);

}

async function afterStart() {
  // ?add=<text> deep link: open quick add pre-filled (never auto-save)
  const params = new URLSearchParams(location.search);
  const add = params.get('add');
  if (add) {
    await loadCore();
    params.delete('add');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    const { openQuickAdd } = await import('./ui/quickadd.js');
    openQuickAdd({ text: add });
    return;
  }
  if (!S.meta.onboarded) {
    const { openOnboarding } = await import('./ui/onboarding.js');
    openOnboarding();
  }
}

// Debug/e2e hook (read-only helpers).
globalThis.__arc = { S, call, go };

boot().catch((e) => {
  if (globalThis.__arcBootReportError) globalThis.__arcBootReportError('Boot failed', e);
  else throw e;
});
