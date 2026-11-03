// Routines: week strip, Morning/Daytime/Evening groups of pastel tiles.
import { S, blockAction, itemById, reorderRoutines, routineWeek, markRoutineToday } from '../state.js';
import * as T from '../time.js';
import { doodleSVG } from '../doodle.js';
import { set, to, drawOn, observeBoil, forgetBoil, motion, flip, tween } from '../anim.js';
import { drag } from '../gestures.js';
import { roughBorder, tilt } from '../rough.js';
import { esc, groupOf, groupHex, CHECK, announce, toast } from '../dom.js';
import { routineLine, pick } from '../copy.js';
import { checkBounce, burst, react } from '../fx.js';
import { pop, chime, buzz } from '../sound.js';
import { go } from '../router.js';
import { markSVG } from '../mark.js';
import { openSheet } from './sheet.js';

const GROUPS = [['morning', 'Morning'], ['daytime', 'Daytime'], ['evening', 'Evening']];
let root = null;

export function routineItems() {
  return S.items.filter((i) => i.type === 'routine' && !i.deleted && i.routine);
}
export function todaysBlockFor(itemId) {
  const k = T.scheduleDayKey(T.now(), S.profile.wakeMin);
  return S.plan.blocks.find((b) => b.itemId === itemId && b.kind === 'routine' && T.scheduleDayKey(new Date(b.start), S.profile.wakeMin) === k);
}
export function groupItems(g) {
  return routineItems().filter((i) => groupOf(i) === g).sort((a, b) => (a.routine.order - b.routine.order) || a.id.localeCompare(b.id));
}

function offTodayHTML(items) {
  return `<section class="off-routines" aria-label="Routines not scheduled today">
    <h2 class="group-name">Not scheduled today</h2>
    <p class="m">These follow their usual days. Tap one to do it today anyway.</p>
    <div class="tiles">${items.map((it) => tileHTML(it, groupHex(groupOf(it)))).join('')}</div>
  </section>`;
}

export function mount(el, _params, { compact = false } = {}) {
  root = el;
  render(true, compact);
  return { update: () => render(false, compact), unmount: () => { forgetBoil(el); root = null; } };
}

function counts() {
  let done = 0, total = 0;
  for (const it of routineItems()) {
    const b = todaysBlockFor(it.id);
    const logged = S.routineLog.some((entry) => entry.day === T.scheduleDayKey(T.now(), S.profile.wakeMin) && entry.itemId === it.id && entry.status === 'done');
    if (b) {
      total++;
      if (b.status === 'done' || logged) done++;
    } else if (logged) {
      total++;
      done++;
    }
  }
  return { done, total };
}

function render(first, compact) {
  if (!root) return;
  const { done, total } = counts();
  const wd = T.weekdayName(T.weekdayOf(T.scheduleDayKey(T.now(), S.profile.wakeMin)));
  const items = routineItems();
  const offToday = items.filter((it) => !todaysBlockFor(it.id));
  const prevTiles = new Map();
  root.querySelectorAll('[data-tile]').forEach((t) => prevTiles.set(t.dataset.tile, t.querySelector('.tile-check') ? 'done' : ''));
  const html = `
    ${compact ? '' : `<header class="hdr"><div><div class="m">${total ? `${esc(wd)} · ${done} of ${total} done` : 'A roomy day · nothing due'}</div><h1 class="h">Routines</h1></div><a class="mark-btn" href="#/settings" aria-label="Settings">${markSVG()}</a></header>`}
    <div class="week" data-week aria-label="This week's routines">${weekHTML()}</div>
    ${items.length ? GROUPS.map(([g, label]) => groupHTML(g, label)).join('') : emptyHTML()}
    ${offToday.length ? offTodayHTML(offToday) : ''}
    <div data-shelf></div>`;
  if (first) root.innerHTML = html;
  else {
    flip(root, () => { root.innerHTML = html; }, { selector: '[data-tile]', enter: 'pop' });
  }
  fillWeek(!first);
  root.querySelectorAll('[data-play]').forEach((b) => roughBorder(b, { color: groupHex(b.dataset.play), width: 1.5, radius: 18, seed: 'play' + b.dataset.play, draw: first }));
  wireTiles(first, prevTiles);
  renderShelf();
  observeBoil(root);
  if (first && !motion.reduced) {
    root.querySelectorAll('[data-tile]').forEach((t, i) => {
      set(t, { scale: 0.86, opacity: 0, y: 10, rotate: Number(t.dataset.tilt) });
      setTimeout(() => { to(t, { scale: 1, opacity: 1, y: 0 }, 'bouncy'); drawOn(t, { duration: 520, stagger: 60 }); }, 60 + i * 40);
    });
  } else {
    root.querySelectorAll('[data-tile]').forEach((t) => set(t, { rotate: Number(t.dataset.tilt) }));
  }
}

