// Horizon: 14 or 21 days of capsules (height = scheduled minutes / goal).
import { S, itemById, previewReplan, injectProposal } from '../state.js';
import * as T from '../time.js';
import { doodleInSVG, doodleSVG } from '../doodle.js';
import { Spring, set, to, drawOn, motion, observeBoil, forgetBoil, hop } from '../anim.js';
import { roughBorder } from '../rough.js';
import { esc, typeHex, announce, toast } from '../dom.js';
import { pick } from '../copy.js';
import { go } from '../router.js';
import { markSVG } from '../mark.js';

const VB = { w: 358, h: 310, base: 270, goalY: 160 };
let root = null;
let days = 14;
let caps = []; // { key, rect, label, flag, spring }
let preview = null; // { plan, proposal }

export function mount(el, _p, { compact = false } = {}) {
  root = el;
  days = S.meta.horizonDays === 21 ? 21 : 14;
  preview = null;
  render(true, compact);
  return { update: () => { preview = null; render(false, compact); }, unmount: () => { forgetBoil(el); root = null; } };
}

function workByDay(plan) {
  const m = new Map();
  for (const b of plan.blocks) {
    if (b.kind !== 'work' || b.status === 'skipped' || b.status === 'moved') continue;
    const k = T.dayKey(new Date(b.start));
    m.set(k, (m.get(k) || 0) + T.minutesBetween(b.start, b.end));
  }
  return m;
}
function goalFor(k) { const o = S.profile.dayOverrides || {}; return o[k] ?? S.profile.ambitionMin; }

function deadlines(keys) {
  const out = [];
  for (const it of S.items) {
    if (it.deleted || it.done || !['exam', 'assignment', 'project'].includes(it.type)) continue;
    const d = it.type === 'exam' ? it.start : it.due;
    if (!d) continue;
    const k = T.dayKey(new Date(d));
    const i = keys.indexOf(k);
    if (i >= 0) out.push({ it, i });
  }
  return out.sort((a, b) => a.i - b.i);
}

function heaviest(keys, mins) {
  let best = null;
  let run = [];
  const flush = () => {
    if (run.length >= 2 || (run.length === 1 && !best)) {
      const tot = run.reduce((a, k) => a + mins.get(k), 0);
      if (!best || tot > best.tot) best = { keys: [...run], tot, avg: tot / run.length };
    }
    run = [];
  };
  for (const k of keys) {
    if ((mins.get(k) || 0) > goalFor(k)) run.push(k); else flush();
  }
  flush();
  return best;
}

function geometry(n) {
  const step = n === 14 ? 26 : 17;
  const w = n === 14 ? 18 : 12;
  return { step, w, x0: (VB.w - (step * (n - 1) + w)) / 2 };
}
function capHeight(min) {
  const h = (min / S.profile.ambitionMin) * (VB.base - VB.goalY);
  return Math.max(min > 0 ? 18 : 10, Math.min(VB.base - 28, h));
}

