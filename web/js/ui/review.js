// Review plan: the proposed diff as a thread. Nothing moves until approved.
import { S, freshProposal, applyProposal, undo, canUndo, itemById } from '../state.js';
import * as T from '../time.js';
import { doodleSVG } from '../doodle.js';
import { set, to, drawOn, motion, observeBoil, forgetBoil, tween } from '../anim.js';
import { roughBorder, roughCircle } from '../rough.js';
import { esc, itemHex, announce, toast } from '../dom.js';
import { pick } from '../copy.js';
import { stamp, burst } from '../fx.js';
import { pop, chime, scratch } from '../sound.js';
import { go } from '../router.js';

let root = null;
let accepted = new Set();
let proposal = null;

export function mount(el) {
  root = el;
  proposal = freshProposal();
  const changes = visibleChanges();
  accepted = new Set(changes.map((c) => c.id)); // Accept is pre-selected
  render();
  return { unmount: () => { forgetBoil(el); root = null; } };
}

function visibleChanges() {
  return (proposal && proposal.changes ? proposal.changes : []).filter((c) => itemById(c.itemId));
}

function minutesOf(c) {
  const s = c.toStart || c.fromStart, e = c.toEnd || c.fromEnd;
  return s && e ? T.minutesBetween(s, e) : 0;
}

function summary(changes) {
  const sleeping = changes.filter((c) => c.kind === 'moved' && S.plan.blocks.some((b) => b.status === 'skipped' && b.itemId === c.itemId && b.start === c.fromStart));
  const passed = changes.filter((c) => c.kind === 'moved' && c.fromEnd && new Date(c.fromEnd) < T.now() && !sleeping.includes(c));
  const bits = [];
  const name = (c) => itemById(c.itemId).title;
  if (sleeping.length) bits.push(`${[...new Set(sleeping.map(name))].join(' and ')} ${sleeping.length > 1 ? 'are' : 'is'} sleeping in`);
  if (passed.length) bits.push(`${[...new Set(passed.map(name))].slice(0, 2).join(' and ')} slipped past`);
  if (!bits.length) bits.push('A few things shifted');
  return `${bits.join(' and ')}. ${pick('reviewIntro')}`;
}

function render() {
  if (!root) return;
  const changes = visibleChanges();
  const risky = changes.some((c) => c.kind === 'atRisk');
  root.innerHTML = `
    <div class="m">Review plan</div>
    <h1 class="h">${changes.length ? 'Your day got interesting' : 'All calm'}</h1>
    ${changes.length ? `<div class="m review-intro">${esc(summary(changes))}</div>
      <div class="pill pill-ok" data-okpill style="margin-top:12px">${changes.length} tweak${changes.length === 1 ? '' : 's'} · ${risky ? 'one deadline needs a look' : 'every deadline still safe'}</div>
      <div class="thread" data-thread>
        <svg class="thread-line" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 4 100"><path data-draw d="M2 0 C3 20 1 40 2 60 C3 80 1.5 90 2 100" stroke="var(--line-2)" stroke-width="1.5" fill="none" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/></svg>
        ${changes.map(changeHTML).join('')}
      </div>
      <div class="review-foot">
        <button class="btn btn-primary" data-approve>Approve ${accepted.size === changes.length ? `all ${changes.length}` : `${accepted.size} of ${changes.length}`}</button>
        <button class="btn btn-text" data-reject>Reject all</button>
        <div class="m" style="font-size:12px">You can undo this for 24 hours</div>
      </div>` : `
      <div class="empty">${doodleSVG('sun', 88, '#7CBB93')}<p>${esc(pick('emptyReview'))}</p>
      <button class="btn btn-sm" data-home>Back to Today</button>
      <div data-undo-slot></div></div>`}`;
  roughBorder(root.querySelector('[data-okpill]'), { color: risky ? 'var(--navajo)' : 'var(--teal)', width: 1.5, radius: 18, seed: 'ok', draw: true });
  const ok = root.querySelector('[data-okpill]');
  if (ok && risky) ok.style.color = 'var(--navajo)';
  wire();
  observeBoil(root);
  // staggered draw-on along the thread, with ghost old time sliding to the new one
  root.querySelectorAll('[data-change]').forEach((row, i) => {
    if (motion.reduced) return;
    set(row, { opacity: 0, x: -14 });
    setTimeout(() => {
      to(row, { opacity: 1, x: 0 }, 'gentle');
      drawOn(row.querySelector('.change-icon'), { duration: 520 });
      const ghost = row.querySelector('.ghost');
      if (ghost) {
        set(ghost, { opacity: 0.8, x: 0 });
        setTimeout(() => to(ghost, { x: 46, opacity: 0 }, { stiffness: 90, damping: 18 }), 350);
      }
    }, 120 + i * 140);
  });
  drawOn(root.querySelector('.thread-line'), { duration: 900 });
  const slot = root.querySelector('[data-undo-slot]');
  if (slot) canUndo().then((y) => { if (y && slot.isConnected) { slot.innerHTML = '<button class="btn btn-ghost btn-sm" data-undo>Undo the last plan change</button>'; slot.firstElementChild.onclick = doUndo; } });
}

