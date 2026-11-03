// Settings: day shape, energy, calendar, backup, feel, data, postcards, about.
import { S, setProfile, setMeta, loadSample, clearSampleData, eraseEverything, exportBackup, validateBackup, importBackup, postcards, defaultProfile } from '../state.js';
import { storageStatus } from '../store.js';
import * as T from '../time.js';
import { doodleSVG } from '../doodle.js';
import { drawOn, observeBoil, forgetBoil, motion, set, to } from '../anim.js';
import { roughBorder } from '../rough.js';
import { esc, toast, shareOrDownload, announce } from '../dom.js';
import { setSound, pop } from '../sound.js';
import { markFor, setMark, markSVG } from '../mark.js';
import { openSheet, confirmSheet } from './sheet.js';
import { go } from '../router.js';

let root = null;
const LV = ['high', 'med', 'low'];
const LV_LABEL = { high: 'peak', med: 'okay', low: 'low' };

export function mount(el) {
  root = el;
  addEventListener('arc-storagechange', renderStorage);
  render();
  return { update: (reason) => { if (reason === 'profile' || reason === 'plan') { renderDay(); renderEnergy(); } }, unmount: () => { removeEventListener('arc-storagechange', renderStorage); forgetBoil(el); root = null; } };
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + (m || 0); };
const sleepEnd = (p) => p.sleepMin < p.wakeMin ? p.sleepMin + 1440 : p.sleepMin;
const awakeMinutes = (p) => Math.max(0, sleepEnd(p) - p.wakeMin);
const clockLabel = (m) => T.clockMin(m).toUpperCase();
function shapeLabel(p) {
  const overnight = p.sleepMin < p.wakeMin;
  return `${clockLabel(p.wakeMin)} to ${clockLabel(p.sleepMin)}${overnight ? ' next day' : ''} · ${Math.floor(awakeMinutes(p) / 60)} h awake`;
}

/** Repo link derived from the GitHub Pages URL (works on forks); null elsewhere. */
export function repoURL() {
  const h = location.hostname;
  if (!h.endsWith('.github.io')) return null;
  const owner = h.split('.')[0];
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return repo ? `https://github.com/${owner}/${repo}` : `https://github.com/${owner}/${owner}.github.io`;
}

function card(id, title, doodle, color, body) {
  return `<section class="card" data-card="${id}" aria-labelledby="h-${id}"><h2 class="card-title" id="h-${id}" style="margin:0">${doodleSVG(doodle, 26, color)}${esc(title)}</h2>${body}</section>`;
}

