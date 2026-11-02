// Today: header, drift pill, the Day Arc, the Focus Card, sleeping-in shelf.
import { S, blockAction, itemById, moveBlock, clashAt, timerState, toggleTimer, checkDrift } from '../state.js';
import * as T from '../time.js';
import { createArc, nodeRadius, tintFor, axisLabels, VIEW } from '../arc.js';
import { doodleSVG, doodleInSVG } from '../doodle.js';
import { set, to, Spring, drawOn, flip, motion, observeBoil, forgetBoil, tween } from '../anim.js';
import { drag } from '../gestures.js';
import { roughBorder, roughLine, tilt } from '../rough.js';
import { esc, announce, toast, itemHex, groupOf, squishy, CHECK } from '../dom.js';
import { pick } from '../copy.js';
import { burst, stamp, floatDoodle, react } from '../fx.js';
import { pop, chime, scratch, buzz } from '../sound.js';
import { go } from '../router.js';
import { markSVG } from '../mark.js';

let root = null;
let arc = null;
let nodes = new Map(); // id -> { g, spring, mid }
let tick = 0;
let minuteTick = 0;
let focusId = null;
let opened = null; // open detail card
let busy = false;

const GROUP_LABEL = { morning: 'Morning', daytime: 'Daytime', evening: 'Evening' };

// ---- data ---------------------------------------------------------------------
function todayBlocks() {
  const k = T.dayKey();
  return S.plan.blocks.filter((b) => T.dayKey(new Date(b.start)) === k);
}
function focusBlocks() {
  const nowMs = T.nowMs();
  const list = S.plan.blocks
    .filter((b) => (b.kind === 'work' || b.kind === 'event') && b.status === 'planned' && new Date(b.end).getTime() > nowMs)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  return list;
}
function arcNodes() {
  const out = [];
  const groups = new Map();
  for (const b of todayBlocks()) {
    if (b.status === 'skipped' || b.status === 'moved') continue;
    const it = itemById(b.itemId);
    if (!it) continue;
    const s = new Date(b.start), e = new Date(b.end);
    const mid = (T.minOfDay(s) + T.minOfDay(e)) / 2;
    if (b.kind === 'routine') {
      const g = groupOf(it);
      if (!groups.has(g)) groups.set(g, { id: `grp-${g}`, kind: 'routine', group: g, blocks: [], mid: T.minOfDay(s) });
      groups.get(g).blocks.push({ b, it });
      continue;
    }
    const mins = T.minutesBetween(s, e);
    out.push({ id: b.id, kind: b.kind, block: b, item: it, mid, r: nodeRadius(mins), color: itemHex(it), doodle: it.doodle, label: shortLabel(it.title), done: b.status === 'done' });
  }
  for (const g of groups.values()) {
    const todo = g.blocks.filter((x) => x.b.status !== 'done');
    const lead = todo[0] || g.blocks[g.blocks.length - 1];
    const label = todo.length === 1 ? todo[0].it.title : todo.length === 0 ? GROUP_LABEL[g.group] : `${GROUP_LABEL[g.group]} · ${todo.length}`;
    out.push({ id: g.id, kind: 'routine', group: g.group, blocks: g.blocks, mid: g.mid + 2, r: 14, color: itemHex(lead.it), doodle: lead.it.doodle, label: shortLabel(label), done: todo.length === 0 });
  }
  return out.sort((a, b) => a.mid - b.mid);
}
const shortLabel = (s) => (s.length > 14 ? s.slice(0, 13) + '…' : s);

// ---- render ---------------------------------------------------------------------
export function mount(el) {
  root = el;
  nodes = new Map();
  focusId = null;
  const hour = T.parts(T.now()).hh;
  const greet = pick(hour >= 18 ? 'greetingEvening' : 'greeting');
  el.innerHTML = `
    <header class="hdr">
      <div><div class="m" data-date>${esc(T.longDate())}</div><h1 class="h">${esc(greet)}</h1></div>
      <a class="mark-btn" href="#/settings" aria-label="Settings">${markSVG()}</a>
    </header>
    <div class="drift-slot" data-drift-slot></div>
    <div class="arc-wrap" data-arc-wrap>
      <svg class="arc" data-arc viewBox="0 0 ${VIEW.w} ${VIEW.h}" role="img" aria-label="Energy arc for today with your blocks placed along the curve"></svg>
      <div class="arc-axis" data-axis aria-hidden="true"></div>
      <div class="arc-detail-slot" data-detail></div>
    </div>
    <div class="focus-zone" data-focus-zone></div>
    <div class="shelf-slot" data-shelf></div>
    <div class="tuck-slot" data-tuck></div>
    <div class="desk-side" data-desk></div>`;
  renderDrift(true);
  renderArc(true);
  renderFocus('enter');
  renderShelf();
  renderTuck();
  startTicks();
  mountDesk();
  return { update, unmount };
}

// Desktop (>= 900px): routines + horizon live in a second column.
let desk = [];
const wide = matchMedia('(min-width: 900px)');
async function mountDesk() {
  const slot = root && root.querySelector('[data-desk]');
  if (!slot || !wide.matches) return;
  slot.innerHTML = `<section class="desk-panel" aria-label="Routines"><h2>Routines</h2><div data-desk-r></div></section>
    <section class="desk-panel" aria-label="Horizon"><h2>Horizon</h2><div data-desk-h></div></section>`;
  slot.querySelectorAll('.desk-panel').forEach((p, i) => roughBorder(p, { color: 'var(--line)', width: 1.5, radius: 32, seed: 'desk' + i, draw: true }));
  const [r, h] = await Promise.all([import('./routines.js'), import('./horizon.js')]);
  if (!root) return;
  desk = [r.mount(slot.querySelector('[data-desk-r]'), [], { compact: true }), h.mount(slot.querySelector('[data-desk-h]'), [], { compact: true })];
}

