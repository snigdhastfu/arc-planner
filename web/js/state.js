// App state + actions. Every action writes IndexedDB, then asks the Go core
// for a plan and notifies subscribers. The planner never silently moves
// things: plan() keeps existing blocks; changes go through replan + review.
import * as db from './store.js';
import { call } from './bridge.js';
import * as T from './time.js';

export const S = {
  items: [],
  profile: null,
  plan: { blocks: [], atRisk: [], warnings: [], generatedAt: '' },
  meta: {},
  proposal: null, // { proposed, changes, drifted }
  drifted: false,
  persistent: true,
  version: '',
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit(reason, detail) { subs.forEach((f) => { try { f(reason, detail); } catch (e) { console.error(e); } }); }

export const DEFAULT_ENERGY = [
  { startMin: 420, endMin: 480, level: 'low' },
  { startMin: 480, endMin: 570, level: 'med' },
  { startMin: 570, endMin: 780, level: 'high' },
  { startMin: 780, endMin: 900, level: 'med' },
  { startMin: 900, endMin: 1080, level: 'high' },
  { startMin: 1080, endMin: 1200, level: 'med' },
  { startMin: 1200, endMin: 1380, level: 'low' },
];
export function defaultProfile() {
  return { tz: T.deviceTZ, wakeMin: 420, sleepMin: 1380, ambitionMin: 240, dayOverrides: {}, energy: DEFAULT_ENERGY.map((e) => ({ ...e })), blockMin: 50, overloadFactor: 1.4 };
}

const uid = (p = 'it') => `${p}-${(crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 12)}`;
const META_DEFAULTS = { onboarded: false, sound: false, logo: document.body.dataset.logo || 'B', motion: 'full', timer: null, undo: null, persistAsked: false };

// ---- boot -----------------------------------------------------------------
export async function init() {
  await db.open();
  S.persistent = db.persistent();
  const [items, prof, metas] = await Promise.all([db.all('items'), db.get('profile', 'profile'), db.all('meta')]);
  S.items = items;
  S.profile = prof ? prof.value : defaultProfile();
  T.setTZ(S.profile.tz);
  S.meta = { ...META_DEFAULTS };
  metas.forEach((m) => { S.meta[m.key] = m.value; });
  try { S.version = call('version').version; } catch (_) { S.version = '?'; }
  await replan({ quiet: true });
}

export async function setMeta(key, value) {
  S.meta[key] = value;
  await db.put('meta', { key, value });
  emit('meta', key);
}

// ---- planning ---------------------------------------------------------------
function liveItems() { return S.items.filter((i) => !i.deleted); }
function todayStart() { return T.at(T.dayKey(), 0); }

async function storedBlocksFromToday() {
  const all = await db.all('blocks');
  const today = T.dayKey();
  return all.filter((b) => b.day >= today).map(stripDay);
}
const stripDay = ({ day, ...b }) => b;

/** Persist plan blocks: replace every stored block from today onward. */
async function persistPlan(plan) {
  const today = T.dayKey();
  const all = await db.all('blocks');
  const keep = new Set(plan.blocks.map((b) => b.id));
  const stale = all.filter((b) => b.day >= today && !keep.has(b.id)).map((b) => b.id);
  if (stale.length) await db.delMany('blocks', stale);
  await db.putMany('blocks', plan.blocks.map((b) => ({ ...b, day: T.dayKey(new Date(b.start)) })));
  await db.put('meta', { key: 'plan', value: { atRisk: plan.atRisk, warnings: plan.warnings, generatedAt: plan.generatedAt } });
}

/** Recompute the plan keeping existing blocks (new effort only). */
export async function replan({ quiet = false } = {}) {
  const existing = await storedBlocksFromToday();
  const plan = call('plan', { items: liveItems(), profile: S.profile, now: T.iso(T.now()), existing });
  S.plan = plan;
  await persistPlan(plan);
  checkDrift();
  if (!quiet) emit('plan');
  return plan;
}

/** Ask the core whether the day drifted and what it would propose. */
export function checkDrift() {
  try {
    const res = call('replan', { items: liveItems(), profile: S.profile, now: T.iso(T.now()), current: S.plan });
    S.proposal = res;
    const was = S.drifted;
    S.drifted = !!(res.drifted && res.changes.length);
    if (was !== S.drifted) emit('drift');
  } catch (e) { console.warn('drift check failed', e); }
}

// ---- items -----------------------------------------------------------------------
export async function addItem(item) {
  const it = { ...item, id: item.id && !item.id.startsWith('qa-') ? item.id : uid(), updatedAt: T.iso(T.now()) };
  if (!it.doodle) it.doodle = call('matchDoodle', { title: it.title, type: it.type }).doodle;
  if (!it.doodleSource) it.doodleSource = 'auto';
  S.items.push(it);
  await db.put('items', it);
  await replan();
  await maybePersist();
  emit('item-added', it);
  return it;
}
export async function updateItem(it) {
  it = { ...it, updatedAt: T.iso(T.now()) };
  if (it.doodleSource !== 'user') it.doodle = call('matchDoodle', { title: it.title, type: it.type }).doodle;
  S.items = S.items.map((x) => (x.id === it.id ? it : x));
  await db.put('items', it);
  // Edits to effort/deadline release that item's future planned blocks so
  // the new numbers apply; other items stay exactly where they are.
  const all = await db.all('blocks');
  const today = T.dayKey();
  const drop = all.filter((b) => b.itemId === it.id && b.day >= today && b.status === 'planned' && !b.pinned && new Date(b.start) > T.now()).map((b) => b.id);
  if (drop.length) await db.delMany('blocks', drop);
  await replan();
  return it;
}
export async function deleteItem(id) {
  const it = S.items.find((x) => x.id === id);
  if (!it) return;
  await updateItemRaw({ ...it, deleted: true });
  const all = await db.all('blocks');
  const drop = all.filter((b) => b.itemId === id && b.status === 'planned').map((b) => b.id);
  if (drop.length) await db.delMany('blocks', drop);
  await replan();
}
async function updateItemRaw(it) {
  it.updatedAt = T.iso(T.now());
  S.items = S.items.map((x) => (x.id === it.id ? it : x));
  await db.put('items', it);
}
export const itemById = (id) => S.items.find((i) => i.id === id);

/** Reorder routines within a group: ids in their new order. */
export async function reorderRoutines(ids) {
  for (let i = 0; i < ids.length; i++) {
    const it = itemById(ids[i]);
    if (it && it.routine && it.routine.order !== i) await updateItemRaw({ ...it, routine: { ...it.routine, order: i } });
  }
  // Routine positions are derived from Order, so their planned blocks are rebuilt.
  const all = await db.all('blocks');
  const today = T.dayKey();
  const drop = all.filter((b) => b.kind === 'routine' && b.status === 'planned' && b.day >= today).map((b) => b.id);
  if (drop.length) await db.delMany('blocks', drop);
  await replan();
}

// ---- block actions ---------------------------------------------------------------
const inflight = new Set(); // guards double-fired swipes
export async function blockAction(blockId, action, extra = {}) {
  if (inflight.has(blockId)) return null;
  inflight.add(blockId);
  try {
    const res = call('blockAction', { action, blockId, plan: S.plan, items: liveItems(), profile: S.profile, now: T.iso(T.now()), ...extra });
    const changed = new Set(res.changed);
    for (const it of res.items) if (changed.has(it.id)) {
      S.items = S.items.map((x) => (x.id === it.id ? it : x));
      await db.put('items', it);
    }
    S.plan = res.plan;
    const b = res.plan.blocks.find((x) => x.id === blockId);
    if (b && b.kind === 'routine') {
      const day = T.dayKey(new Date(b.start));
      if (b.status === 'planned') await db.del('routineLog', [day, b.itemId]);
      else await db.put('routineLog', { day, itemId: b.itemId, status: b.status, at: T.iso(T.now()) });
    }
    if (S.meta.timer && S.meta.timer.blockId === blockId && action !== 'snooze') await setMeta('timer', null);
    await persistPlan(S.plan);
    if (action === 'snooze') await replan({ quiet: true });
    checkDrift();
    emit('block', { blockId, action, block: b });
    return b;
  } finally {
    setTimeout(() => inflight.delete(blockId), 350);
  }
}

/** Pin a block at a new start (drag on the arc). */
export async function moveBlock(blockId, startDate) {
  const b = S.plan.blocks.find((x) => x.id === blockId);
  if (!b) return;
  const len = new Date(b.end) - new Date(b.start);
  const nb = { ...b, start: T.iso(startDate), end: T.iso(new Date(startDate.getTime() + len)), pinned: true, why: 'You put this here yourself.' };
  S.plan = { ...S.plan, blocks: S.plan.blocks.map((x) => (x.id === blockId ? nb : x)) };
  await persistPlan(S.plan);
  await replan();
}

/** Would a block at [start,end) overlap anything active? Returns the clashing block. */
export function clashAt(blockId, start, end) {
  return S.plan.blocks.find((x) => x.id !== blockId && x.status !== 'skipped' && x.status !== 'moved' && new Date(x.start) < end && start < new Date(x.end));
}

// ---- review / undo ---------------------------------------------------------------
export function freshProposal() {
  if (S.injected) { const p = S.injected; S.injected = null; return p; }
  checkDrift();
  return S.proposal;
}
/** Hand a hypothetical proposal (e.g. Horizon's preview) to the review screen. */
export function injectProposal(p) { S.injected = p; }
/** Run replan against hypothetical items without touching state. */
export function previewReplan(items) {
  return call('replan', { items, profile: S.profile, now: T.iso(T.now()), current: S.plan });
}
export async function applyProposal(acceptedIDs, proposal = S.proposal) {
  const p = proposal;
  if (!p) return { conflicts: [] };
  const res = call('applyChanges', { current: S.plan, proposed: p.proposed, changes: p.changes, acceptedIDs, items: liveItems(), profile: S.profile, now: T.iso(T.now()) });
  await pushHistory();
  S.plan = res.plan;
  await persistPlan(S.plan);
  await setMeta('undo', { at: T.nowMs() });
  checkDrift();
  emit('plan');
  return res;
}
async function pushHistory() {
  await db.put('history', { at: T.nowMs(), plan: S.plan });
  const entries = await db.historyEntries();
  if (entries.length > 5) for (const e of entries.slice(0, entries.length - 5)) await db.del('history', e.key);
}
export async function canUndo() {
  const entries = await db.historyEntries();
  const last = entries[entries.length - 1];
  return !!(last && T.nowMs() - last.value.at < 24 * 3600 * 1000);
}
export async function undo() {
  const entries = await db.historyEntries();
  const last = entries[entries.length - 1];
  if (!last || T.nowMs() - last.value.at > 24 * 3600 * 1000) return false;
  await db.del('history', last.key);
  S.plan = last.value.plan;
  await persistPlan(S.plan);
  await setMeta('undo', null);
  checkDrift();
  emit('plan');
  return true;
}

// ---- profile ----------------------------------------------------------------------
export async function setProfile(p, { rebuild = true } = {}) {
  S.profile = { ...p };
  T.setTZ(S.profile.tz);
  await db.put('profile', { key: 'profile', value: S.profile });
  if (rebuild) {
    // Profile changes re-place future planned blocks (the user asked for it).
    const all = await db.all('blocks');
    const today = T.dayKey();
    const drop = all.filter((b) => b.day >= today && b.status === 'planned' && !b.pinned && new Date(b.start) > T.now()).map((b) => b.id);
    if (drop.length) await db.delMany('blocks', drop);
  }
  await replan();
  emit('profile');
}

// ---- routine history (week strip) ---------------------------------------------------
export async function routineWeek(keys) {
  const log = await db.all('routineLog');
  const blocks = await db.all('blocks');
  return keys.map((k) => {
    const dayBlocks = blocks.filter((b) => b.kind === 'routine' && b.day === k);
    const logged = log.filter((l) => l.day === k);
    const total = Math.max(dayBlocks.length, logged.length);
    const done = Math.max(dayBlocks.filter((b) => b.status === 'done').length, logged.filter((l) => l.status === 'done').length);
    return total ? done / total : 0;
  });
}

// ---- postcards --------------------------------------------------------------------
export async function savePostcard(day, data) { await db.put('postcards', { day, ...data }); }
export const postcards = () => db.all('postcards');

// ---- sample data / erase / backup ------------------------------------------------------
export async function loadSample() {
  const sample = await fetch('data/sample.json').then((r) => r.json());
  const today = T.dayKey();
  const when = (spec) => (spec ? T.iso(T.at(T.addDays(today, spec.day), spec.min)) : '');
  const items = sample.items.map((s) => {
    const it = { ...s };
    for (const k of ['start', 'end', 'due', 'startBy']) if (s[k]) it[k] = when(s[k]);
    it.updatedAt = T.iso(T.now());
    return it;
  });
  await db.clear('items'); await db.clear('blocks'); await db.clear('routineLog'); await db.clear('history');
  S.items = items;
  await db.putMany('items', items);
  if (!S.profile) S.profile = defaultProfile();
  await setProfile({ ...defaultProfile(), tz: S.profile.tz }, { rebuild: false });
  // A lived-in feel: yesterday's routines all done, and today's first two.
  const yesterday = T.addDays(today, -1);
  await db.putMany('routineLog', items.filter((i) => i.type === 'routine').map((i) => ({ day: yesterday, itemId: i.id, status: 'done', at: T.iso(T.now()) })));
  for (const title of sample.doneToday || []) {
    const it = items.find((i) => i.title === title);
    const b = it && S.plan.blocks.find((x) => x.itemId === it.id && T.dayKey(new Date(x.start)) === today);
    if (b && new Date(b.start) < T.now()) await blockAction(b.id, 'done');
  }
  await setMeta('onboarded', true);
  emit('plan');
}
export async function eraseEverything() {
  await db.eraseAll();
  S.items = []; S.profile = defaultProfile(); S.meta = { ...META_DEFAULTS };
  S.plan = { blocks: [], atRisk: [], warnings: [], generatedAt: '' };
  S.proposal = null; S.drifted = false;
  emit('erased');
}
export async function exportBackup() {
  return {
    version: 1, app: 'arc', exportedAt: T.iso(T.now()),
    items: await db.all('items'),
    profile: S.profile,
    blocks: await db.all('blocks'),
    routineLog: await db.all('routineLog'),
    postcards: await db.all('postcards'),
    meta: (await db.all('meta')).filter((m) => !['timer', 'undo'].includes(m.key)),
  };
}
export function validateBackup(data) {
  if (!data || typeof data !== 'object') throw new Error("That file isn't an Arc backup.");
  if (data.version !== 1) throw new Error('This backup is from a different version of Arc.');
  for (const k of ['items', 'blocks', 'routineLog', 'postcards', 'meta']) if (!Array.isArray(data[k])) throw new Error(`The backup is missing "${k}".`);
  if (!data.profile || typeof data.profile !== 'object') throw new Error('The backup is missing the profile.');
  for (const it of data.items) if (!it.id || !it.type) throw new Error('Some items in the backup look broken.');
  return { items: data.items.filter((i) => !i.deleted).length, blocks: data.blocks.length, postcards: data.postcards.length, routineLog: data.routineLog.length };
}
export async function importBackup(data) {
  validateBackup(data);
  await db.eraseAll();
  await db.putMany('items', data.items);
  await db.putMany('blocks', data.blocks.map((b) => ({ ...b, day: b.day || T.dayKey(new Date(b.start)) })));
  await db.putMany('routineLog', data.routineLog);
  await db.putMany('postcards', data.postcards);
  for (const m of data.meta) await db.put('meta', m);
  await db.put('profile', { key: 'profile', value: data.profile });
  await init();
  emit('plan');
}
export async function importEvents(items) {
  const existing = new Set(S.items.map((i) => i.id));
  const fresh = items.filter((i) => !existing.has(i.id)).map((i) => ({ ...i, updatedAt: T.iso(T.now()) }));
  S.items.push(...fresh);
  await db.putMany('items', fresh);
  await replan();
  return fresh.length;
}

async function maybePersist() {
  if (!S.meta.persistAsked) { await setMeta('persistAsked', true); db.requestPersist(); }
}

// ---- timer (survives reloads via timestamps) --------------------------------------------
export function timerState(block) {
  const t = S.meta.timer && S.meta.timer.blockId === block.id ? S.meta.timer : null;
  const end = new Date(block.end).getTime();
  const start = new Date(block.start).getTime();
  const pausedFor = t ? t.pausedTotal + (t.pausedAt ? T.nowMs() - t.pausedAt : 0) : 0;
  const left = Math.max(0, Math.min(end - start, end + pausedFor - T.nowMs()));
  return { left, total: end - start, paused: !!(t && t.pausedAt), started: T.nowMs() >= start };
}
export async function toggleTimer(block) {
  const t = S.meta.timer && S.meta.timer.blockId === block.id ? { ...S.meta.timer } : { blockId: block.id, pausedTotal: 0, pausedAt: null };
  if (t.pausedAt) { t.pausedTotal += T.nowMs() - t.pausedAt; t.pausedAt = null; } else t.pausedAt = T.nowMs();
  await setMeta('timer', t);
}
