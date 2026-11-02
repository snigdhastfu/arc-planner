// Guided routine: step through a group with a big tilted tile.
import { S, blockAction, itemById } from '../state.js';
import * as T from '../time.js';
import { doodleSVG } from '../doodle.js';
import { set, to, drawOn, erase, motion, observeBoil, forgetBoil } from '../anim.js';
import { drag } from '../gestures.js';
import { esc, groupHex, announce, CHECK } from '../dom.js';
import { routineLine, pick } from '../copy.js';
import { burst, react, shower, stamp } from '../fx.js';
import { pop, chime, buzz } from '../sound.js';
import { go } from '../router.js';
import { groupItems, todaysBlockFor } from './routines.js';

const LABEL = { morning: 'Morning', daytime: 'Daytime', evening: 'Evening' };
let root = null, steps = [], idx = 0, group = 'morning', timer = 0, timerEnd = 0;

export function mount(el, params) {
  root = el;
  group = LABEL[params[0]] ? params[0] : 'morning';
  steps = groupItems(group).map((it) => ({ it, b: todaysBlockFor(it.id) })).filter((s) => s.b);
  idx = Math.max(0, steps.findIndex((s) => s.b.status === 'planned'));
  if (steps.length && steps.every((s) => s.b.status !== 'planned')) idx = steps.length; // all handled already
  render('enter');
  const onKey = (e) => {
    if (!root || e.target.closest('input,textarea')) return;
    if (e.key === 'Escape') go('routines');
  };
  addEventListener('keydown', onKey);
  return { unmount: () => { removeEventListener('keydown', onKey); clearInterval(timer); forgetBoil(el); root = null; } };
}

function render(mode) {
  if (!root) return;
  const color = groupHex(group);
  if (!steps.length) {
    root.innerHTML = `<div class="guided"><button class="btn btn-text guided-back" data-close>← Routines</button>
      <div class="empty">${doodleSVG('sparkle', 80, color)}<p>No ${LABEL[group].toLowerCase()} routines today. Enjoy the free air.</p></div></div>`;
    root.querySelector('[data-close]').onclick = () => go('routines');
    return;
  }
  if (idx >= steps.length) return renderDone(color);
  const { it, b } = steps[idx];
  const tiltDeg = idx % 2 ? 3 : -3;
  root.innerHTML = `
    <div class="guided">
      <div class="hdr"><div><div class="m">${LABEL[group]} · step ${idx + 1} of ${steps.length}</div><h1 class="h">${esc(it.title)} time</h1></div>
        <button class="btn btn-text" data-close aria-label="Close guided routine">Close</button></div>
      <div class="guided-tile" data-tile style="background:${color};view-transition-name:guided-tile">
        <button type="button" data-poke aria-label="Poke the ${esc(it.doodle)} doodle">${doodleSVG(it.doodle, 140, '#111')}</button>
      </div>
      <div class="guided-text">
        <div class="guided-name">${esc(it.title)}</div>
        ${it.routine.detail ? `<div class="m guided-detail">${esc(it.routine.detail)}</div>` : ''}
        <div class="m guided-quip" style="color:${color}">${esc(routineLine(it.doodle, it.id))}</div>
        ${it.routine.durMin >= 3 ? `<div class="guided-timer" data-timer><button class="btn btn-ghost btn-sm" data-start>Start ${it.routine.durMin}:00 timer</button></div>` : ''}
      </div>
      <div class="dots" aria-hidden="true">${steps.map((s, i) => `<span class="${i === idx ? 'on' : ''}${s.b.status === 'done' ? ' done' : ''}" style="background:${color}"></span>`).join('')}</div>
      <div class="guided-foot">
        <button class="done-btn" type="button" data-done aria-label="Mark ${esc(it.title)} done" style="background:${color}">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></button>
        <button class="btn btn-text" type="button" data-skip>Sleep on this one</button>
      </div>
    </div>`;
  const tile = root.querySelector('[data-tile]');
  setTimeout(() => { if (tile.isConnected) tile.style.viewTransitionName = ''; }, 600);
  set(tile, { rotate: tiltDeg });
  if (mode === 'next' && !motion.reduced) { set(tile, { x: 260, rotate: 14, opacity: 0 }); to(tile, { x: 0, rotate: tiltDeg, opacity: 1 }, { stiffness: 200, damping: 20 }); }
  if (mode === 'enter' && !motion.reduced) { set(tile, { scale: 0.85, opacity: 0 }); to(tile, { scale: 1, opacity: 1 }, 'bouncy'); }
  drawOn(tile, { delay: mode === 'next' ? 160 : 100, duration: 650 });
  observeBoil(root);
  const poke = root.querySelector('[data-poke]');
  poke.onclick = () => { react(poke.firstElementChild, it.doodle); pop(0.9); };
  root.querySelector('[data-close]').onclick = () => go('routines');
  root.querySelector('[data-done]').onclick = () => complete();
  root.querySelector('[data-skip]').onclick = () => skip();
  const start = root.querySelector('[data-start]');
  if (start) start.onclick = () => startTimer(it.routine.durMin);
  // swipe the big tile: right = done, left = sleep on it
  drag(tile, {
    axis: 'x',
    onMove: ({ dx }) => set(tile, { x: dx, rotate: tiltDeg + dx / 18 }),
    onEnd: ({ dx, vx }) => {
      if (dx > 110 || vx > 900) complete();
      else if (dx < -110 || vx < -900) skip();
      else to(tile, { x: 0, rotate: tiltDeg }, { stiffness: 300, damping: 20, velocity: { x: vx } });
    },
  });
  root.querySelector('[data-done]').focus({ preventScroll: true });
}

