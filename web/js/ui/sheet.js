// Bottom sheets: draggable with rubber-banding and velocity-based dismiss,
// focus trapped, Esc closes. `from` morphs the sheet out of an element (FLIP).
import { set, to, motion } from '../anim.js';
import { drag, rubber } from '../gestures.js';
import { roughBorder } from '../rough.js';
import { esc } from '../dom.js';

const stack = [];

export function openSheet({ title = '', label, body = '', from = null, onMount, onClose, tall = false, seed = 'sheet', cls = '' }) {
  const layer = document.getElementById('layer');
  const opener = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `
    <div class="sheet-backdrop"></div>
    <section class="sheet ${tall ? 'sheet-tall' : ''} ${cls}" role="dialog" aria-modal="true" aria-label="${esc(label || title)}">
      <div class="sheet-grab" aria-hidden="true"><span></span></div>
      ${title ? `<h2 class="sheet-title">${esc(title)}</h2>` : ''}
      <div class="sheet-body">${body}</div>
    </section>`;
  layer.appendChild(wrap);
  const sheet = wrap.querySelector('.sheet');
  const backdrop = wrap.querySelector('.sheet-backdrop');
  document.getElementById('app').setAttribute('aria-hidden', 'true');
  roughBorder(sheet, { color: 'var(--line-2)', width: 1.5, radius: 32, seed, jitter: 0.9, draw: !motion.reduced });

  // enter: morph from the trigger, or spring up
  const h = sheet.offsetHeight;
  set(backdrop, { opacity: 0 });
  to(backdrop, { opacity: 1 }, 'gentle');
  if (from && !motion.reduced) {
    const fr = from.getBoundingClientRect(), sr = sheet.getBoundingClientRect();
    const s = Math.max(0.08, fr.width / sr.width);
    set(sheet, { x: fr.left + fr.width / 2 - (sr.left + sr.width / 2), y: fr.top + fr.height / 2 - (sr.top + sr.height / 2), scale: s, opacity: 0.4 });
    to(sheet, { x: 0, y: 0, scale: 1, opacity: 1 }, { stiffness: 260, damping: 26 });
  } else {
    set(sheet, { y: h * 0.6, opacity: 0 });
    to(sheet, { y: 0, opacity: 1 }, { stiffness: 260, damping: 26 });
  }

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    stack.splice(stack.indexOf(api), 1);
    if (!stack.length) document.getElementById('app').removeAttribute('aria-hidden');
    to(backdrop, { opacity: 0 }, 'snappy');
    const target = from && document.body.contains(from) && !motion.reduced
      ? (() => {
        const fr = from.getBoundingClientRect(), sr = sheet.getBoundingClientRect();
        return { x: fr.left + fr.width / 2 - (sr.left + sr.width / 2), y: fr.top + fr.height / 2 - (sr.top + sr.height / 2), scale: Math.max(0.08, fr.width / sr.width), opacity: 0 };
      })()
      : { y: sheet.offsetHeight + 40, opacity: 0 };
    to(sheet, target, { stiffness: 320, damping: 32 }).then(() => wrap.remove());
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose(result);
    if (opener && opener.focus) setTimeout(() => opener.focus({ preventScroll: true }), 30);
  }

  // drag to dismiss
  const grabZone = sheet;
  const stopDrag = drag(grabZone, {
    axis: 'y',
    ignore: 'input, textarea, select, button, [data-nodrag], .sheet-scroll',
    onMove: ({ dy }) => set(sheet, { y: dy > 0 ? dy : rubber(dy, 60) }),
    onEnd: ({ dy, vy }) => {
      const hh = sheet.offsetHeight;
      if (dy > hh * 0.35 || vy > 900) close();
      else to(sheet, { y: 0 }, { stiffness: 380, damping: 30, velocity: { y: vy } });
    },
  });
  backdrop.addEventListener('click', () => close());

  function focusables() {
    return [...sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((e) => !e.disabled && e.offsetParent !== null);
  }
  function onKey(e) {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);

  const api = { el: sheet, body: sheet.querySelector('.sheet-body'), close, stopDrag };
  stack.push(api);
  onMount && onMount(api);
  setTimeout(() => {
    const auto = sheet.querySelector('[autofocus]') || focusables()[0];
    if (auto) auto.focus({ preventScroll: true });
  }, 60);
  return api;
}

export const closeAllSheets = () => [...stack].reverse().forEach((s) => s.close());
export const sheetOpen = () => stack.length > 0;

/** A small confirm sheet. Resolves true/false. */
export function confirmSheet({ title, text, yes = 'Yes', no = 'Not now', typed = '' }) {
  return new Promise((resolve) => {
    let ok = false;
    openSheet({
      title,
      body: `<p class="m sheet-text">${esc(text)}</p>
        ${typed ? `<label class="field"><span class="m">Type <b>${esc(typed)}</b> to confirm</span><input class="input" data-typed autocomplete="off" autocapitalize="off" spellcheck="false"></label>` : ''}
        <div class="sheet-actions"><button class="btn btn-primary" data-yes ${typed ? 'disabled' : ''}>${esc(yes)}</button><button class="btn btn-ghost" data-no>${esc(no)}</button></div>`,
      onMount: (s) => {
        const y = s.el.querySelector('[data-yes]');
        const input = s.el.querySelector('[data-typed]');
        if (input) input.addEventListener('input', () => { y.disabled = input.value.trim().toUpperCase() !== typed.toUpperCase(); });
        y.addEventListener('click', () => { ok = true; s.close(); });
        s.el.querySelector('[data-no]').addEventListener('click', () => s.close());
      },
      onClose: () => resolve(ok),
    });
  });
}
