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
let caps = [];
let preview = null; // { plan, proposal }
let highlightedItem = null;
let compactMode = false;
const ITEM_COLORS = ['#FF84A2', '#B3D7F2', '#A9B7C6', '#F0EFEF', '#FFF7E6', '#FDDEB2', '#F7C8D3', '#7CBB93'];

export function mount(el, _p, { compact = false } = {}) {
  root = el;
  compactMode = compact;
  days = S.meta.horizonDays === 21 ? 21 : 14;
  preview = null;
  render(true, compact);
  return { update: () => { preview = null; render(false, compact); }, unmount: () => { forgetBoil(el); root = null; } };
}

function workByDay(plan) {
  const m = new Map();
  for (const b of plan.blocks) {
    if (b.kind !== 'work' || b.status === 'skipped' || b.status === 'moved') continue;
    const k = T.scheduleDayKey(new Date(b.start), S.profile.wakeMin);
    m.set(k, (m.get(k) || 0) + T.minutesBetween(b.start, b.end));
  }
  return m;
}
function workItemsByDay(plan) {
  const daysByItem = new Map();
  for (const b of plan.blocks) {
    if (b.kind !== 'work' || b.status === 'skipped' || b.status === 'moved') continue;
    const key = T.scheduleDayKey(new Date(b.start), S.profile.wakeMin);
    if (!daysByItem.has(key)) daysByItem.set(key, new Map());
    const items = daysByItem.get(key);
    items.set(b.itemId, (items.get(b.itemId) || 0) + T.minutesBetween(b.start, b.end));
  }
  return daysByItem;
}
function itemColor(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ITEM_COLORS[hash % ITEM_COLORS.length];
}
function hoursLabel(min) { return `${(Math.round((min / 60) * 10) / 10).toFixed(1)} h`; }
function ellipsis(text, max = 14) { return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
function goalFor(k) { const o = S.profile.dayOverrides || {}; return o[k] ?? S.profile.ambitionMin; }

function deadlines(keys) {
  const out = [];
  for (const it of S.items) {
    if (it.deleted || it.done || !['exam', 'assignment', 'project'].includes(it.type)) continue;
    const d = it.type === 'exam' ? it.start : it.due;
    if (!d) continue;
    const k = T.scheduleDayKey(new Date(d), S.profile.wakeMin);
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
  const today = T.scheduleDayKey(T.now(), S.profile.wakeMin);
  const keys = Array.from({ length: days }, (_, i) => T.addDays(today, i));
  const activePlan = preview ? preview.plan : S.plan;
  const mins = workByDay(activePlan);
  const byItem = workItemsByDay(activePlan);
  const hasWork = S.items.some((i) => !i.deleted && ['exam', 'assignment', 'project'].includes(i.type));
  const g = geometry(days);
  const flags = deadlines(keys);
  const heavy = heaviest(keys, mins);
  const itemIds = [...new Set([...byItem.values()].flatMap((m) => [...m.keys()]))].sort();
  highlightedItem = null;
  root.innerHTML = `
    ${compact ? '' : `<header class="hdr"><div><div class="m">Next ${days === 14 ? '2' : '3'} weeks</div><h1 class="h">Horizon</h1></div><a class="mark-btn" href="#/settings" aria-label="Settings">${markSVG()}</a></header>`}
    <div class="m" style="margin-top:6px;line-height:1.4">Taller capsule, busier day. Peach means past your daily goal.</div>
    <div class="seg range-toggle" role="group" aria-label="Range"><button type="button" data-range="14" aria-pressed="${days === 14}">2 weeks</button><button type="button" data-range="21" aria-pressed="${days === 21}">3 weeks</button></div>
    <div class="horizon-wrap" data-wrap>
      <svg class="horizon-chart" data-chart viewBox="0 0 ${VB.w} ${VB.h}" role="img" aria-label="Workload per day for ${days} days with deadlines marked">
        <line x1="0" y1="${VB.goalY}" x2="${VB.w}" y2="${VB.goalY}" stroke="var(--text)" stroke-opacity=".5" stroke-dasharray="4 5"/>
        <text x="2" y="${VB.goalY - 8}" class="cap-label" fill="var(--muted)">goal ${esc(T.hours(S.profile.ambitionMin))}</text>
        ${keys.map((k, i) => capsuleHTML(k, i, g, byItem.get(k) || new Map(), itemIds, today)).join('')}
        ${flagsSVG(flags, keys, mins, g)}
      </svg>
      <div class="horizon-tip" data-tip hidden></div>
    </div>
    ${itemIds.length ? `<div class="horizon-legend" aria-label="Items in the chart">${itemIds.map((id) => {
      const it = itemById(id);
      return `<button type="button" class="horizon-key" data-highlight-item="${esc(id)}" aria-pressed="false"><span style="background:${itemColor(id)}"></span>${esc(it ? it.title : 'Removed item')}</button>`;
    }).join('')}</div>` : ''}
    ${!hasWork ? `<div class="empty">${doodleSVG('sun', 72, '#FDDEB2')}<p>${esc(pick('emptyHorizon'))}</p></div>` : insightHTML(heavy)}`;
  caps = [...root.querySelectorAll('[data-cap]')].map((group) => ({ rect: group, i: Number(group.dataset.cap), key: keys[Number(group.dataset.cap)] }));
  const ins = root.querySelector('[data-insight]');
  if (ins) roughBorder(ins, { color: 'var(--line-2)', width: 1.5, radius: 28, seed: 'insight', draw: first });
  const pb = root.querySelector('[data-preview]');
  if (pb) roughBorder(pb, { color: 'var(--navajo)', width: 1.5, radius: 22, seed: 'pv' });
  // capsules rise with a staggered spring
  if (!motion.reduced) {
    caps.forEach(({ rect }, i) => {
      set(rect, { scale: 1 });
      rect.style.transform = 'scale(1, 0)';
      const sp = new Spring(0, { stiffness: 210, damping: 15, onUpdate: (v) => { rect.style.transform = `scale(1, ${Math.max(0, v).toFixed(3)})`; } });
      setTimeout(() => sp.to(1), (first ? 120 : 20) + i * (first ? 35 : 15));
    });
    root.querySelectorAll('[data-flag]').forEach((f, i) => { set(f, { opacity: 0, y: -10 }); setTimeout(() => to(f, { opacity: 1, y: 0 }, 'bouncy'), 400 + i * 120); });
  }
  observeBoil(root);
  wire(keys, mins, byItem, itemIds);
}

function capsuleHTML(key, i, g, items, itemIds, today) {
  const total = [...items.values()].reduce((sum, value) => sum + value, 0);
  const h = capHeight(total);
  const x = g.x0 + i * g.step;
  const y = VB.base - h;
  const fill = total > goalFor(key) * S.profile.overloadFactor ? 'var(--rosewood)' : total > goalFor(key) ? 'var(--navajo)' : 'var(--ice)';
  let offset = 0;
  const segments = [...items.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, value]) => {
    const segmentHeight = h * value / Math.max(1, total);
    const sy = VB.base - offset - segmentHeight;
    offset += segmentHeight;
    return `<rect class="cap-segment" data-segment-item="${esc(id)}" x="${x}" y="${sy}" width="${g.w}" height="${segmentHeight + 0.5}" fill="${itemColor(id)}"/>`;
  }).join('');
  return `<g class="cap-group" data-cap="${i}" data-day="${key}" tabindex="0" role="button" aria-label="${esc(T.shortDateKey(key))}: ${hoursLabel(total)} total">
    <defs><clipPath id="cap-${key}"><rect x="${x}" y="${y}" width="${g.w}" height="${h}" rx="${g.w / 2}"/></clipPath></defs>
    <rect class="capsule" data-base x="${x}" y="${y}" width="${g.w}" height="${h}" rx="${g.w / 2}" fill="${fill}" opacity="${total ? 1 : 0.35}"/>
    <g clip-path="url(#cap-${key})">${segments}</g>
    <rect class="cap-hit" x="${x + g.w / 2 - 22}" y="${VB.base - 44}" width="44" height="44" rx="22" fill="transparent"/>
    <text class="cap-label" x="${x + g.w / 2}" y="292" text-anchor="middle" fill="${key === today ? 'var(--vanilla)' : 'var(--muted)'}">${T.weekdayLetter(T.weekdayOf(key))}</text>
  </g>`;
}

