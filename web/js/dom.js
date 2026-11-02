// Small DOM helpers shared by the UI modules.
import { set, to } from './anim.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Screen-reader live region. */
export function announce(msg) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}

/** A gentle toast that springs up from the bottom. action: {label, fn}. */
export function toast(msg, { action, ms = 3800, tone = 'plain' } = {}) {
  const layer = document.getElementById('layer');
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn" type="button">${esc(action.label)}</button>` : ''}`;
  layer.appendChild(el);
  set(el, { y: 40, opacity: 0 });
  to(el, { y: 0, opacity: 1 }, 'bouncy');
  let timer;
  const close = () => {
    clearTimeout(timer);
    to(el, { y: 30, opacity: 0 }, 'snappy').then(() => el.remove());
  };
  if (action) el.querySelector('button').addEventListener('click', () => { action.fn(); close(); });
  timer = setTimeout(close, ms);
  announce(msg);
  return close;
}

/** Download a Blob as a file (fallback when navigator.share is unavailable). */
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

/** Share a file with the OS share sheet if possible, else download it. */
export async function shareOrDownload(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  download(blob, name);
  return 'downloaded';
}

export const typeColor = (t) => ({ exam: 'var(--bubblegum)', assignment: 'var(--ice)', project: 'var(--mist)', event: 'var(--platinum)' }[t] || 'var(--vanilla)');
export const typeHex = (t) => ({ exam: '#FF84A2', assignment: '#B3D7F2', project: '#A9B7C6', event: '#F0EFEF' }[t] || '#FFF7E6');
export const groupHex = (g) => ({ morning: '#FDDEB2', daytime: '#FFF7E6', evening: '#F7C8D3' }[g] || '#A6B58A');
export function itemHex(it) {
  if (!it) return '#FFF7E6';
  if (it.type === 'routine') return groupHex(groupOf(it));
  return typeHex(it.type);
}
export function groupOf(it) {
  const r = it.routine || {};
  if (r.group === 'morning' || r.group === 'daytime' || r.group === 'evening') return r.group;
  if (r.anchor === 'morning' || r.anchor === 'evening' || r.anchor === 'daytime') return r.anchor;
  const m = r.atMin ?? 780;
  return m < 720 ? 'morning' : m < 1020 ? 'daytime' : 'evening';
}

/** A press squish wired with pointer events (scale .96). */
export function squishy(el) {
  const down = () => to(el, { scale: 0.96 }, { stiffness: 700, damping: 30 });
  const up = () => to(el, { scale: 1 }, 'bouncy');
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}

export const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