function unmount() {
  desk.forEach((d) => d && d.unmount && d.unmount());
  desk = [];
  clearInterval(tick); clearInterval(minuteTick);
  forgetBoil(root);
  root = null;
}

function update(reason, detail) {
  if (!root) return;
  desk.forEach((d) => d && d.update && d.update(reason, detail));
  if (reason === 'drift' || reason === 'plan' || reason === 'block') renderDrift();
  if (reason === 'plan' || reason === 'block' || reason === 'profile' || reason === 'item-added') {
    renderArc(false);
    if (!busy) renderFocus('soft');
    renderShelf();
    renderTuck();
  }
  if (reason === 'meta') renderFocus('none');
}

function renderDrift(first) {
  const slot = root.querySelector('[data-drift-slot]');
  const want = S.drifted;
  const has = slot.firstElementChild;
  if (want && !has) {
    slot.innerHTML = `<button class="pill pill-drift" type="button">${esc(pick('drift'))}</button>`;
    const b = slot.firstElementChild;
    roughBorder(b, { color: 'var(--navajo)', width: 1.5, radius: 22, seed: 'drift', draw: true });
    squishy(b);
    b.addEventListener('click', () => go('review'));
    if (!first) { set(b, { scale: 0.8, opacity: 0 }); to(b, { scale: 1, opacity: 1 }, 'bouncy'); }
  } else if (!want && has) {
    to(has, { scale: 0.9, opacity: 0 }, 'snappy').then(() => { if (!S.drifted) slot.innerHTML = ''; });
  }
}

// ---- the arc ---------------------------------------------------------------------
function renderArc(first) {
  const svg = root.querySelector('[data-arc]');
  arc = createArc(S.profile);
  const nowMin = T.minOfDay();
  const past = Math.max(arc.wake, Math.min(arc.sleep, nowMin));
  const np = arc.point(past);
  if (first || !svg.firstChild) {
    svg.innerHTML = `
      <defs><radialGradient id="now-halo"><stop offset="0" stop-color="#FFF7E6" stop-opacity=".28"/><stop offset="1" stop-color="#FFF7E6" stop-opacity="0"/></radialGradient></defs>
      <path class="arc-area" data-area fill="${tintFor(nowMin)}" d="${arc.areaTo(past)}"/>
      <g class="arc-breathe">
        <path data-full class="arc-future" d="${arc.full}"/>
        <path data-past class="arc-past" d="${arc.pathTo(past)}"/>
        <g data-twinkles>${twinkles()}</g>
        <g data-nodes></g>
        <g class="arc-now" data-now transform="translate(${np[0].toFixed(1)} ${np[1].toFixed(1)})"><g class="arc-now-bob">
          <circle r="34" fill="url(#now-halo)"/>
          <circle r="29" class="arc-now-halo"/>
          <circle r="5" class="arc-now-dot"/>
        </g></g>
      </g>`;
    if (!motion.reduced) {
      const past = svg.querySelector('[data-past]');
      past.setAttribute('pathLength', '1'); past.style.strokeDasharray = '1'; past.style.strokeDashoffset = '1';
      tween({ from: 1, to: 0, duration: 900, onUpdate: (v) => { past.style.strokeDashoffset = String(v); }, onDone: () => { past.removeAttribute('pathLength'); past.style.strokeDasharray = ''; past.style.strokeDashoffset = ''; } });
    }
  } else {
    svg.querySelector('[data-full]').setAttribute('d', arc.full);
    svg.querySelector('[data-past]').setAttribute('d', arc.pathTo(past));
    const area = svg.querySelector('[data-area]');
    area.setAttribute('d', arc.areaTo(past));
    area.setAttribute('fill', tintFor(nowMin));
    svg.querySelector('[data-now]').setAttribute('transform', `translate(${np[0].toFixed(1)} ${np[1].toFixed(1)})`);
  }
  root.querySelector('[data-axis]').innerHTML = axisLabels(arc).map((l) => `<span style="left:${((l.x / VIEW.w) * 100).toFixed(2)}%">${T.clockMin(l.m)}</span>`).join('');
  layoutNodes(first);
}

function twinkles() {
  const spots = [[38, 40], [200, 22], [292, 150], [120, 150], [338, 30]];
  return spots.map(([x, y], i) => `<g class="twinkle" style="animation-delay:${(i * 1.7).toFixed(1)}s" transform="translate(${x} ${y})"><path d="M0 -4 C0.4 -1 1 -0.4 4 0 C1 0.4 0.4 1 0 4 C-0.4 1 -1 0.4 -4 0 C-1 -0.4 -0.4 -1 0 -4Z" fill="none" stroke="var(--vanilla)" stroke-width="1" stroke-linejoin="round"/></g>`).join('');
}