function changeHTML(c) {
  const it = itemById(c.itemId);
  const color = itemHex(it);
  const mins = minutesOf(c);
  let title = `${esc(it.title)}${mins ? ` · ${mins} min` : ''}`;
  let when = '';
  if (c.kind === 'moved') when = `<span class="old">${esc(T.relWhen(new Date(c.fromStart)))}</span> → <span>${esc(T.relWhen(new Date(c.toStart)))}</span><span class="ghost m" aria-hidden="true">${esc(T.clock(new Date(c.fromStart)))}</span>`;
  else if (c.kind === 'shortened') { title = `${esc(it.title)} · ${T.minutesBetween(c.fromStart, c.fromEnd)} → ${mins} min`; when = 'Shortened a little'; }
  else if (c.kind === 'added') when = `New: ${esc(T.relWhen(new Date(c.toStart)))}`;
  else if (c.kind === 'dropped') { title = `${esc(it.title)} · ${T.minutesBetween(c.fromStart, c.fromEnd)} min`; when = `No longer needed: ${esc(T.relWhen(new Date(c.fromStart)))}`; }
  else if (c.kind === 'atRisk') when = 'Tight on time';
  else if (c.kind === 'watch') when = 'Keep an eye on it';
  const on = accepted.has(c.id);
  return `<div class="change${on ? '' : ' skipped'}" data-change="${c.id}">
    <div class="change-icon">${roughRing(color, c.id)}${doodleSVG(it.doodle, 32, color)}</div>
    <div class="change-main">
      <div class="change-title">${title}</div>
      <div class="m change-when">${when}</div>
      <div class="m change-reason" style="color:${color}">${esc(c.reason)}</div>
      <div class="change-btns">
        <button class="btn accept" style="background:${color};color:#111" data-accept="${c.id}" aria-pressed="${on}">Accept</button>
        <button class="btn btn-ghost skip" data-skip="${c.id}" aria-pressed="${!on}">Skip</button>
      </div>
    </div></div>`;
}

function roughRing(color, seed) {
  return `<svg width="56" height="56" viewBox="0 0 56 56" style="position:absolute;inset:0" aria-hidden="true"><path data-draw d="${roughCircle(28, 28, 26.5, seed, { jitter: 0.7 })}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function wire() {
  root.onclick = async (e) => {
    const a = e.target.closest('[data-accept]');
    const s = e.target.closest('[data-skip]');
    if (a || s) {
      const id = (a || s).dataset.accept || (a || s).dataset.skip;
      const row = root.querySelector(`[data-change="${id}"]`);
      if (a) {
        if (!accepted.has(id)) {
          accepted.add(id);
          row.classList.remove('skipped');
          if (!motion.reduced) stamp(row.querySelector('.change-icon'), { color: '#7CBB93', label: '', seed: id, size: 52, finishEffect: true });
          pop(1.2);
        }
      } else if (accepted.has(id)) {
        accepted.delete(id);
        row.classList.add('skipped');
        scratch();
      }
      row.querySelector('[data-accept]').setAttribute('aria-pressed', String(accepted.has(id)));
      row.querySelector('[data-skip]').setAttribute('aria-pressed', String(!accepted.has(id)));
      const n = visibleChanges().length;
      root.querySelector('[data-approve]').textContent = accepted.size === n ? `Approve all ${n}` : `Approve ${accepted.size} of ${n}`;
      return;
    }
    if (e.target.closest('[data-approve]')) return approve([...accepted]);
    if (e.target.closest('[data-reject]')) return approve([]);
    if (e.target.closest('[data-home]')) go('today');
  };
}

async function approve(ids) {
  const btn = root.querySelector('[data-approve]');
  btn.disabled = true;
  // cascade: accepted rows glide down and settle, the rest fade to outline
  const rows = [...root.querySelectorAll('[data-change]')];
  if (!motion.reduced) {
    rows.forEach((r, i) => {
      const on = ids.includes(r.dataset.change);
      setTimeout(() => to(r, on ? { x: 18, opacity: 0.15, scale: 0.97 } : { opacity: 0.3 }, { stiffness: 180, damping: 20 }), i * 90);
    });
    await new Promise((r) => setTimeout(r, rows.length * 90 + 260));
  }
  const res = await applyProposal(ids, proposal);
  if (ids.length) { chime(); const r = btn.getBoundingClientRect(); burst(r.left + r.width / 2, r.top, { count: 10, seed: 'approve' }); }
  const msg = ids.length ? pick('approved') : 'Kept your plan as it was.';
  announce(msg);
  if (res.conflicts && res.conflicts.length) toast(`${res.conflicts.length} change${res.conflicts.length > 1 ? 's' : ''} stayed put: ${res.conflicts[0].reason}`, { ms: 6000 });
  else toast(msg, { action: { label: 'Undo', fn: doUndo }, ms: 6000 });
  go('today');
}

async function doUndo() {
  const ok = await undo();
  toast(ok ? pick('undone') : 'Nothing to undo right now.');
}