function flagsSVG(flags, keys, mins, g) {
  const placed = [];
  const ordered = [...flags].sort((a, b) => a.i - b.i || String(a.it.start || a.it.due).localeCompare(String(b.it.start || b.it.due)));
  return ordered.map(({ it, i }) => {
    const baseX = g.x0 + i * g.step + g.w / 2;
    const top = VB.base - capHeight(mins.get(keys[i]) || 0);
    const iconY = Math.max(76, top - 28);
    const labelWidth = Math.min(104, Math.max(40, it.title.length * 5.5));
    let position = null;
    for (let lane = 0; lane < 5 && !position; lane++) {
      const y = Math.max(24, iconY - 24 - (lane % 3) * 22);
      for (const dx of [0, -16, 16, -32, 32]) {
        const x = Math.max(4 + labelWidth / 2, Math.min(VB.w - 4 - labelWidth / 2, baseX + dx));
        const box = [x - labelWidth / 2, y - 14, x + labelWidth / 2, y + 2];
        if (placed.every((other) => box[2] + 3 < other[0] || box[0] > other[2] + 3 || box[3] + 2 < other[1] || box[1] > other[3] + 2)) {
          position = { x, y, box };
          placed.push(box);
          break;
        }
      }
    }
    const visible = !!position;
    const x = position ? position.x : Math.max(13, Math.min(VB.w - 13, baseX));
    const y = position ? position.y + 22 : iconY;
    const label = visible ? ellipsis(it.title, Math.max(6, Math.floor(labelWidth / 5.5))) : '';
    return `<g class="flag${visible ? '' : ' flag-hidden-label'}" data-flag="${i}" data-item-select="${esc(it.id)}" tabindex="0" role="button" aria-label="${esc(it.title)} deadline on ${esc(keys[i])}">
      ${visible ? `<text x="${x}" y="${position.y}" text-anchor="middle" class="cap-label" fill="var(--text)" font-weight="500">${esc(label)}</text>` : ''}
      <circle cx="${x}" cy="${y + 11}" r="22" fill="transparent"/>
      ${doodleInSVG(it.doodle, x - 11, y, 22, typeHex(it.type))}</g>`;
  }).join('');
}