function weekHTML() {
  const today = T.scheduleDayKey(T.now(), S.profile.wakeMin);
  const wd = T.weekdayOf(today);
  const monday = T.addDays(today, -((wd + 6) % 7));
  const keys = Array.from({ length: 7 }, (_, i) => T.addDays(monday, i));
  return keys.map((k) => {
    const isToday = k === today;
    return `<div class="week-day${isToday ? ' today' : ''}" data-day="${k}">
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
        <defs><clipPath id="wc-${k}"><circle cx="16" cy="16" r="${isToday ? 14 : 14.25}"/></clipPath></defs>
        <rect class="week-fill" x="0" y="0" width="32" height="32" fill="var(--teal)" clip-path="url(#wc-${k})" style="transform-origin:16px 32px;transform:scaleY(0)"/>
        <circle cx="16" cy="16" r="${isToday ? 15 : 15.25}" fill="none" stroke="${isToday ? 'var(--vanilla)' : 'var(--line-3)'}" stroke-width="${isToday ? 2 : 1.5}"/>
      </svg><span class="m">${T.weekdayLetter(T.weekdayOf(k))}</span></div>`;
  }).join('');
}

async function fillWeek(animate) {
  const days = [...root.querySelectorAll('[data-day]')];
  const keys = days.map((d) => d.dataset.day);
  const fr = await routineWeek(keys);
  const today = T.scheduleDayKey(T.now(), S.profile.wakeMin);
  days.forEach((d, i) => {
    const f = keys[i] > today ? 0 : fr[i];
    const rect = d.querySelector('.week-fill');
    d.setAttribute('aria-label', `${T.shortDateKey(keys[i])}: ${Math.round(f * 100)}% of routines done`);
    const from = Number(rect.dataset.f || 0);
    rect.dataset.f = String(f);
    if (!animate || motion.reduced) { rect.style.transform = `scaleY(${f})`; return; }
    tween({ from, to: f, duration: 700, delay: 120 + i * 40, onUpdate: (v) => { rect.style.transform = `scaleY(${v.toFixed(3)})`; } });
  });
  if (!animate) {
    // first paint: fill up with a little stagger
    days.forEach((d, i) => {
      const rect = d.querySelector('.week-fill');
      const f = Number(rect.dataset.f);
      if (motion.reduced) return;
      rect.style.transform = 'scaleY(0)';
      tween({ from: 0, to: f, duration: 800, delay: 150 + i * 50, onUpdate: (v) => { rect.style.transform = `scaleY(${v.toFixed(3)})`; } });
    });
  }
}

function groupHTML(g, label) {
  const its = groupItems(g).filter((it) => todaysBlockFor(it.id));
  if (!its.length) return '';
  const color = groupHex(g);
  return `<section class="group" data-group="${g}" aria-label="${label} routines">
    <div class="group-head"><h2 class="group-name" style="color:${color};margin:0">${label}</h2>
      <button class="pill play" type="button" data-play="${g}" style="color:${color}">▶ Play</button></div>
    <div class="tiles" data-tiles="${g}">${its.map((it) => tileHTML(it, color)).join('')}</div></section>`;
}

function tileHTML(it, color) {
  const b = todaysBlockFor(it.id);
  const done = b && b.status === 'done';
  const sleeping = b && b.status === 'skipped';
  const state = !b ? ', not today' : done ? ', done' : sleeping ? ', sleeping in' : '';
  return `<button class="tile${sleeping ? ' is-sleeping' : ''}${!b ? ' is-off' : ''}" type="button" data-tile="${it.id}" data-flip="${it.id}" data-tilt="${tilt(it.id)}" style="background:${color}" aria-label="${esc(it.title)}${state}">
    ${doodleSVG(it.doodle, 48, '#111')}
    <span class="t">${esc(it.title)}</span>
    ${done ? `<span class="tile-check">${CHECK}</span>` : ''}
  </button>`;
}

function emptyHTML() {
  return `<div class="empty routine-empty">${doodleSVG('sparkle', 72, '#FDDEB2')}<p>${esc(pick('emptyRoutines'))}</p>
    <button class="btn btn-sm" type="button" data-add-routine>Add a routine</button></div>`;
}