function startTimer(min) {
  clearInterval(timer);
  timerEnd = T.nowMs() + min * 60000;
  const box = root.querySelector('[data-timer]');
  const tickFn = () => {
    if (!box.isConnected) { clearInterval(timer); return; }
    const left = timerEnd - T.nowMs();
    box.textContent = left > 0 ? T.mmss(left) : 'Time! Tap the check.';
    if (left <= 0) { clearInterval(timer); pop(1.4); buzz(30); }
  };
  tickFn();
  timer = setInterval(tickFn, 500);
}

let stepping = false;
async function complete() {
  if (stepping) return;
  stepping = true;
  clearInterval(timer);
  const { it, b } = steps[idx];
  const tile = root.querySelector('[data-tile]');
  try {
    if (b.status !== 'done') await blockAction(b.id, 'done');
    steps[idx].b = S.plan.blocks.find((x) => x.id === b.id) || b;
    pop(1.1); buzz(10);
    announce(`${it.title} done. ${routineLine(it.doodle, it.id)}`);
    if (!motion.reduced) {
      stamp(tile, { color: '#111111', label: '', seed: it.id, size: 96 });
      react(tile.querySelector('svg.doodle'), it.doodle);
      const r = tile.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, { count: 10, seed: it.id, colors: [groupHex(group), '#FFF7E6', '#7CBB93'], doodles: ['sparkle', it.doodle] });
      await wait(480);
      await erase(tile, { duration: 220 });
      await to(tile, { x: -280, rotate: -16, opacity: 0 }, { stiffness: 220, damping: 24 });
    }
    idx = nextIndex(idx);
    render('next');
  } finally { stepping = false; }
}
async function skip() {
  if (stepping) return;
  stepping = true;
  const { it, b } = steps[idx];
  const tile = root.querySelector('[data-tile]');
  try {
    if (b.status === 'planned') await blockAction(b.id, 'skip');
    steps[idx].b = S.plan.blocks.find((x) => x.id === b.id) || b;
    announce(`${it.title} is sleeping in.`);
    if (!motion.reduced) await to(tile, { y: -200, opacity: 0, rotate: 0 }, { stiffness: 160, damping: 22 });
    idx = nextIndex(idx);
    render('next');
  } finally { stepping = false; }
}
function nextIndex(i) {
  for (let j = i + 1; j < steps.length; j++) if (steps[j].b.status === 'planned') return j;
  return steps.length;
}

function renderDone(color) {
  const done = steps.filter((s) => s.b.status === 'done').length;
  root.innerHTML = `
    <div class="guided guided-finale">
      <div class="hdr"><div><div class="m">${LABEL[group]} · all done</div><h1 class="h">${esc(pick('routinesAllDone', group))}</h1></div></div>
      <div class="guided-tile" data-tile style="background:${color}">${doodleSVG('sparkle', 140, '#111')}</div>
      <div class="guided-text"><div class="guided-name">${done} of ${steps.length} stamped</div>
        <div class="m guided-detail">${steps.length - done ? 'The rest are sleeping in. That counts as listening to yourself.' : 'Every single one. Look at you.'}</div></div>
      <div class="dots" aria-hidden="true">${steps.map(() => `<span class="done" style="background:${color}"></span>`).join('')}</div>
      <div class="guided-foot"><button class="btn btn-primary" data-close style="background:${color}">Back to routines</button>
        <button class="btn btn-text" data-today>Go to Today</button></div>
    </div>`;
  const tile = root.querySelector('[data-tile]');
  set(tile, { rotate: -3, scale: 0.6, opacity: 0 });
  to(tile, { scale: 1, opacity: 1 }, 'wobbly');
  drawOn(tile, { delay: 150, duration: 800 });
  chime();
  shower(steps.map((s) => s.it.doodle).concat(['sparkle']));
  announce(`${LABEL[group]} routines finished.`);
  root.querySelector('[data-close]').onclick = () => go('routines');
  root.querySelector('[data-today]').onclick = () => go('today');
  root.querySelector('[data-close]').focus({ preventScroll: true });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