function insightHTML(heavy) {
  if (!heavy) {
    return `<div class="insight" data-insight><div class="insight-copy"><div class="eyebrow" style="color:var(--teal)">SMOOTH SAILING</div><div class="insight-title">No day over your goal</div>
      <div class="m insight-text">Everything fits inside your ${esc(T.hours(S.profile.ambitionMin))} a day. Nice and even.</div></div><div class="insight-doodle">${doodleSVG('sun', 44, '#7CBB93')}</div></div>`;
  }
  const a = heavy.keys[0], b = heavy.keys[heavy.keys.length - 1];
  const range = a === b ? T.shortDateKey(a) : `${T.shortDateKey(a).replace(/ \w+$/, '')} – ${T.shortDateKey(b)}`;
  // the biggest contributor in the stretch
  const by = new Map();
  for (const bl of S.plan.blocks) {
    if (bl.kind !== 'work' || bl.status !== 'planned') continue;
    const k = T.scheduleDayKey(new Date(bl.start), S.profile.wakeMin);
    if (heavy.keys.includes(k)) by.set(bl.itemId, (by.get(bl.itemId) || 0) + T.minutesBetween(bl.start, bl.end));
  }
  const top = [...by.entries()].sort((x, y) => y[1] - x[1])[0];
  const it = top && itemById(top[0]);
  return `<div class="insight" data-insight><div class="insight-copy">
    <div class="eyebrow" style="color:var(--navajo)">HEAVIEST STRETCH</div>
    <div class="insight-title">${esc(range)}</div>
    <div class="m insight-text" data-insight-text>About ${esc(T.hours(heavy.avg))} a day against your ${esc(T.hours(S.profile.ambitionMin))} goal.${it ? ` Starting ${esc(it.title.split(' ')[0])} prep earlier would flatten it.` : ''}</div>
    <div class="row" style="margin-top:8px;flex-wrap:wrap" data-preview-row>
      <button class="pill" type="button" data-preview style="color:var(--navajo);flex:none">Preview the earlier start</button>
    </div></div><div class="insight-doodle">${doodleSVG('sun', 44, '#FDDEB2')}</div></div>`;
}