function nodeInner(n) {
  const r = n.r;
  let shape;
  if (n.kind === 'routine') {
    const s = r * 2;
    const ds = Math.round(s * 0.71);
    shape = `<rect x="${-r}" y="${-r}" width="${s}" height="${s}" rx="${(s * 0.32).toFixed(2)}" fill="${n.color}" class="node-shape"/>` +
      doodleInSVG(n.doodle, -ds / 2, -ds / 2, ds, '#111', { draw: true });
  } else if (n.kind === 'event') {
    shape = `<circle r="${r.toFixed(1)}" fill="none" stroke="${n.color}" stroke-width="2" class="node-shape"/>`;
  } else {
    const ds = Math.round(r * 1.25);
    shape = `<circle r="${r.toFixed(1)}" fill="#000" stroke="${n.color}" stroke-width="2" class="node-shape"/>` +
      doodleInSVG(n.doodle, -ds / 2, -ds / 2, ds, n.color, { draw: true });
  }
  const hit = `<circle r="${Math.max(r, 23)}" class="node-hit"/>`;
  const conflict = `<circle r="${(r + 5).toFixed(1)}" class="node-conflict"/><circle r="${(r + 5).toFixed(1)}" class="node-lift"/>`;
  const badge = n.done ? `<g class="node-done" transform="translate(${(r * 0.72).toFixed(1)} ${(-r * 0.72).toFixed(1)})"><circle r="7" fill="var(--teal)"/><path d="M-3 0 l2 2 4 -4" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>` : '';
  return `${conflict}${shape}${badge}${hit}`;
}

function layoutNodes(first) {
  const layer = root.querySelector('[data-nodes]');
  const list = arcNodes();
  const seen = new Set();
  // Neighbouring nodes shrink (down to r=9) rather than overlap, so a run of
  // back-to-back blocks reads as a string of beads instead of a pile.
  for (let k = 0; k < 2; k++) {
    for (let j = 1; j < list.length; j++) {
      const a = list[j - 1], b = list[j];
      const pa = arc.point(a.mid), pb = arc.point(b.mid);
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      if (d < a.r + b.r + 2) {
        const f = Math.max(0, d - 2) / (a.r + b.r);
        a.r = Math.max(9, a.r * f); b.r = Math.max(9, b.r * f);
      }
    }
  }
  // Labels go above near the top of the arc, else below; they avoid nodes and
  // each other, and stay quiet (still in the aria-label) when there is no room.
  const boxes = list.map((n) => { const p = arc.point(n.mid); return [p[0] - n.r, p[1] - n.r, p[0] + n.r, p[1] + n.r]; });
  const taken = [];
  const hit = (r) => [...boxes, ...taken].some((q) => !(r[2] < q[0] + 1 || r[0] > q[2] - 1 || r[3] < q[1] + 1 || r[1] > q[3] - 1));
  for (const n of list) {
    const p = arc.point(n.mid);
    const w = n.label.length * 5.6;
    const rect = (side) => (side === 'above' ? [p[0] - w / 2, p[1] - n.r - 18, p[0] + w / 2, p[1] - n.r - 6] : [p[0] - w / 2, p[1] + n.r + 3, p[0] + w / 2, p[1] + n.r + 15]);
    const order = p[1] < 80 ? ['above', 'below'] : ['below', 'above'];
    n.side = order.find((s) => !hit(rect(s))) || order[0];
    n.quiet = hit(rect(n.side));
    if (!n.quiet) taken.push(rect(n.side));
  }
  let i = 0;
  for (const n of list) {
    seen.add(n.id);
    let rec = nodes.get(n.id);
    const labelY = n.side === 'above' ? -n.r - 8 : n.r + 13;
    const labelHTML = `<text class="node-label${n.quiet ? ' quiet' : ''}" y="${labelY.toFixed(1)}" text-anchor="middle">${esc(n.label)}</text>`;
    if (!rec) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `node node-${n.kind}${n.done ? ' is-done' : ''}`);
      g.setAttribute('data-node', n.id);
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.innerHTML = `<g class="node-body">${nodeInner(n)}</g>${labelHTML}`;
      layer.appendChild(g);
      const spring = new Spring(n.mid, { stiffness: 170, damping: 22, onUpdate: (m) => place(g, m) });
      rec = { g, spring, n };
      nodes.set(n.id, rec);
      place(g, n.mid);
      wireNode(rec);
      const body = g.querySelector('.node-body');
      if (!motion.reduced) {
        body.style.transformBox = 'fill-box'; body.style.transformOrigin = 'center';
        set(body, { scale: 0.2, opacity: 0 });
        setTimeout(() => { to(body, { scale: 1, opacity: 1 }, 'bouncy'); drawOn(g, { duration: 480, stagger: 50 }); }, (first ? 300 : 0) + i * 70);
      }
      i++;
    } else {
      const old = rec.n;
      rec.n = n;
      rec.g.setAttribute('class', `node node-${n.kind}${n.done ? ' is-done' : ''}`);
      const changed = old.r !== n.r || old.doodle !== n.doodle || old.done !== n.done || old.color !== n.color;
      if (changed) {
        rec.g.querySelector('.node-body').innerHTML = nodeInner(n);
        if (n.done && !old.done) drawOn(rec.g.querySelector('.node-done') || rec.g, { duration: 300 });
      }
      rec.g.querySelector('.node-label').outerHTML = labelHTML;
      if (Math.abs(rec.spring.target - n.mid) > 0.5) {
        ghost(rec, rec.spring.value);
        rec.spring.to(n.mid);
      }
    }
    rec.g.setAttribute('aria-label', ariaFor(n));
  }
  for (const [id, rec] of nodes) {
    if (seen.has(id)) continue;
    nodes.delete(id);
    to(rec.g, { opacity: 0 }, 'snappy').then(() => rec.g.remove());
  }
  observeBoil(root);
}