function render() {
  const p = S.profile;
  const repo = repoURL();
  root.innerHTML = `
    <header class="hdr"><div><div class="m">Make it yours</div><h1 class="h">Settings</h1></div><a class="mark-btn" href="#/today" aria-label="Back to Today">${markSVG()}</a></header>
    <div class="settings-list">
      ${card('day', 'Your day', 'clock', '#FDDEB2', `<div data-day-body></div>`)}
      ${card('energy', 'Energy through the day', 'sun', '#7CBB93', `<p class="m" style="margin:0">Set your morning, daytime and evening energy. Tap an hour for finer adjustments.</p><div class="energy-periods" data-energy-periods role="group" aria-label="Energy windows"></div><div class="energy-bar" data-energy role="group" aria-label="Energy by hour"></div><div class="m" data-energy-legend></div>`)}
      ${card('cal', 'Calendar (.ics)', 'book', '#B3D7F2', `
        <label class="btn btn-ghost" style="cursor:pointer">Import timetable (.ics)<input type="file" accept=".ics,text/calendar" data-ics hidden></label>
        <div data-ics-preview></div>
        <div class="seg" role="group" aria-label="What to export">
          <button type="button" data-inc="routines" aria-pressed="true">Routines</button><button type="button" data-inc="events" aria-pressed="true">Events</button><button type="button" data-inc="blocks" aria-pressed="false">Plan blocks</button></div>
        <button class="btn" type="button" data-ics-export>Export to calendar</button>
        <p class="m" style="margin:0;line-height:1.4">On iPhone, share the file to Calendar (or open it from Files) and tap “Add all”. On Windows, open it with Outlook or import it in Google Calendar. Routines come with an alarm, so your phone reminds you even when Arc is closed.</p>`)}
      ${card('backup', 'Back up your data', 'laptop', '#A9B7C6', `
        <p class="m" style="margin:0">Everything lives on this device. Save a backup file now and then.</p>
        <button class="btn" type="button" data-backup>Save a backup</button>
        <label class="btn btn-ghost" style="cursor:pointer">Restore from a backup<input type="file" accept=".json,application/json" data-restore hidden></label>`)}
      ${card('feel', 'Look & feel', 'sparkle', '#F7C8D3', `
        <div class="switch"><span>Little sounds</span><button type="button" role="switch" data-sound aria-checked="${!!S.meta.sound}" aria-label="Little sounds"></button></div>
        <div class="switch"><span>Gentle motion${motion.prefersReduced ? ' (your device asks for it)' : ''}</span><button type="button" role="switch" data-motion aria-checked="${S.meta.motion === 'gentle' || motion.prefersReduced}" ${motion.prefersReduced ? 'disabled' : ''} aria-label="Gentle motion"></button></div>
        <div class="m">Logo</div>
        <div class="logo-pick" role="group" aria-label="Logo">${['A', 'B', 'C'].map((k) => `<button type="button" data-logo="${k}" aria-pressed="${(S.meta.logo || 'B') === k}" aria-label="Logo ${k}">${markFor(k)}</button>`).join('')}</div>
        <p class="m" style="margin:0">This changes the mark inside the app. The home-screen icon comes from <code>arc.config.json</code>: run <code>go run ./tools/build -logo C</code>.</p>`)}
      ${card('cards', 'Postcards', 'moon', '#F7C8D3', `<div class="postcard-grid" data-cards></div><button class="btn btn-ghost" type="button" data-tuck>Tuck in today</button>`)}
      ${card('data', 'Data', 'plant', '#A6B58A', `
        <p class="m" data-sample-state>${S.items.some((i) => i.sample || i.id.startsWith('s-')) ? 'A sample week is loaded and marked. Clear sample data removes only those sample items.' : 'Your planner is personal to this device.'}</p>
        <button class="btn btn-ghost" type="button" data-sample>Show me a sample week</button>
        <button class="btn btn-ghost" type="button" data-clear-sample ${S.items.some((i) => i.sample || i.id.startsWith('s-')) ? '' : 'disabled'}>Clear sample data</button>
        <button class="btn btn-ghost" type="button" data-erase>Erase everything</button>`)}
      ${card('storage', 'Device storage', 'laptop', '#A9B7C6', `<div data-storage-status role="status"></div>`)}
      ${card('about', 'About', 'pencil', '#FFF7E6', `
        <p class="m" style="margin:0;line-height:1.5">Arc ${esc(S.version)} · all your data stays on this device. No accounts, no tracking, no servers.${repo ? ` <a href="${esc(repo)}" style="color:var(--vanilla)" target="_blank" rel="noopener">Source code</a>` : ''}</p>
        <button class="btn btn-text" type="button" data-onboard>Replay the welcome</button>`)}
    </div>`;
  root.querySelectorAll('[data-card]').forEach((c, i) => {
    roughBorder(c, { color: 'var(--line-2)', width: 1.5, radius: 28, seed: 'set' + i, draw: !motion.reduced });
    if (!motion.reduced) { set(c, { y: 14, opacity: 0 }); setTimeout(() => to(c, { y: 0, opacity: 1 }, 'gentle'), 40 * i); }
  });
  renderDay();
  renderEnergy();
  renderStorage();
  renderCards();
  observeBoil(root);
  wire();
}

