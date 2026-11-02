// Bottom nav: Today, Routines, big +, Horizon. The active indicator is a
// hand-drawn squiggle that springs between tabs and redraws itself.
import { Spring, drawOn, motion } from '../anim.js';
import { go } from '../router.js';
import { squishy } from '../dom.js';

const TABS = [
  { id: 'today', label: 'Today' },
  { id: 'routines', label: 'Routines' },
  { id: 'add', label: 'Quick add', plus: true },
  { id: 'horizon', label: 'Horizon' },
];
// A small hand-drawn squiggle (an underline, not a doodle).
const SQUIGGLE = 'M2 6 C6 2 10 2 14 6 C18 10 22 10 26 6 C30 2 34 2 38 6';

let spring = null;
let currentTab = null;

export function renderNav(nav, onAdd) {
  nav.innerHTML = TABS.map((t) => t.plus
    ? `<button class="nav-plus" type="button" data-tab="add" aria-label="Quick add">+</button>`
    : `<button class="nav-tab" type="button" data-tab="${t.id}">${t.label}</button>`).join('') +
    `<svg class="nav-squiggle" width="40" height="10" viewBox="0 0 40 10" aria-hidden="true"><path data-draw d="${SQUIGGLE}" fill="none" stroke="var(--vanilla)" stroke-width="2" stroke-linecap="round"/></svg>`;
  const squig = nav.querySelector('.nav-squiggle');
  spring = new Spring(0, { stiffness: 260, damping: 22, onUpdate: (x) => { squig.style.transform = `translateX(${x.toFixed(1)}px)`; } });
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    if (b.dataset.tab === 'add') onAdd(b);
    else go(b.dataset.tab);
  });
  nav.querySelectorAll('button').forEach(squishy);
  addEventListener('resize', () => setActive(currentTab, true));
}

export function setActive(tab, instant = false) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  currentTab = tab;
  nav.querySelectorAll('.nav-tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const squig = nav.querySelector('.nav-squiggle');
  const btn = nav.querySelector(`.nav-tab[data-tab="${tab}"]`);
  const hidden = tab === 'guided' || tab === 'review';
  nav.classList.toggle('nav-hidden', hidden);
  document.getElementById('screen')?.classList.toggle('screen-nav-hidden', hidden);
  if (!btn || !squig) { if (squig) squig.style.opacity = '0'; return; }
  squig.style.opacity = '1';
  const nr = nav.getBoundingClientRect(), br = btn.getBoundingClientRect();
  const x = br.left - nr.left + br.width / 2 - 20;
  if (instant || motion.reduced || !spring.value) spring.jump(x);
  else { spring.to(x); drawOn(squig, { duration: 420 }); }
}