function ariaFor(n) {
  if (n.kind === 'routine') return `${GROUP_LABEL[n.group]} routines, ${n.blocks.filter((x) => x.b.status === 'done').length} of ${n.blocks.length} done`;
  return `${n.item.title}, ${T.clock(new Date(n.block.start))} to ${T.clock(new Date(n.block.end))}${n.done ? ', done' : ''}`;
}

function place(g, m) {
  const p = arc.point(m);
  g.setAttribute('transform', `translate(${p[0].toFixed(2)} ${p[1].toFixed(2)})`);
}

/** A brief faded copy left behind when a node glides somewhere new. */
function ghost(rec, fromMin) {
  if (motion.reduced) return;
  const c = rec.g.cloneNode(true);
  c.removeAttribute('data-node'); c.removeAttribute('tabindex'); c.removeAttribute('role');
  c.classList.add('node-ghost');
  place(c, fromMin);
  rec.g.parentNode.insertBefore(c, rec.g);
  tween({ from: 0.45, to: 0, duration: 600, onUpdate: (v) => { c.style.opacity = String(v); }, onDone: () => c.remove() });
}

// ---- node interactions: tap = detail morph, drag = move with snap -------------------
function wireNode(rec) {
  const g = rec.g;
  const movable = () => rec.n.kind === 'work' && rec.n.block.status === 'planned' && new Date(rec.n.block.start) > T.now();
  g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(rec); } });
  let dragging = false;
  let startMin = 0;
  let tip = null;
  drag(g, {
    threshold: 6,
    onStart: () => {
      if (!movable()) return;
      dragging = true;
      startMin = rec.spring.value;
      g.classList.add('lifting');
      const body = g.querySelector('.node-body');
      body.style.transformBox = 'fill-box'; body.style.transformOrigin = 'center';
      to(body, { scale: 1.22 }, 'bouncy');
      tip = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tip.setAttribute('class', 'node-tip');
      tip.setAttribute('text-anchor', 'middle');
      tip.setAttribute('y', String(-rec.n.r - 22));
      g.appendChild(tip);
      buzz(6);
    },
    onMove: ({ e }) => {
      if (!dragging) return;
      const svg = root.querySelector('[data-arc]');
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
      const len = T.minutesBetween(rec.n.block.start, rec.n.block.end);
      let startM = Math.round((arc.minOfX(loc.x) - len / 2) / 5) * 5;
      const peak = arc.peakNear(startM, 15);
      if (peak !== null) startM = peak; // magnetic snap to an energy peak
      const minStart = Math.max(arc.wake, Math.ceil(T.minOfDay() / 5) * 5);
      startM = Math.max(minStart, Math.min(arc.sleep - len, startM));
      const mid = startM + len / 2;
      rec.spring.to(mid);
      const day = T.dayKey();
      const s = T.at(day, startM), en = T.at(day, startM + len);
      const clash = clashAt(rec.n.block.id, s, en);
      g.classList.toggle('clash', !!clash);
      rec.pending = clash ? null : s;
      tip.textContent = `${T.clockMin(startM)}${peak !== null ? ' · peak' : ''}${clash ? ' · busy' : ''}`;
    },
    onEnd: async ({ cancelled }) => {
      if (!dragging) return;
      dragging = false;
      rec.justDragged = true;
      setTimeout(() => { rec.justDragged = false; }, 50);
      g.classList.remove('lifting');
      to(g.querySelector('.node-body'), { scale: 1 }, 'bouncy');
      if (tip) tip.remove();
      const clash = g.classList.contains('clash');
      g.classList.remove('clash');
      if (cancelled || clash || !rec.pending) { rec.spring.to(startMin); if (clash) toast('That spot is taken, so it hopped back.'); return; }
      const when = rec.pending;
      rec.pending = null;
      scratch();
      await moveBlock(rec.n.block.id, when);
      announce(`${rec.n.item.title} moved to ${T.clock(when)}`);
    },
  });
  // A tap (not the end of a drag) opens the detail card.
  g.addEventListener('click', () => { if (!rec.justDragged) openDetail(rec); });
}