function renderDay() {
  if (!root) return;
  const p = S.profile;
  const today = T.scheduleDayKey(T.now(), p.wakeMin);
  const ov = (p.dayOverrides || {})[today];
  const mode = ov === undefined ? 'normal' : ov < p.ambitionMin ? 'light' : ov > p.ambitionMin ? 'push' : 'normal';
  root.querySelector('[data-day-body]').innerHTML = `
    <label class="field"><span class="m">Your name</span><input class="input" type="text" data-name maxlength="40" value="${esc(p.name || '')}" autocomplete="given-name" placeholder="Your name"></label>
    <div class="row"><label class="field"><span class="m">Wake up (AM/PM)</span><input class="input" type="time" data-wake value="${hhmm(p.wakeMin)}"></label>
    <label class="field"><span class="m">Lights out (AM/PM)</span><input class="input" type="time" data-sleep value="${hhmm(p.sleepMin)}"></label></div>
    <p class="m day-shape" data-day-shape>${esc(shapeLabel(p))}</p>
    <div class="field"><span class="m">Daily deep-work goal</span><div class="stepper"><button type="button" data-amb="-30" aria-label="Lower goal">−</button><output>${T.hours(p.ambitionMin)}</output><button type="button" data-amb="30" aria-label="Raise goal">+</button></div></div>
    <div class="field"><span class="m">Today is a…</span><div class="seg" role="group" aria-label="Today's goal">
      <button type="button" data-mode="light" aria-pressed="${mode === 'light'}">Light day</button><button type="button" data-mode="normal" aria-pressed="${mode === 'normal'}">Normal</button><button type="button" data-mode="push" aria-pressed="${mode === 'push'}">Push day</button></div></div>
    <div class="field"><span class="m">Focus block length</span><div class="stepper"><button type="button" data-blk="-5" aria-label="Shorter blocks">−</button><output>${p.blockMin} min</output><button type="button" data-blk="5" aria-label="Longer blocks">+</button></div></div>`;
}

function renderEnergy() {
  const p = S.profile;
  const bar = root.querySelector('[data-energy]');
  const periodBar = root.querySelector('[data-energy-periods]');
  const bounds = energyBounds(p);
  periodBar.innerHTML = bounds.map(({ name, label, start, end }) => {
    const value = energyLevel(p, (start + end) / 2);
    const text = LV_LABEL[value];
    return `<button type="button" class="lvl-${value}" data-energy-period="${name}" aria-label="${label} ${T.clockMin(start)} to ${T.clockMin(end)}: ${text} energy">${label}<br>${text}</button>`;
  }).join('');
  const hours = [];
  for (let m = Math.floor(p.wakeMin / 60) * 60; m < sleepEnd(p); m += 60) hours.push(m);
  const lvl = (m) => energyLevel(p, m + 30);
  bar.innerHTML = hours.map((m) => `<button type="button" class="lvl-${lvl(m)}" data-hour="${m}" aria-label="${T.clockMin(m).toUpperCase()}: ${LV_LABEL[lvl(m)]} energy">${T.clockMin(m).toUpperCase()}</button>`).join('');
  root.querySelector('[data-energy-legend]').innerHTML = '<span style="color:var(--teal)">■</span> peak &nbsp; <span style="color:var(--navajo)">■</span> okay &nbsp; <span style="color:var(--lagoon);-webkit-text-stroke:1px var(--mist)">■</span> low';
}

function energyBounds(p) {
  const end = sleepEnd(p);
  const span = end - p.wakeMin;
  const first = span < 180 ? p.wakeMin + Math.round(span / 3) : Math.max(p.wakeMin + 60, Math.min(12 * 60, end - 120));
  const second = span < 180 ? p.wakeMin + Math.round(span * 2 / 3) : Math.max(first + 60, Math.min(17 * 60, end - 60));
  return [
    { name: 'morning', label: 'Morning', start: p.wakeMin, end: first },
    { name: 'daytime', label: 'Daytime', start: first, end: second },
    { name: 'evening', label: 'Evening', start: second, end },
  ].filter((w) => w.end > w.start);
}