function wire(keys, mins, byItem, itemIds) {
  let tipTimer = 0;
  root.onclick = (e) => {
    const selected = e.target.closest('[data-highlight-item], [data-item-select]');
    if (selected) {
      const id = selected.dataset.highlightItem || selected.dataset.itemSelect;
      highlightedItem = highlightedItem === id ? null : id;
      root.querySelectorAll('[data-highlight-item]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.highlightItem === highlightedItem)));
      root.querySelectorAll('[data-segment-item]').forEach((segment) => {
        segment.style.opacity = !highlightedItem || segment.dataset.segmentItem === highlightedItem ? '1' : '0.16';
      });
      return;
    }
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
    clearTimeout(tipTimer);
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
    const activePlan = preview ? preview.plan : S.plan;
    const activeMins = workByDay(activePlan);
    const activeItems = workItemsByDay(activePlan);
    const parts = [...(activeItems.get(k) || new Map()).entries()]
      .map(([id, value]) => `${itemById(id) ? itemById(id).title : 'Removed item'} ${hoursLabel(value)}`);
    const total = activeMins.get(k) || 0;
    const deadlineNames = deadlines(keys).filter((entry) => entry.i === near).map((entry) => entry.it.title);
    const cap = caps[near].rect.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    tip.hidden = false;
    tip.textContent = `${T.shortDateKey(k)} · ${parts.length ? parts.join(', ') : 'free'} · Total ${hoursLabel(total)}${deadlineNames.length ? ` · Deadlines: ${deadlineNames.join(', ')}` : ''}`;
    const half = Math.min(130, Math.max(12, wr.width / 2 - 8));
    tip.style.left = `${Math.max(half, Math.min(wr.width - half, cap.left - wr.left + cap.width / 2))}px`;
    tip.style.top = `${Math.max(90, cap.top - wr.top - 8)}px`;
  };
  const end = (keepTip = false) => {
    scrub.last = -1;
    caps.forEach(({ rect }) => { rect.style.transform = ''; });
    if (keepTip) {
      tipTimer = setTimeout(() => { tip.hidden = true; }, 3500);
    } else tip.hidden = true;
  };
  svg.addEventListener('pointermove', scrub);
  svg.addEventListener('pointerdown', scrub);
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cap = e.target.closest('[data-cap]');
    if (!cap) return;
    e.preventDefault();
    const rect = cap.getBoundingClientRect();
    scrub({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
    end(true);
  });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') end(); });
  svg.addEventListener('pointercancel', () => end());
  svg.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') end(true); });
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
  render(false, compactMode);
  const heavy = heaviest(keys, mins);
  const txt = root.querySelector('[data-insight-text]');
  if (txt) txt.textContent = heavy ? `With the earlier start: about ${T.hours(heavy.avg)} a day at the busiest. ${moved.length} block${moved.length > 1 ? 's' : ''} would move.` : `With the earlier start, no day goes over your goal. ${moved.length} block${moved.length > 1 ? 's' : ''} would move.`;
  const row = root.querySelector('[data-preview-row]');
  row.innerHTML = `<button class="btn btn-sm" data-use style="background:var(--navajo)">Review these changes</button><button class="btn btn-ghost btn-sm" data-cancel>Never mind</button>`;
  announce('Previewing the earlier start. Nothing has changed yet.');
}
function endPreview() { preview = null; render(false); }