function render(first, compact) {
  if (!root) return;
  const today = T.dayKey();
  const keys = Array.from({ length: days }, (_, i) => T.addDays(today, i));
  const mins = workByDay(S.plan);
  const hasWork = S.items.some((i) => !i.deleted && ['exam', 'assignment', 'project'].includes(i.type));
  const g = geometry(days);
  const flags = deadlines(keys);
  const heavy = heaviest(keys, mins);
  root.innerHTML = `
    ${compact ? '' : `<header class="hdr"><div><div class="m">Next ${days === 14 ? '2' : '3'} weeks</div><h1 class="h">Horizon</h1></div><a class="mark-btn" href="#/settings" aria-label="Settings">${markSVG()}</a></header>`}
    <div class="m" style="margin-top:6px;line-height:1.4">Taller capsule, busier day. Peach means past your daily goal.</div>
    <div class="seg range-toggle" role="group" aria-label="Range"><button type="button" data-range="14" aria-pressed="${days === 14}">2 weeks</button><button type="button" data-range="21" aria-pressed="${days === 21}">3 weeks</button></div>
    <div class="horizon-wrap" data-wrap>
      <svg class="horizon-chart" data-chart viewBox="0 0 ${VB.w} ${VB.h}" role="img" aria-label="Workload per day for ${days} days with deadlines marked">
        <line x1="0" y1="${VB.goalY}" x2="${VB.w}" y2="${VB.goalY}" stroke="var(--text)" stroke-opacity=".5" stroke-dasharray="4 5"/>
        <text x="2" y="${VB.goalY - 8}" class="cap-label" fill="var(--muted)">goal ${esc(T.hours(S.profile.ambitionMin))}</text>
        ${keys.map((k, i) => {
          const m = mins.get(k) || 0;
          const h = capHeight(m);
          const x = g.x0 + i * g.step;
          const fill = m > goalFor(k) * S.profile.overloadFactor ? 'var(--rosewood)' : m > goalFor(k) ? 'var(--navajo)' : 'var(--ice)';
          return `<g data-day="${k}"><rect class="capsule" data-cap="${i}" x="${x}" y="${VB.base - h}" width="${g.w}" height="${h}" rx="${g.w / 2}" fill="${fill}" opacity="${m ? 1 : 0.35}"/>
            <text class="cap-label" x="${x + g.w / 2}" y="292" text-anchor="middle" fill="${k === today ? 'var(--vanilla)' : 'var(--muted)'}">${T.weekdayLetter(T.weekdayOf(k))}</text></g>`;
        }).join('')}
        ${flagsSVG(flags, keys, mins, g)}
      </svg>
      <div class="horizon-tip" data-tip hidden></div>
    </div>
    ${!hasWork ? `<div class="empty">${doodleSVG('sun', 72, '#FDDEB2')}<p>${esc(pick('emptyHorizon'))}</p></div>` : insightHTML(heavy)}`;
  caps = [...root.querySelectorAll('[data-cap]')].map((rect) => ({ rect, i: Number(rect.dataset.cap), key: keys[Number(rect.dataset.cap)] }));
  const ins = root.querySelector('[data-insight]');
  if (ins) roughBorder(ins, { color: 'var(--line-2)', width: 1.5, radius: 28, seed: 'insight', draw: first });
  const pb = root.querySelector('[data-preview]');
  if (pb) roughBorder(pb, { color: 'var(--navajo)', width: 1.5, radius: 22, seed: 'pv' });
  // capsules rise with a staggered spring
  if (!motion.reduced) {
    caps.forEach(({ rect }, i) => {
      set(rect, { scale: 1 });
      rect.style.transform = 'scaleY(0)';
      const sp = new Spring(0, { stiffness: 210, damping: 15, onUpdate: (v) => { rect.style.transform = `scaleY(${Math.max(0, v).toFixed(3)})`; } });
      setTimeout(() => sp.to(1), (first ? 120 : 20) + i * (first ? 35 : 15));
    });
    root.querySelectorAll('[data-flag]').forEach((f, i) => { set(f, { opacity: 0, y: -10 }); setTimeout(() => to(f, { opacity: 1, y: 0 }, 'bouncy'), 400 + i * 120); });
  }
  observeBoil(root);
  wire(keys, mins);
}

function flagsSVG(flags, keys, mins, g) {
  let lastI = -10, lift = 0;
  return flags.map(({ it, i }) => {
    const x = g.x0 + i * g.step + g.w / 2;
    const top = VB.base - capHeight(mins.get(keys[i]) || 0);
    lift = i - lastI < 3 ? (lift ? 0 : 1) : 0;
    lastI = i;
    const y = Math.max(26, top - 44 - lift * 40);
    const anchor = x > VB.w - 40 ? 'end' : x < 40 ? 'start' : 'middle';
    const tx = anchor === 'end' ? VB.w - 2 : anchor === 'start' ? 2 : x;
    const name = it.title.length > 12 ? it.title.split(' ')[0] : it.title;
    return `<g class="flag" data-flag="${i}"><text x="${tx}" y="${y - 6}" text-anchor="${anchor}" class="cap-label" fill="var(--text)" font-weight="500">${esc(name)}</text>
      ${doodleInSVG(it.doodle, Math.min(VB.w - 26, Math.max(0, x - 13)), y, 26, typeHex(it.type))}</g>`;
  }).join('');
}

function insightHTML(heavy) {
  if (!heavy) {
    return `<div class="insight" data-insight><div class="insight-doodle">${doodleSVG('sun', 44, '#7CBB93')}</div>
      <div class="eyebrow" style="color:var(--teal)">SMOOTH SAILING</div><div class="insight-title">No day over your goal</div>
      <div class="m insight-text">Everything fits inside your ${esc(T.hours(S.profile.ambitionMin))} a day. Nice and even.</div></div>`;
  }
  const a = heavy.keys[0], b = heavy.keys[heavy.keys.length - 1];
  const range = a === b ? T.shortDateKey(a) : `${T.shortDateKey(a).replace(/ \w+$/, '')} – ${T.shortDateKey(b)}`;
  // the biggest contributor in the stretch
  const by = new Map();
  for (const bl of S.plan.blocks) {
    if (bl.kind !== 'work' || bl.status !== 'planned') continue;
    const k = T.dayKey(new Date(bl.start));
    if (heavy.keys.includes(k)) by.set(bl.itemId, (by.get(bl.itemId) || 0) + T.minutesBetween(bl.start, bl.end));
  }
  const top = [...by.entries()].sort((x, y) => y[1] - x[1])[0];
  const it = top && itemById(top[0]);
  return `<div class="insight" data-insight><div class="insight-doodle">${doodleSVG('sun', 44, '#FDDEB2')}</div>
    <div class="eyebrow" style="color:var(--navajo)">HEAVIEST STRETCH</div>
    <div class="insight-title">${esc(range)}</div>
    <div class="m insight-text" data-insight-text>About ${esc(T.hours(heavy.avg))} a day against your ${esc(T.hours(S.profile.ambitionMin))} goal.${it ? ` Starting ${esc(it.title.split(' ')[0])} prep earlier would flatten it.` : ''}</div>
    <div class="row" style="margin-top:8px;flex-wrap:wrap" data-preview-row>
      <button class="pill" type="button" data-preview style="color:var(--navajo);flex:none">Preview the earlier start</button>
    </div></div>`;
}