function energyWindows(p) {
  const start = p.wakeMin, end = sleepEnd(p);
  const out = [];
  for (const w of p.energy || []) {
    for (const shift of [-1440, 0, 1440]) {
      const a = Math.max(start, w.startMin + shift);
      const b = Math.min(end, w.endMin + shift);
      if (b > a) out.push({ startMin: a, endMin: b, level: w.level });
    }
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

function energyLevel(p, m) {
  const windows = energyWindows(p);
  const w = windows.find((entry) => m >= entry.startMin && m < entry.endMin);
  return w ? w.level : 'med';
}

function updateEnergyPeriod(p, period, level) {
  const target = energyBounds(p).find((w) => w.name === period);
  if (!target) return p.energy;
  const end = sleepEnd(p);
  const windows = energyWindows(p);
  const points = new Set([p.wakeMin, end, target.start, target.end]);
  windows.forEach((w) => { points.add(w.startMin); points.add(w.endMin); });
  const cuts = [...points].filter((m) => m >= p.wakeMin && m <= end).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const startMin = cuts[i], endMin = cuts[i + 1], mid = (startMin + endMin) / 2;
    const existing = windows.find((w) => mid >= w.startMin && mid < w.endMin);
    const nextLevel = mid >= target.start && mid < target.end ? level : (existing ? existing.level : 'med');
    const previous = out[out.length - 1];
    if (previous && previous.level === nextLevel) previous.endMin = endMin;
    else out.push({ startMin, endMin, level: nextLevel });
  }
  return out;
}

function renderStorage() {
  if (!root) return;
  const box = root.querySelector('[data-storage-status]');
  if (!box) return;
  const status = storageStatus();
  const descriptions = {
    indexedDB: 'IndexedDB is active and saves your planner on this device.',
    localStorage: 'IndexedDB is unavailable. Local storage is saving your planner on this device.',
    memory: 'Memory-only mode: changes will be lost when this tab closes.',
    switching: 'Switching to fallback storage…',
    opening: 'Opening browser storage…',
  };
  box.innerHTML = `<p class="m" style="margin:0">${esc(descriptions[status.backend] || status.backend)}</p>
    ${status.idbError ? `<p class="m" style="margin:0">IndexedDB error: <b>${esc(status.idbError.name)}</b>: ${esc(status.idbError.message)}</p>` : ''}
    <p class="m" style="margin:0">Keep this device's storage: ${esc(status.persist)}.</p>`;
}

async function renderCards() {
  const list = (await postcards()).sort((a, b) => (a.day < b.day ? 1 : -1));
  const grid = root && root.querySelector('[data-cards]');
  if (!grid) return;
  grid.innerHTML = list.length ? list.map((p) => `<button type="button" data-pc="${p.day}" aria-label="Postcard for ${T.shortDateKey(p.day)}"><img alt="" src="${p.png || 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.svg)}"></button>`).join('')
    : `<p class="m" style="grid-column:1/-1;margin:0">No postcards yet. Tuck in at the end of a day to make your first.</p>`;
  grid.onclick = async (e) => {
    const b = e.target.closest('[data-pc]');
    if (!b) return;
    const p = list.find((x) => x.day === b.dataset.pc);
    const { openArchived } = await import('../postcard.js');
    openArchived(p);
  };
}

function energyFromHours(p, hourLevels) {
  // Merge consecutive hours into windows; clock minutes above 1440 are next day.
  const out = [];
  const end = sleepEnd(p);
  for (const [m, l] of hourLevels) {
    const s = Math.max(p.wakeMin, m), e = Math.min(end, m + 60);
    const last = out[out.length - 1];
    if (last && last.level === l && last.endMin === s) last.endMin = e;
    else out.push({ startMin: s, endMin: e, level: l });
  }
  return out;
}

function wire() {
  // property handlers (not addEventListener): #screen is shared across routes
  root.onchange = async (e) => {
    const t = e.target;
    if (t.matches('[data-name]')) {
      await setProfile({ ...S.profile, name: t.value.trim().slice(0, 40) });
      toast(S.profile.name ? `Hey ${S.profile.name}. Nice to meet you.` : 'Name cleared.');
    }
    if (t.matches('[data-wake], [data-sleep]')) {
      const p = { ...S.profile, wakeMin: toMin(root.querySelector('[data-wake]').value || '07:00'), sleepMin: toMin(root.querySelector('[data-sleep]').value || '23:00') };
      const span = p.sleepMin - p.wakeMin + (p.sleepMin < p.wakeMin ? 1440 : 0);
      if (span < 120) { toast('Leave at least two hours between waking and lights out.'); renderDay(); return; }
      await setProfile(p);
      renderEnergy();
      const shape = root.querySelector('[data-day-shape]');
      if (shape) shape.textContent = shapeLabel(p);
      toast('Day shape saved. Review any proposed block changes before they move.');
    }
    if (t.matches('[data-ics]') && t.files[0]) return previewIcs(t.files[0], t);
    if (t.matches('[data-restore]') && t.files[0]) return restore(t.files[0], t);
  };
  root.oninput = (e) => {
    if (!e.target.matches('[data-wake], [data-sleep]')) return;
    const p = { ...S.profile, wakeMin: toMin(root.querySelector('[data-wake]').value || '07:00'), sleepMin: toMin(root.querySelector('[data-sleep]').value || '23:00') };
    const shape = root.querySelector('[data-day-shape]');
    if (shape) shape.textContent = shapeLabel(p);
  };
  root.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const p = S.profile;
    if (b.dataset.amb) { await setProfile({ ...p, ambitionMin: Math.max(30, Math.min(720, p.ambitionMin + Number(b.dataset.amb))) }); renderDay(); }
    if (b.dataset.blk) { await setProfile({ ...p, blockMin: Math.max(20, Math.min(120, p.blockMin + Number(b.dataset.blk))) }); renderDay(); }
    if (b.dataset.mode) {
      const ov = { ...(p.dayOverrides || {}) };
      const k = T.dayKey();
      if (b.dataset.mode === 'normal') delete ov[k];
      else ov[k] = Math.round(p.ambitionMin * (b.dataset.mode === 'light' ? 0.5 : 1.5) / 5) * 5;
      await setProfile({ ...p, dayOverrides: ov });
      renderDay();
      toast(b.dataset.mode === 'light' ? 'Light day it is. Be gentle.' : b.dataset.mode === 'push' ? 'Push day! Snacks recommended.' : 'Back to a normal day.');
    }
    if (b.dataset.hour) {
      const cur = b.className.replace('lvl-', '');
      const next = LV[(LV.indexOf(cur) + 1) % 3];
      b.className = `lvl-${next}`;
      b.setAttribute('aria-label', `${T.clockMin(Number(b.dataset.hour))}: ${LV_LABEL[next]} energy`);
      pop(next === 'high' ? 1.3 : next === 'med' ? 1 : 0.8);
      clearTimeout(wire.t);
      wire.t = setTimeout(async () => {
        const levels = [...root.querySelectorAll('[data-hour]')].map((x) => [Number(x.dataset.hour), x.className.replace('lvl-', '')]);
        await setProfile({ ...S.profile, energy: energyFromHours(S.profile, levels) });
        announce('Energy updated.');
      }, 700);
    }
    if (b.dataset.energyPeriod) {
      const current = b.className.replace('lvl-', '');
      const next = LV[(LV.indexOf(current) + 1) % LV.length];
      await setProfile({ ...S.profile, energy: updateEnergyPeriod(S.profile, b.dataset.energyPeriod, next) });
      renderEnergy();
      announce(`${b.dataset.energyPeriod} energy set to ${LV_LABEL[next]}.`);
    }
    if (b.dataset.inc) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    if (b.hasAttribute('data-ics-export')) {
      const inc = [...root.querySelectorAll('[data-inc][aria-pressed="true"]')].map((x) => x.dataset.inc);
      if (!inc.length) { toast('Pick at least one thing to export.'); return; }
      const { exportIcs } = await import('../ics-io.js');
      const how = await exportIcs(inc);
      if (how === 'downloaded') toast('Calendar file saved. Open it to add to your calendar.');
    }
    if (b.hasAttribute('data-backup')) {
      const data = await exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      await shareOrDownload(blob, `arc-backup-${T.dayKey()}.json`, 'Arc backup');
      toast('Backup saved. Keep it somewhere safe.');
    }
    if (b.dataset.sound !== undefined) {
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(on));
      setSound(on); await setMeta('sound', on);
      if (on) pop(1.2);
    }
    if (b.dataset.motion !== undefined) {
      const gentle = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(gentle));
      motion.set(gentle ? 'gentle' : 'full');
      document.body.classList.toggle('gentle', gentle);
      await setMeta('motion', gentle ? 'gentle' : 'full');
    }
    if (b.dataset.logo) {
      root.querySelectorAll('[data-logo]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      setMark(b.dataset.logo); await setMeta('logo', b.dataset.logo);
    }
    if (b.hasAttribute('data-tuck')) { const { openTuckIn } = await import('../postcard.js'); openTuckIn(T.dayKey(), b); }
    if (b.hasAttribute('data-sample')) {
      const ok = !S.items.some((i) => !i.deleted) || await confirmSheet({ title: 'Load sample data?', text: 'This replaces your items and plan with the sample student week. Back up first if you want to keep them.', yes: 'Load sample', no: 'Keep mine' });
      if (ok) { await loadSample(); toast('Sample week loaded.'); go('today'); }
    }
    if (b.hasAttribute('data-clear-sample')) {
      const count = await clearSampleData();
      render();
      toast(count ? `${count} sample items cleared. Your own items are still here.` : 'There is no sample data to clear.');
    }
    if (b.hasAttribute('data-erase')) {
      const ok = await confirmSheet({ title: 'Erase everything?', text: 'Every item, plan, postcard and setting on this device goes away. This cannot be undone.', yes: 'Erase everything', no: 'Keep it all', typed: 'ERASE' });
      if (ok) await eraseEverything();
    }
    if (b.hasAttribute('data-onboard')) { const { openOnboarding } = await import('./onboarding.js'); openOnboarding(); }
  };
}

