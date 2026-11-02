// Doodle picker: searchable grid of the 16 doodles.
import { doodleSVG, doodleNames, keywordsFor } from '../doodle.js';
import { drawOn, set, to, motion } from '../anim.js';
import { esc } from '../dom.js';
import { openSheet } from './sheet.js';

/** Resolves { doodle, source:'user' } or { source:'auto' } or null. */
export function openPicker({ current = '', color = '#FFF7E6', from = null } = {}) {
  return new Promise((resolve) => {
    let picked = null;
    openSheet({
      title: 'Pick a doodle',
      from,
      seed: 'picker',
      tall: true,
      body: `
        <label class="sr-only" for="pk-q">Search doodles</label>
        <input id="pk-q" class="input" data-q placeholder="Search: coffee, gym, exam…" autocomplete="off">
        <div class="picker-grid" data-grid role="listbox" aria-label="Doodles">
          ${doodleNames().map((n) => `<button type="button" role="option" data-name="${n}" aria-pressed="${n === current}" aria-selected="${n === current}" title="${esc(keywordsFor(n).join(', '))}">${doodleSVG(n, 36, color)}<span>${n}</span></button>`).join('')}
        </div>
        <div class="sheet-actions"><button class="btn btn-ghost" data-auto>Auto (match the title)</button></div>`,
      onMount: (s) => {
        const grid = s.el.querySelector('[data-grid]');
        [...grid.children].forEach((b, i) => {
          if (!motion.reduced) { set(b, { scale: 0.8, opacity: 0 }); setTimeout(() => to(b, { scale: 1, opacity: 1 }, 'bouncy'), 20 * i); }
          drawOn(b, { delay: 25 * i, duration: 420, stagger: 40 });
        });
        s.el.querySelector('[data-q]').addEventListener('input', (e) => {
          const q = e.target.value.trim().toLowerCase();
          [...grid.children].forEach((b) => {
            const n = b.dataset.name;
            b.hidden = !!q && !n.includes(q) && !keywordsFor(n).some((k) => k.includes(q));
          });
        });
        grid.addEventListener('click', (e) => {
          const b = e.target.closest('[data-name]');
          if (!b) return;
          picked = { doodle: b.dataset.name, source: 'user' };
          s.close();
        });
        s.el.querySelector('[data-auto]').addEventListener('click', () => { picked = { source: 'auto' }; s.close(); });
      },
      onClose: () => resolve(picked),
    });
  });
}