function renderShelf() {
  const slot = root.querySelector('[data-shelf]');
  const sleeping = routineItems().map((it) => ({ it, b: todaysBlockFor(it.id) })).filter((x) => x.b && x.b.status === 'skipped');
  if (!sleeping.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="shelf"><div class="shelf-head"><span class="eyebrow" style="color:var(--blush)">Sleeping in</span><span class="m">${esc(pick('sleepingIn'))}</span></div>
    <div class="shelf-row">${sleeping.map(({ it, b }) => `<button class="shelf-chip" type="button" data-wake="${b.id}">${doodleSVG(it.doodle, 22, groupHex(groupOf(it)), { boil: false })}<span>${esc(it.title)}</span><span class="m">wake</span></button>`).join('')}</div></div>`;
}

function wireTiles(first, prevTiles) {
  root.onclick = async (e) => {
    const play = e.target.closest('[data-play]');
    if (play) {
      const firstTile = root.querySelector(`[data-tiles="${play.dataset.play}"] [data-tile]`);
      if (firstTile) firstTile.style.viewTransitionName = 'guided-tile';
      go(`guided/${play.dataset.play}`);
      return;
    }
    const wake = e.target.closest('[data-wake]');
    if (wake) { await blockAction(wake.dataset.wake, 'undo'); return; }
    if (e.target.closest('[data-add-routine]')) {
      const { openQuickAdd } = await import('./quickadd.js');
      openQuickAdd({ text: 'cream every night after shower', from: e.target.closest('button') });
    }
  };
  root.querySelectorAll('[data-tile]').forEach((tile) => {
    const it = itemById(tile.dataset.tile);
    // newly completed since last render: stamp + celebrate
    if (!first && tile.querySelector('.tile-check') && prevTiles.get(it.id) !== 'done') celebrate(tile, it);
    // press squish + parallax tilt
    tile.addEventListener('pointerdown', () => to(tile, { scale: 0.96 }, { stiffness: 700, damping: 30 }));
    const release = () => to(tile, { scale: 1, rx: 0, ry: 0 }, 'bouncy');
    tile.addEventListener('pointerup', release);
    tile.addEventListener('pointerleave', release);
    tile.addEventListener('pointercancel', release);
    tile.addEventListener('pointermove', (e) => {
      if (motion.reduced || tile.classList.contains('dragging')) return;
      const r = tile.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      to(tile, { ry: px * 12, rx: -py * 12 }, { stiffness: 300, damping: 26 });
    });
    tile.addEventListener('click', () => { if (!tile._dragged) openQuick(it, tile); });
    tile.addEventListener('touchmove', (e) => { if (tile.classList.contains('dragging')) e.preventDefault(); }, { passive: false });
    if (!tile.closest('.off-routines')) wireReorder(tile, it);
  });
}

function celebrate(tile, it) {
  checkBounce(tile.querySelector('.tile-check'));
  const d = tile.querySelector('svg.doodle');
  if (d) react(d, it.doodle);
  const r = tile.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, { count: 8, seed: it.id, colors: ['#111111', groupHex(groupOf(it)), '#7CBB93'], finishEffect: true });
}

// long-press then drag to reorder within the group; neighbours spring aside
function wireReorder(tile, it) {
  const g = groupOf(it);
  let siblings = [], rects = [], startIdx = 0, curIdx = 0;
  drag(tile, {
    longPress: 380,
    onStart: () => {
      const wrap = tile.parentElement;
      siblings = [...wrap.querySelectorAll('[data-tile]')];
      rects = siblings.map((s) => s.getBoundingClientRect());
      startIdx = curIdx = siblings.indexOf(tile);
      tile.classList.add('dragging');
      tile._dragged = true;
      to(tile, { scale: 1.08, rx: 0, ry: 0 }, 'bouncy');
      buzz(10);
    },
    onMove: ({ dx, dy, e }) => {
      set(tile, { x: dx, y: dy });
      // nearest slot
      let best = curIdx, bd = Infinity;
      rects.forEach((r, i) => {
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < bd) { bd = d; best = i; }
      });
      if (best !== curIdx) {
        curIdx = best;
        // compute where each sibling should sit visually
        const order = siblings.filter((s) => s !== tile);
        order.splice(curIdx, 0, tile);
        order.forEach((s, i) => {
          if (s === tile) return;
          const from = rects[siblings.indexOf(s)], target = rects[i];
          to(s, { x: target.left - from.left, y: target.top - from.top }, 'snappy');
        });
      }
    },
    onEnd: async () => {
      tile.classList.remove('dragging');
      setTimeout(() => { tile._dragged = false; }, 50);
      const order = siblings.filter((s) => s !== tile);
      order.splice(curIdx, 0, tile);
      const target = rects[curIdx], from = rects[startIdx];
      await to(tile, { x: target.left - from.left, y: target.top - from.top, scale: 1 }, 'snappy');
      if (curIdx !== startIdx) {
        siblings.forEach((s) => set(s, { x: 0, y: 0 }));
        const wrap = tile.parentElement;
        order.forEach((s) => wrap.appendChild(s));
        await reorderRoutines(order.map((s) => s.dataset.tile));
        announce(`${it.title} moved to position ${curIdx + 1} in ${g}`);
      } else set(tile, { x: 0, y: 0 });
    },
  });
}

/** Quick sheet for a routine: done / sleep in / edit / move. */
export function openQuick(it, from) {
  const b = todaysBlockFor(it.id);
  const day = T.scheduleDayKey(T.now(), S.profile.wakeMin);
  const extraDone = !b && S.routineLog.some((entry) => entry.day === day && entry.itemId === it.id && entry.status === 'done');
  const color = groupHex(groupOf(it));
  const siblings = groupItems(groupOf(it));
  const idx = siblings.findIndex((x) => x.id === it.id);
  openSheet({
    label: it.title,
    from,
    seed: it.id,
    body: `
      <div class="qa-preview"><div class="qa-doodle" style="background:${color}">${doodleSVG(it.doodle, 44, '#111')}</div>
        <div><div class="sheet-title" style="margin:0">${esc(it.title)}</div><div class="m">${esc(it.routine.detail || '')}${b ? ` · ${T.clock(new Date(b.start))}` : ' · not today'}</div></div></div>
      <div class="sheet-actions">
        ${b ? (b.status === 'done'
    ? `<button class="btn btn-ghost" data-q="undo">Not done yet</button>`
    : `<button class="btn btn-primary" style="background:${color}" data-q="done">Done today</button>`)
          : extraDone
            ? `<button class="btn btn-ghost" data-q="extra-undo">Undo today’s extra</button>`
            : `<button class="btn btn-primary" style="background:${color}" data-q="extra-done">Do it today anyway</button>`}
        ${b && b.status === 'planned' ? `<button class="btn btn-ghost" data-q="skip">Sleep in</button>` : ''}
        ${b && b.status === 'skipped' ? `<button class="btn btn-ghost" data-q="undo">Wake it up</button>` : ''}
        <div class="row"><button class="btn btn-ghost" data-q="up" ${idx <= 0 ? 'disabled' : ''} aria-label="Move ${esc(it.title)} earlier">↑ Earlier</button><button class="btn btn-ghost" data-q="down" ${idx >= siblings.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(it.title)} later">↓ Later</button></div>
        <button class="btn btn-text" data-q="edit">Edit details</button>
      </div>`,
    onMount: (s) => {
      drawOn(s.el, { duration: 500 });
      s.el.addEventListener('click', async (e) => {
        const q = e.target.closest('[data-q]');
        if (!q) return;
        const act = q.dataset.q;
        if (act === 'edit') { s.close(); const { openEditor } = await import('./editor.js'); openEditor(it); return; }
        if (act === 'extra-done' || act === 'extra-undo') {
          await markRoutineToday(it.id, act === 'extra-done');
          s.close();
          toast(act === 'extra-done' ? `${it.title} done for today.` : `${it.title} is open again.`);
          return;
        }
        if (act === 'up' || act === 'down') {
          const ids = siblings.map((x) => x.id);
          const j = idx + (act === 'up' ? -1 : 1);
          [ids[idx], ids[j]] = [ids[j], ids[idx]];
          s.close();
          await reorderRoutines(ids);
          return;
        }
        s.close();
        const nb = await blockAction(b.id, act === 'done' ? 'done' : act === 'skip' ? 'skip' : 'undo');
        if (nb && nb.status === 'done') {
          pop(1.1);
          const line = routineLine(it.doodle, it.id);
          toast(line, { tone: 'ok' });
          const all = counts();
          if (all.total && all.done === all.total) setTimeout(() => { chime(); toast(pick('routinesAllDone')); }, 600);
        }
        if (nb && nb.status === 'skipped') toast(`${it.title}: ${pick('sleepingIn', it.id).toLowerCase()}`);
      });
    },
  });
}
