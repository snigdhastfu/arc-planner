// Boot: service worker, wasm core, IndexedDB, then render.
import { loadCore, call } from './bridge.js';
import { loadDoodles } from './doodle.js';
import { loadMarks } from './mark.js';
import { S, init, subscribe, setMeta } from './state.js';
import { route, start, onRoute, go } from './router.js';
import { motion, viewTransition, set, to, forgetBoil } from './anim.js';
import { renderNav, setActive } from './ui/nav.js';
import { setSound } from './sound.js';
import { pick } from './copy.js';
import { closeAllSheets } from './ui/sheet.js';
import { roughBorder } from './rough.js';

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
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
    const offer = (w) => { if (w && navigator.serviceWorker.controller) showUpdate(w); };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch((e) => console.warn('SW registration failed', e));
  // Reload only when the user asked for the new version (a first install also
  // fires controllerchange via clients.claim(), and must not reload the page).
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (userAskedUpdate && !reloading) { reloading = true; location.reload(); } });
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
  if (S.persistent) return;
  const slot = document.getElementById('banner-slot');
  const d = document.createElement('div');
  d.className = 'banner';
  d.setAttribute('role', 'status');
  d.textContent = "Private mode: Arc is running in memory, so things won't be saved after you close it.";
  slot.appendChild(d);
  roughBorder(d, { color: 'var(--navajo)', width: 1.5, radius: 20, seed: 'mem' });
}

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
  registerSW();
  const t0 = performance.now();
  try {
    await Promise.all([loadCore(), loadDoodles(), loadMarks(document.body.dataset.logo)]);
    await init();
  } catch (e) {
    console.error(e);
    document.querySelector('.boot-line').textContent = 'Something got tangled while loading. Try reloading.';
    return;
  }
  motion.set(S.meta.motion || 'full');
  document.body.classList.toggle('gentle', S.meta.motion === 'gentle');
  setSound(!!S.meta.sound);
  if (S.meta.logo) { const { setMark } = await import('./mark.js'); setMark(S.meta.logo); }

  renderNav(document.getElementById('nav'), async (btn) => {
    const { openQuickAdd } = await import('./ui/quickadd.js');
    openQuickAdd({ from: btn });
  });

  for (const name of Object.keys(screens)) route(name, () => {});
  onRoute((r, prev) => show(r, prev));
  subscribe((reason, detail) => {
    if (reason === 'erased') { location.hash = '#/today'; location.reload(); return; }
    if (current && current.api && current.api.update) current.api.update(reason, detail);
  });

  // reveal: let the boot doodle finish its stroke at least briefly
  const app = document.getElementById('app');
  const bootEl = document.getElementById('boot');
  const minShow = motion.reduced ? 0 : Math.max(0, 450 - (performance.now() - t0));
  setTimeout(() => {
    app.hidden = false;
    start();
    bootEl.classList.add('out');
    setTimeout(() => bootEl.remove(), 400);
    storageBanner();
    afterStart();
  }, minShow);
  globalThis.__arcBoot = { ms: Math.round(performance.now() - t0), version: S.version };
}

async function afterStart() {
  // ?add=<text> deep link: open quick add pre-filled (never auto-save)
  const params = new URLSearchParams(location.search);
  const add = params.get('add');
  if (add) {
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

boot();