function wire(keys, mins) {
  root.onclick = (e) => {
    const r = e.target.closest('[data-range]');
    if (r) { morphTo(Number(r.dataset.range)); return; }
    if (e.target.closest('[data-preview]')) return startPreview(keys);
    if (e.target.closest('[data-use]')) { injectProposal(preview.proposal); go('review'); return; }
    if (e.target.closest('[data-cancel]')) return endPreview(keys, mins);
  };
  // fisheye scrub
  const svg = root.querySelector('[data-chart]');
  const tip = root.querySelector('[data-tip]');
  const wrap = root.querySelector('[data-wrap]');
  const scrub = (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const g = geometry(days);
    const f = (loc.x - g.x0 - g.w / 2) / g.step;
    const near = Math.max(0, Math.min(days - 1, Math.round(f)));
    caps.forEach(({ rect, i }) => {
      const d = Math.abs(i - f);
      const s = 1 + 0.45 * Math.exp(-(d * d) / 1.2);
      rect.style.transform = `scale(${s.toFixed(3)}, ${(1 + (s - 1) * 0.25).toFixed(3)})`;
    });
    if (near !== scrub.last) {
      scrub.last = near;
      const fl = root.querySelector(`[data-flag="${near}"]`);
      if (fl) hop(fl);
    }
    const k = keys[near];
    const m = (preview ? workByDay(preview.plan) : mins).get(k) || 0;
    const cap = caps[near].rect.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    tip.hidden = false;
    tip.textContent = `${T.shortDateKey(k)} · ${m ? T.hours(m) : 'free'}`;
    tip.style.left = `${cap.left - wr.left + cap.width / 2}px`;
    tip.style.top = `${cap.top - wr.top - 8}px`;
  };
  const end = () => {
    scrub.last = -1;
    tip.hidden = true;
    caps.forEach(({ rect }) => { rect.style.transform = ''; });
  };
  svg.addEventListener('pointermove', scrub);
  svg.addEventListener('pointerdown', scrub);
  svg.addEventListener('pointerleave', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') end(); });
}

function morphTo(n) {
  if (n === days) return;
  const old = new Map(caps.map(({ rect, key }) => [key, rect.getBoundingClientRect()]));
  days = n;
  import('../state.js').then((m) => m.setMeta('horizonDays', n));
  render(false);
  if (motion.reduced) return;
  // morph shared days from their old spot (translate) as they rise
  caps.forEach(({ rect, key }) => {
    const o = old.get(key);
    if (!o) return;
    const nr = rect.getBoundingClientRect();
    const g = rect.parentNode;
    set(g, { x: o.left - nr.left });
    to(g, { x: 0 }, 'default');
  });
}

async function startPreview(keys) {
  // hypothetical: every deadline item may start today (clear StartBy) and re-spread
  const hypo = S.items.filter((i) => !i.deleted).map((i) => (['exam', 'assignment', 'project'].includes(i.type) ? { ...i, startBy: '' } : i));
  let res;
  try { res = previewReplan(hypo); } catch (e) { toast('Could not build a preview right now.'); return; }
  const moved = res.changes.filter((c) => c.kind !== 'atRisk' && c.kind !== 'watch');
  if (!moved.length) { toast('Already as flat as it gets. Nice.'); return; }
  preview = { plan: res.proposed, proposal: res };
  const mins = workByDay(res.proposed);
  // capsules flatten in place
  const g = geometry(days);
  caps.forEach(({ rect, key }) => {
    const m = mins.get(key) || 0;
    const h = capHeight(m);
    const cur = Number(rect.getAttribute('height'));
    rect.setAttribute('y', String(VB.base - h));
    rect.setAttribute('height', String(h));
    rect.setAttribute('fill', m > goalFor(key) ? 'var(--navajo)' : 'var(--ice)');
    if (!motion.reduced) {
      const sp = new Spring(cur / h, { stiffness: 150, damping: 14, onUpdate: (v) => { rect.style.transform = `scaleY(${v.toFixed(3)})`; } });
      sp.to(1);
    }
  });
  const heavy = heaviest(keys, mins);
  const txt = root.querySelector('[data-insight-text]');
  if (txt) txt.textContent = heavy ? `With the earlier start: about ${T.hours(heavy.avg)} a day at the busiest. ${moved.length} block${moved.length > 1 ? 's' : ''} would move.` : `With the earlier start, no day goes over your goal. ${moved.length} block${moved.length > 1 ? 's' : ''} would move.`;
  const row = root.querySelector('[data-preview-row]');
  row.innerHTML = `<button class="btn btn-sm" data-use style="background:var(--navajo)">Review these changes</button><button class="btn btn-ghost btn-sm" data-cancel>Never mind</button>`;
  announce('Previewing the earlier start. Nothing has changed yet.');
}
function endPreview() { preview = null; render(false); }