function openDetail(rec) {
  const slot = root.querySelector('[data-detail]');
  if (opened) closeDetail(true);
  const n = rec.n;
  const card = document.createElement('div');
  card.className = 'detail-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', n.kind === 'routine' ? `${GROUP_LABEL[n.group]} routines` : n.item.title);
  card.innerHTML = n.kind === 'routine' ? routineDetail(n) : blockDetail(n);
  slot.appendChild(card);
  roughBorder(card, { color: n.color, width: 2, radius: 26, seed: n.id, draw: true });
  // shared-element morph from the node
  const nr = rec.g.querySelector('.node-shape').getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  if (!motion.reduced) {
    card.style.transformOrigin = '0 0';
    set(card, { x: nr.left - cr.left, y: nr.top - cr.top, scale: Math.max(0.05, nr.width / cr.width), opacity: 0.2 });
    to(card, { x: 0, y: 0, scale: 1, opacity: 1 }, { stiffness: 300, damping: 26 });
  }
  opened = { card, rec };
  card.addEventListener('click', (e) => onDetailClick(e, rec));
  const big = card.querySelector('.detail-doodle');
  if (big) big.addEventListener('click', () => react(big.firstElementChild || big, n.doodle));
  setTimeout(() => (card.querySelector('button') || card).focus({ preventScroll: true }), 50);
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDetail(); } });
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}
function outside(e) {
  if (opened && !opened.card.contains(e.target) && !e.target.closest('[data-node]')) closeDetail();
}
function closeDetail(instant) {
  if (!opened) return;
  const { card, rec } = opened;
  opened = null;
  document.removeEventListener('pointerdown', outside, true);
  if (instant || motion.reduced || !rec.g.isConnected) { card.remove(); return; }
  const nr = rec.g.querySelector('.node-shape').getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const cur = { x: 0, y: 0 };
  to(card, { x: cur.x + nr.left - cr.left, y: cur.y + nr.top - cr.top, scale: Math.max(0.05, nr.width / cr.width), opacity: 0 }, { stiffness: 340, damping: 30 }).then(() => card.remove());
  try { rec.g.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
}

function blockDetail(n) {
  const b = n.block, it = n.item;
  const s = new Date(b.start), e = new Date(b.end);
  const movable = n.kind === 'work' && b.status === 'planned' && s > T.now();
  const due = it.type === 'exam' ? T.dueText(new Date(it.start), 'Exam') : it.due ? T.dueText(new Date(it.due)) : '';
  return `
    <div class="detail-top">
      <button class="detail-doodle" type="button" aria-label="Poke the doodle">${doodleSVG(it.doodle, 52, n.color)}</button>
      <div><div class="detail-title">${esc(it.title)}</div>
      <div class="m">${T.clock(s)} – ${T.clock(e)}${due ? ' · ' + esc(due) : ''}</div></div>
    </div>
    <p class="detail-why" style="color:${n.color}">${esc(b.why)}</p>
    ${movable ? `<div class="detail-nudge" role="group" aria-label="Move this block"><button class="btn btn-ghost btn-sm" data-act="nudge" data-min="-15">−15 min</button><button class="btn btn-ghost btn-sm" data-act="nudge" data-min="15">+15 min</button></div>` : ''}
    <div class="detail-actions">
      ${b.status === 'done' ? `<button class="btn btn-ghost btn-sm" data-act="undo">Not done yet</button>` : `<button class="btn btn-sm" style="background:${n.color};color:#111" data-act="done">Done</button>`}
      ${b.status === 'planned' && n.kind === 'work' ? `<button class="btn btn-ghost btn-sm" data-act="skip">Sleep in</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="edit">Edit</button>
    </div>`;
}
function routineDetail(n) {
  return `
    <div class="detail-title">${GROUP_LABEL[n.group]} routines</div>
    <ul class="detail-list">${n.blocks.map(({ b, it }) => `
      <li><button class="detail-row ${b.status === 'done' ? 'is-done' : ''}" type="button" data-act="toggle" data-block="${b.id}" aria-pressed="${b.status === 'done'}">
        <span class="detail-row-tile" style="background:${itemHex(it)}">${doodleSVG(it.doodle, 22, '#111', { boil: false })}</span>
        <span>${esc(it.title)}</span><span class="m">${T.clock(new Date(b.start))}</span>
        <span class="detail-row-check">${b.status === 'done' ? CHECK : ''}</span></button></li>`).join('')}
    </ul>
    <div class="detail-actions"><button class="btn btn-ghost btn-sm" data-act="play" data-group="${n.group}">▶ Play</button><button class="btn btn-ghost btn-sm" data-act="routines">All routines</button></div>`;
}

async function onDetailClick(e, rec) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const n = rec.n;
  if (act === 'edit') { closeDetail(true); const { openEditor } = await import('./editor.js'); openEditor(n.item); return; }
  if (act === 'routines') { closeDetail(true); go('routines'); return; }
  if (act === 'play') { closeDetail(true); go(`guided/${btn.dataset.group}`); return; }
  if (act === 'toggle') {
    const b = S.plan.blocks.find((x) => x.id === btn.dataset.block);
    const nb = await blockAction(b.id, b.status === 'done' ? 'undo' : 'done');
    if (nb && nb.status === 'done') { pop(1.2); const r = btn.getBoundingClientRect(); burst(r.right - 20, r.top + r.height / 2, { count: 6 }); }
    if (opened) opened.card.innerHTML = routineDetail(nodes.get(n.id)?.n || n);
    return;
  }
  if (act === 'nudge') {
    const s = new Date(new Date(n.block.start).getTime() + Number(btn.dataset.min) * 60000);
    const e2 = new Date(s.getTime() + (new Date(n.block.end) - new Date(n.block.start)));
    const clash = clashAt(n.block.id, s, e2);
    if (clash || s < T.now()) { btn.classList.add('shake'); setTimeout(() => btn.classList.remove('shake'), 400); toast('No room there, so it stays put.'); return; }
    closeDetail(true);
    await moveBlock(n.block.id, s);
    announce(`${n.item.title} moved to ${T.clock(s)}`);
    return;
  }
  closeDetail(true);
  if (act === 'done') await finish(n.block, 'detail');
  if (act === 'undo') await blockAction(n.block.id, 'undo');
  if (act === 'skip') await sleepIn(n.block, 'detail');
}

// ---- focus card ------------------------------------------------------------------
function renderFocus(mode) {
  const zone = root.querySelector('[data-focus-zone]');
  const list = focusBlocks();
  const cur = list[0];
  const next = list[1];
  const key = cur ? cur.id : 'none';
  if (mode === 'none' && key === focusId) { updateTimer(); return; }
  if (key === focusId && mode !== 'enter') { updateTimer(); refreshActions(cur); return; }
  focusId = key;
  zone.innerHTML = `${next ? `<div class="focus-peek" aria-hidden="true" style="--c:${itemHex(itemById(next.itemId))}"></div>` : ''}
    ${cur ? focusCard(cur) : emptyCard()}
    <div class="focus-actions" data-actions></div>`;
  const card = zone.querySelector('[data-card]');
  const color = cur ? itemHex(itemById(cur.itemId)) : 'var(--line-2)';
  roughBorder(card, { color, width: 2, radius: 32, seed: cur ? cur.id : 'empty', draw: mode !== 'none' });
  const peek = zone.querySelector('.focus-peek');
  if (peek) { peek.style.height = `${card.offsetHeight}px`; roughBorder(peek, { color: 'var(--line)', width: 1.5, radius: 32, seed: 'peek' }); }
  if (mode === 'rise' && !motion.reduced) { set(card, { scale: 0.94, y: 14, opacity: 0.5 }); to(card, { scale: 1, y: 0, opacity: 1 }, 'bouncy'); }
  else if (mode !== 'none' && !motion.reduced) { set(card, { y: 16, opacity: 0 }); to(card, { y: 0, opacity: 1 }, 'gentle'); }
  drawOn(card.querySelector('.focus-doodle'), { delay: 200, duration: 600 });
  observeBoil(zone);
  if (cur) wireFocus(card, cur);
  else wireEmpty(card);
  refreshActions(cur);
  updateTimer();
}

function focusCard(b) {
  const it = itemById(b.itemId);
  const color = itemHex(it);
  const s = new Date(b.start), e = new Date(b.end);
  const isNow = s.getTime() <= T.nowMs();
  const mins = T.minutesBetween(s, e);
  const kind = b.kind === 'event' ? 'EVENT' : it.type === 'exam' ? 'EXAM PREP' : 'DEEP WORK';
  const eyebrow = isNow ? `NOW · ${kind}` : `NEXT · ${T.relWhen(s).toUpperCase()}`;
  const due = it.type === 'exam' ? T.dueText(new Date(it.start), 'Exam') : it.due ? T.dueText(new Date(it.due)) : '';
  const meta = [due, b.kind === 'event' ? `${T.clock(s)} – ${T.clock(e)}` : `${mins} min block`].filter(Boolean).join(' · ');
  const track = roughLine(2, 318, 5, `track-${b.id}`, { amp: 0.9 });
  return `
  <article class="focus-card" data-card tabindex="0" aria-roledescription="focus card" aria-label="${esc(it.title)}. Swipe right to finish, left to snooze, up to sleep in. Arrow keys work too." style="--c:${color}">
    <button class="focus-doodle" type="button" aria-label="Poke the doodle" tabindex="-1">${doodleSVG(it.doodle, 84, color)}</button>
    <div class="eyebrow" style="color:${color}">${esc(eyebrow)}</div>
    <div class="focus-title">${esc(it.title)}</div>
    <div class="m focus-meta">${esc(meta)}</div>
    <div class="focus-timer"><span class="focus-time" data-time>--:--</span><span class="m" data-time-label>${isNow ? 'left' : 'until'}</span></div>
    <svg class="focus-progress" viewBox="0 0 320 10" preserveAspectRatio="none" aria-hidden="true">
      <path d="${track}" class="track"/>
      <path d="${track}" class="fill" pathLength="1" stroke="${color}" data-progress/>
    </svg>
    <div class="swipe-track" data-swipe>
      <button class="swipe-knob" type="button" data-knob aria-label="Finish ${esc(it.title)}" style="background:${color}">→</button>
      <span class="m swipe-label">Swipe to finish</span>
    </div>
    <div class="swipe-hint hint-right" aria-hidden="true">Finish</div>
    <div class="swipe-hint hint-left" aria-hidden="true">Snooze</div>
    <div class="swipe-hint hint-up" aria-hidden="true">Sleep in</div>
  </article>`;
}

function emptyCard() {
  const nextAny = S.plan.blocks.filter((b) => b.status === 'planned' && new Date(b.start) > T.now() && b.kind !== 'routine').sort((a, b) => new Date(a.start) - new Date(b.start))[0];
  const it = nextAny && itemById(nextAny.itemId);
  const hasItems = S.items.some((i) => !i.deleted);
  return `
  <article class="focus-card focus-empty" data-card tabindex="0">
    <button class="focus-doodle" type="button" aria-label="Poke the doodle" tabindex="-1">${doodleSVG('mug', 84, '#A9B7C6')}</button>
    <div class="eyebrow" style="color:var(--mist)">${hasItems ? 'ALL CLEAR' : 'A BLANK PAGE'}</div>
    <div class="focus-title">${esc(hasItems ? pick('nothingNow') : pick('allClear'))}</div>
    <div class="m focus-meta">${it ? `Next up: ${esc(it.title)} · ${esc(T.relWhen(new Date(nextAny.start)))}` : 'Tap + to add an exam, a deadline or a tiny routine.'}</div>
  </article>`;
}

function refreshActions(cur) {
  const slot = root.querySelector('[data-actions]');
  if (!slot) return;
  if (!cur) { slot.innerHTML = ''; return; }
  const ts = timerState(cur);
  slot.innerHTML = `
    <button class="btn btn-ghost btn-sm" data-fa="pause" ${ts.started ? '' : 'disabled'}>${ts.paused ? '▶ Resume' : '❚❚ Pause'}</button>
    <button class="btn btn-ghost btn-sm" data-fa="snooze">Snooze 15</button>
    ${cur.kind === 'work' ? '<button class="btn btn-ghost btn-sm" data-fa="skip">Sleep in</button>' : ''}`;
  slot.onclick = async (e) => {
    const b = e.target.closest('[data-fa]');
    if (!b) return;
    if (b.dataset.fa === 'pause') { await toggleTimer(cur); refreshActions(cur); updateTimer(); }
    if (b.dataset.fa === 'snooze') snooze(cur);
    if (b.dataset.fa === 'skip') sleepIn(cur);
  };
}

function updateTimer() {
  if (!root) return;
  const card = root.querySelector('[data-card]');
  const b = S.plan.blocks.find((x) => x.id === focusId);
  if (!card || !b) return;
  const el = card.querySelector('[data-time]');
  const prog = card.querySelector('[data-progress]');
  const label = card.querySelector('[data-time-label]');
  const ts = timerState(b);
  if (!ts.started) {
    el.textContent = T.mmss(new Date(b.start).getTime() - T.nowMs());
    label.textContent = 'until it starts';
    prog.style.strokeDashoffset = '1';
  } else {
    el.textContent = T.mmss(ts.left);
    label.textContent = ts.paused ? 'left · paused' : 'left';
    prog.style.strokeDashoffset = String(Math.max(0, Math.min(1, ts.left / ts.total)).toFixed(4));
    if (ts.left <= 0 && !ts.paused) label.textContent = 'time! swipe when ready';
  }
}

function wireFocus(card, b) {
  const doodle = card.querySelector('.focus-doodle');
  const it = itemById(b.itemId);
  doodle.addEventListener('click', (e) => { e.stopPropagation(); react(doodle.firstElementChild, it.doodle); pop(0.8); });
  squishy(doodle);
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); finish(b, 'key'); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); snooze(b); }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (b.kind === 'work') sleepIn(b); }
  });
  // whole-card swipe with rotation + tilt
  const hints = { right: card.querySelector('.hint-right'), left: card.querySelector('.hint-left'), up: card.querySelector('.hint-up') };
  drag(card, {
    ignore: '[data-knob], .focus-doodle',
    threshold: 8,
    onMove: ({ dx, dy }) => {
      if (busy) return;
      const up = dy < 0 && Math.abs(dy) > Math.abs(dx);
      set(card, { x: up ? dx * 0.2 : dx, y: up ? dy : dy * 0.15, rotate: up ? 0 : dx / 22, ry: up ? 0 : dx / 40, rx: up ? -dy / 40 : 0 });
      const w = card.offsetWidth, h = card.offsetHeight;
      hints.right.style.opacity = String(Math.max(0, Math.min(1, dx / (w * 0.4))));
      hints.left.style.opacity = String(Math.max(0, Math.min(1, -dx / (w * 0.4))));
      hints.up.style.opacity = b.kind === 'work' && up ? String(Math.max(0, Math.min(1, -dy / (h * 0.4)))) : '0';
    },
    onEnd: ({ dx, dy, vx, vy, cancelled }) => {
      Object.values(hints).forEach((x) => { x.style.opacity = '0'; });
      if (busy) return;
      const w = card.offsetWidth, h = card.offsetHeight;
      const up = dy < 0 && Math.abs(dy) > Math.abs(dx);
      if (!cancelled && !up && (dx > w * 0.4 || (vx > 900 && dx > 40))) return finish(b, 'swipe', { vx });
      if (!cancelled && !up && (dx < -w * 0.4 || (vx < -900 && dx < -40))) return snooze(b, { vx });
      if (!cancelled && up && b.kind === 'work' && (dy < -h * 0.4 || (vy < -900 && dy < -40))) return sleepIn(b, 'swipe', { vy });
      to(card, { x: 0, y: 0, rotate: 0, rx: 0, ry: 0 }, { stiffness: 320, damping: 22, velocity: { x: vx, y: vy } });
    },
  });
  // swipe pill knob
  const track = card.querySelector('[data-swipe]');
  const knob = card.querySelector('[data-knob]');
  const label = card.querySelector('.swipe-label');
  knob.addEventListener('click', (e) => { if (e.detail === 0) finish(b, 'key'); });
  let maxX = 0;
  drag(knob, {
    axis: 'x', threshold: 4,
    onStart: () => { maxX = track.offsetWidth - knob.offsetWidth - 6; },
    onMove: ({ dx }) => { const x = Math.max(0, Math.min(maxX, dx)); set(knob, { x }); label.style.opacity = String(1 - x / maxX); },
    onEnd: ({ dx, vx, cancelled }) => {
      label.style.opacity = '';
      if (!cancelled && (dx > maxX * 0.8 || (vx > 800 && dx > maxX * 0.4))) { to(knob, { x: maxX }, 'snappy'); finish(b, 'knob'); }
      else to(knob, { x: 0 }, { stiffness: 400, damping: 24, velocity: { x: vx } });
    },
    onRelease: () => {},
  });
}

function wireEmpty(card) {
  const doodle = card.querySelector('.focus-doodle');
  doodle.addEventListener('click', () => { react(doodle.firstElementChild, 'mug'); pop(0.7); });
}

async function finish(b, how, { vx = 0 } = {}) {
  if (busy) return;
  busy = true;
  const card = root.querySelector('[data-card]');
  const it = itemById(b.itemId);
  try {
    if (card && !motion.reduced) {
      const st = stamp(card, { color: '#7CBB93', label: 'Done', seed: b.id });
      const d = card.querySelector('.focus-doodle svg');
      if (d) { set(d, { rotate: 8 }); to(d, { rotate: 0 }, { stiffness: 320, damping: 6 }); }
      const r = card.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height * 0.45, { count: 12, seed: b.id, doodles: ['sparkle', it.doodle] });
      pop(1); setTimeout(chime, 120); buzz(12);
      await wait(520);
      await to(card, { x: card.offsetWidth * 1.3, rotate: 16, opacity: 0 }, { stiffness: 160, damping: 20, velocity: { x: Math.max(vx, 400) } });
      st.remove();
    }
    await blockAction(b.id, 'done');
    announce(`${it.title} finished. ${pick('finished', b.id)}`);
  } finally { busy = false; emitRise(); }
}

async function snooze(b, { vx = 0 } = {}) {
  if (busy) return;
  busy = true;
  const card = root.querySelector('[data-card]');
  try {
    const r = card.getBoundingClientRect();
    floatDoodle('clock', r.left + r.width / 2, r.top + r.height / 2, { color: '#A9B7C6', dir: 'spin', size: 80 });
    scratch();
    if (!motion.reduced) await to(card, { x: -card.offsetWidth * 1.2, rotate: -12, opacity: 0 }, { stiffness: 160, damping: 20, velocity: { x: Math.min(vx, -400) } });
    try {
      await blockAction(b.id, 'snooze');
      toast(pick('snoozed', b.id));
    } catch (e) {
      toast(e.message || 'No room later today.');
    }
  } finally { busy = false; emitRise(); }
}

async function sleepIn(b, how, { vy = 0 } = {}) {
  if (busy) return;
  busy = true;
  const card = root.querySelector('[data-card]');
  const it = itemById(b.itemId);
  try {
    const r = card ? card.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    floatDoodle('moon', r.left + r.width / 2, r.top + r.height / 3, { color: '#F7C8D3', dir: 'up', size: 80 });
    if (card && !motion.reduced && how !== 'detail') await to(card, { y: -card.offsetHeight * 1.1, opacity: 0, scale: 0.9 }, { stiffness: 160, damping: 20, velocity: { y: Math.min(vy, -400) } });
    await blockAction(b.id, 'skip');
    toast(`${it.title}: ${pick('sleepingIn', b.id).toLowerCase()}`, { action: { label: 'Wake it', fn: () => blockAction(b.id, 'undo') } });
  } finally { busy = false; emitRise(); }
}

function emitRise() {
  focusId = null;
  if (root) renderFocus('rise');
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- shelf + tuck in ---------------------------------------------------------------
function renderShelf() {
  const slot = root.querySelector('[data-shelf]');
  // everything currently sleeping in: any work block, plus today's routines
  const today = T.dayKey();
  const sleeping = S.plan.blocks.filter((b) => b.status === 'skipped' && (b.kind === 'work' || (b.kind === 'routine' && T.dayKey(new Date(b.start)) === today)))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  if (!sleeping.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="shelf"><div class="shelf-head"><span class="eyebrow" style="color:var(--blush)">Sleeping in</span><span class="m">${esc(pick('sleepingIn'))}</span></div>
    <div class="shelf-row">${sleeping.map((b) => {
      const it = itemById(b.itemId);
      return `<button class="shelf-chip" type="button" data-wake="${b.id}" style="transform:rotate(${tilt(b.id)}deg)">${doodleSVG(it.doodle, 22, itemHex(it), { boil: false })}<span>${esc(it.title)}</span><span class="m">wake</span></button>`;
    }).join('')}</div></div>`;
  slot.onclick = async (e) => {
    const c = e.target.closest('[data-wake]');
    if (!c) return;
    await blockAction(c.dataset.wake, 'undo');
    toast('Awake again.');
  };
}

function renderTuck() {
  const slot = root.querySelector('[data-tuck]');
  const show = T.minOfDay() >= S.profile.sleepMin - 90 && S.items.some((i) => !i.deleted);
  if (!show) { slot.innerHTML = ''; return; }
  if (slot.firstElementChild) return;
  slot.innerHTML = `<button class="pill pill-tuck" type="button">${doodleSVG('moon', 22, '#F7C8D3', { boil: false })}<span>Tuck in</span></button>`;
  const b = slot.firstElementChild;
  roughBorder(b, { color: 'var(--blush)', width: 1.5, radius: 22, seed: 'tuck', draw: true });
  squishy(b);
  b.addEventListener('click', async () => { const { openTuckIn } = await import('../postcard.js'); openTuckIn(T.dayKey(), b); });
}

// ---- ticks ---------------------------------------------------------------------------
function startTicks() {
  clearInterval(tick); clearInterval(minuteTick);
  tick = setInterval(() => { if (!document.hidden) updateTimer(); }, 1000);
  minuteTick = setInterval(() => {
    if (document.hidden || !root) return;
    const before = S.drifted;
    checkDrift();
    if (before !== S.drifted) renderDrift();
    root.querySelector('[data-date]').textContent = T.longDate();
    renderArc(false);
    renderFocus('soft');
    renderTuck();
  }, 60000);
}