async function previewIcs(file, input) {
  const box = root.querySelector('[data-ics-preview]');
  const { readIcs, confirmImport } = await import('../ics-io.js');
  let res;
  try { res = await readIcs(file); } catch (e) { toast("That file couldn't be read as a calendar."); input.value = ''; return; }
  input.value = '';
  const series = new Map();
  res.items.forEach((i) => { const k = i.seriesId || i.id; if (!series.has(k)) series.set(k, { it: i, n: 0 }); series.get(k).n++; });
  box.innerHTML = `<div class="ics-preview" role="list">${[...series.values()].slice(0, 30).map(({ it, n }) => `<div role="listitem" class="row" style="gap:8px">${doodleSVG(it.doodle, 20, '#F0EFEF', { boil: false })}<span style="flex:1">${esc(it.title)}</span><span class="m">${n > 1 ? `${n}×` : T.shortDate(new Date(it.start))}</span></div>`).join('')}</div>
    ${res.skipped.length ? `<p class="m" style="margin:0">${res.skipped.length} left out: ${esc(res.skipped[0].reason)}</p>` : ''}
    <div class="row"><button class="btn" type="button" data-ics-ok ${res.items.length ? '' : 'disabled'}>Add ${res.items.length} event${res.items.length === 1 ? '' : 's'}</button><button class="btn btn-ghost" type="button" data-ics-no>Cancel</button></div>`;
  drawOn(box, { duration: 400 });
  box.querySelector('[data-ics-ok]').onclick = async () => { const n = await confirmImport(res.items); box.innerHTML = ''; toast(`${n} event${n === 1 ? '' : 's'} added. Your plan flows around them.`); };
  box.querySelector('[data-ics-no]').onclick = () => { box.innerHTML = ''; };
}

async function restore(file, input) {
  input.value = '';
  let data, counts;
  try { data = JSON.parse(await file.text()); counts = validateBackup(data); } catch (e) { toast(e.message || "That file isn't an Arc backup."); return; }
  const ok = await confirmSheet({ title: 'Restore this backup?', text: `It has ${counts.items} items, ${counts.blocks} blocks and ${counts.postcards} postcards from ${data.exportedAt ? T.shortDate(new Date(data.exportedAt)) : 'an earlier day'}. Everything on this device now will be replaced.`, yes: 'Restore it', no: 'Not now' });
  if (!ok) return;
  await importBackup(data);
  toast('Backup restored.');
  go('today');
}

export { defaultProfile };
