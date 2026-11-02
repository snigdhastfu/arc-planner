// Item editor: type-specific fields, doodle picker, effort steppers, soft delete.
import { S, addItem, updateItem, deleteItem, reorderRoutines } from '../state.js';
import { call } from '../bridge.js';
import * as T from '../time.js';
import { doodleSVG } from '../doodle.js';
import { drawOn, erase } from '../anim.js';
import { esc, itemHex, toast, groupOf } from '../dom.js';
import { openSheet, confirmSheet } from './sheet.js';
import { openPicker } from './picker.js';
import { groupItems } from './routines.js';

const TYPES = [['exam', 'Exam'], ['assignment', 'Assignment'], ['project', 'Project'], ['event', 'Event'], ['routine', 'Routine']];
const ANCHORS = [['morning', 'Morning'], ['daytime', 'Daytime'], ['evening', 'Evening'], ['time', 'At a time']];
const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const toDate = (iso) => (iso ? T.dayKey(new Date(iso)) : '');
const toTime = (iso) => { if (!iso) return ''; const m = T.minOfDay(new Date(iso)); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const minOf = (hhmm) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const isoAt = (date, time) => (date ? T.iso(T.at(date, minOf(time || '00:00'))) : '');

export function openEditor(item = {}, { isNew = !item.id } = {}) {
  const today = T.dayKey();
  let it = JSON.parse(JSON.stringify({ type: 'assignment', title: '', doodleSource: 'auto', ...item }));
  if (it.type === 'routine' && !it.routine) it.routine = { anchor: 'morning', durMin: 2, order: 99, recur: { freq: 'daily', interval: 1 } };
  const sheet = openSheet({
    title: isNew ? 'New thing' : 'Edit',
    seed: it.id || 'new',
    tall: true,
    body: '<form class="editor" data-form novalidate></form>',
    onMount: (s) => { render(s); },
  });

  function defaults(type) {
    if (type === 'exam' && !it.start) it.start = isoAt(T.addDays(today, 7), '09:00');
    if ((type === 'assignment' || type === 'project') && !it.due) it.due = isoAt(T.addDays(today, type === 'project' ? 14 : 3), '23:59');
    if (type === 'event' && !it.start) { it.start = isoAt(T.addDays(today, 1), '10:00'); it.end = isoAt(T.addDays(today, 1), '11:00'); }
    if (!it.effortMin && ['exam', 'assignment', 'project'].includes(type)) it.effortMin = { exam: 240, assignment: 60, project: 600 }[type];
    if (type === 'routine' && !it.routine) it.routine = { anchor: 'morning', group: 'morning', durMin: 2, order: 99, recur: { freq: 'daily', interval: 1 } };
  }

  function render(s) {
    defaults(it.type);
    const f = s.el.querySelector('[data-form]');
    const color = itemHex(it);
    const isWork = ['exam', 'assignment', 'project'].includes(it.type);
    const r = it.routine || {};
    const rec = r.recur || { freq: 'daily', interval: 1 };
    const days = rec.days || [];
    f.innerHTML = `
      <div class="seg" role="group" aria-label="Type">${TYPES.map(([k, l]) => `<button type="button" data-type="${k}" aria-pressed="${it.type === k}">${l}</button>`).join('')}</div>
      <div class="row" style="align-items:flex-end">
        <label class="field" style="flex:1"><span class="m">Title</span><input class="input" name="title" value="${esc(it.title)}" placeholder="${it.type === 'routine' ? 'Make bed' : 'Chem PS4'}" required autocomplete="off" autofocus></label>
        <button type="button" class="qa-doodle" data-doodle aria-label="Change doodle (${esc(it.doodle || 'auto')})" style="flex:none;border:0;${it.type === 'routine' ? `background:${color}` : `background:#000;box-shadow:inset 0 0 0 2px ${color}`}">${doodleSVG(it.doodle || 'sparkle', 40, it.type === 'routine' ? '#111' : color, { boil: false })}</button>
      </div>
      ${it.type === 'exam' ? `
        <div class="row"><label class="field"><span class="m">Exam day</span><input class="input" type="date" name="d1" value="${toDate(it.start)}"></label>
        <label class="field"><span class="m">Time</span><input class="input" type="time" name="t1" value="${toTime(it.start)}"></label></div>` : ''}
      ${it.type === 'assignment' || it.type === 'project' ? `
        <div class="row"><label class="field"><span class="m">Due</span><input class="input" type="date" name="d1" value="${toDate(it.due)}"></label>
        <label class="field"><span class="m">Time</span><input class="input" type="time" name="t1" value="${toTime(it.due)}"></label></div>` : ''}
      ${isWork ? `
        <div class="field"><span class="m">Prep time</span><div class="stepper"><button type="button" data-step="-30" aria-label="Less prep">−</button><output data-effort>${T.hours(it.effortMin || 0)}</output><button type="button" data-step="30" aria-label="More prep">+</button></div></div>
        ${it.doneMin ? `<div class="m">${T.hours(it.doneMin)} already done</div>` : ''}
        <label class="field"><span class="m">Don't start before (optional)</span><input class="input" type="date" name="startBy" value="${toDate(it.startBy)}"></label>
        ${it.type === 'exam' ? `<label class="field"><span class="m">Topics (comma separated)</span><input class="input" name="topics" value="${esc((it.topics || []).join(', '))}"></label>` : ''}` : ''}
      ${it.type === 'event' ? `
        <label class="field"><span class="m">Day</span><input class="input" type="date" name="d1" value="${toDate(it.start)}"></label>
        <div class="row"><label class="field"><span class="m">Starts</span><input class="input" type="time" name="t1" value="${toTime(it.start)}"></label>
        <label class="field"><span class="m">Ends</span><input class="input" type="time" name="t2" value="${toTime(it.end)}"></label></div>` : ''}
      ${it.type === 'routine' ? `
        <div class="field"><span class="m">When</span><div class="seg" role="group" aria-label="When">${ANCHORS.map(([k, l]) => `<button type="button" data-anchor="${k}" aria-pressed="${r.anchor === k}">${l}</button>`).join('')}</div></div>
        ${r.anchor === 'time' || r.anchor === 'daytime' ? `<label class="field"><span class="m">${r.anchor === 'time' ? 'At' : 'Around (optional)'}</span><input class="input" type="time" name="at" value="${r.atMin != null ? `${String(Math.floor(r.atMin / 60)).padStart(2, '0')}:${String(r.atMin % 60).padStart(2, '0')}` : ''}"></label>` : ''}
        <label class="field"><span class="m">Little note (shows in the guided flow)</span><input class="input" name="detail" value="${esc(r.detail || '')}" placeholder="with water"></label>
        <div class="field"><span class="m">How long</span><div class="stepper"><button type="button" data-dur="-1" aria-label="Shorter">−</button><output data-dur-out>${r.durMin || 2} min</output><button type="button" data-dur="1" aria-label="Longer">+</button></div></div>
        <div class="field"><span class="m">Repeats</span><div class="seg" role="group" aria-label="Repeats">
          <button type="button" data-rec="daily" aria-pressed="${rec.freq === 'daily' && (rec.interval || 1) === 1}">Every day</button>
          <button type="button" data-rec="alt" aria-pressed="${rec.freq === 'daily' && rec.interval === 2}">Every other day</button>
          <button type="button" data-rec="weekly" aria-pressed="${rec.freq === 'weekly'}">Some days</button></div></div>
        ${rec.freq === 'weekly' ? `<div class="seg" role="group" aria-label="Days">${WD.map((d, i) => `<button type="button" data-day="${i}" aria-pressed="${days.includes(i)}" aria-label="${T.weekdayName(i)}">${d}</button>`).join('')}</div>` : ''}
        <label class="field"><span class="m">Until (optional)</span><input class="input" type="date" name="until" value="${esc(rec.until || '')}"></label>
        ${!isNew ? `<div class="row"><button type="button" class="btn btn-ghost btn-sm" data-move="-1">↑ Earlier in group</button><button type="button" class="btn btn-ghost btn-sm" data-move="1">↓ Later in group</button></div>` : ''}` : ''}
      <label class="field"><span class="m">Notes</span><textarea class="textarea" name="notes" rows="2">${esc(it.notes || '')}</textarea></label>
      <div class="sheet-actions">
        <button type="submit" class="btn btn-primary">${isNew ? 'Add it' : 'Save'}</button>
        ${!isNew ? '<button type="button" class="btn btn-text" data-delete>Delete</button>' : ''}
      </div>`;
    wire(s, f);
  }

  function readFields(f) {
    const v = (n) => (f.elements[n] ? f.elements[n].value : '');
    it.title = v('title').trim();
    if (it.type === 'exam') it.start = isoAt(v('d1'), v('t1') || '09:00');
    if (it.type === 'assignment' || it.type === 'project') it.due = isoAt(v('d1'), v('t1') || '23:59');
    if (['exam', 'assignment', 'project'].includes(it.type)) {
      it.startBy = v('startBy') ? isoAt(v('startBy'), '00:00') : '';
      if (f.elements.topics) it.topics = v('topics').split(',').map((x) => x.trim()).filter(Boolean);
    }
    if (it.type === 'event') { it.start = isoAt(v('d1'), v('t1') || '09:00'); it.end = isoAt(v('d1'), v('t2') || v('t1') || '10:00'); if (it.end <= it.start) it.end = T.iso(new Date(new Date(it.start).getTime() + 3600000)); }
    if (it.type === 'routine') {
      const r = it.routine;
      if (f.elements.at) r.atMin = v('at') ? minOf(v('at')) : (r.anchor === 'time' ? 480 : undefined);
      r.detail = v('detail').trim();
      r.recur.until = v('until') || '';
      r.group = r.anchor === 'time' ? groupOf({ routine: { anchor: 'time', atMin: r.atMin } }) : r.anchor;
    }
    it.notes = v('notes');
  }

  function wire(s, f) {
    f.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b || b.type === 'submit') return;
      readFields(f);
      if (b.dataset.type) { it.type = b.dataset.type; defaults(it.type); return render(s); }
      if (b.dataset.step) { it.effortMin = Math.max(30, (it.effortMin || 0) + Number(b.dataset.step)); f.querySelector('[data-effort]').textContent = T.hours(it.effortMin); return; }
      if (b.dataset.dur) { it.routine.durMin = Math.max(1, Math.min(120, (it.routine.durMin || 2) + Number(b.dataset.dur) * ((it.routine.durMin || 2) >= 10 ? 5 : 1))); f.querySelector('[data-dur-out]').textContent = `${it.routine.durMin} min`; return; }
      if (b.dataset.anchor) { it.routine.anchor = b.dataset.anchor; return render(s); }
      if (b.dataset.rec) {
        const r = it.routine.recur;
        if (b.dataset.rec === 'daily') Object.assign(r, { freq: 'daily', interval: 1, days: [] });
        if (b.dataset.rec === 'alt') Object.assign(r, { freq: 'daily', interval: 2, days: [] });
        if (b.dataset.rec === 'weekly') Object.assign(r, { freq: 'weekly', interval: 1, days: r.days && r.days.length ? r.days : [1, 2, 3, 4, 5] });
        return render(s);
      }
      if (b.dataset.day) {
        const d = Number(b.dataset.day), r = it.routine.recur;
        r.days = r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort();
        b.setAttribute('aria-pressed', String(r.days.includes(d)));
        return;
      }
      if (b.dataset.move) {
        const sib = groupItems(groupOf(it)).map((x) => x.id);
        const i = sib.indexOf(it.id), j = i + Number(b.dataset.move);
        if (i < 0 || j < 0 || j >= sib.length) return;
        [sib[i], sib[j]] = [sib[j], sib[i]];
        await reorderRoutines(sib);
        toast('Order updated.');
        return;
      }
      if (b.hasAttribute('data-doodle')) {
        const res = await openPicker({ current: it.doodle, color: itemHex(it), from: b });
        if (!res) return;
        if (res.source === 'auto') { it.doodleSource = 'auto'; it.doodle = call('matchDoodle', { title: it.title, type: it.type }).doodle; }
        else { it.doodleSource = 'user'; it.doodle = res.doodle; }
        const old = b.querySelector('svg');
        await erase(old, { duration: 160 });
        b.innerHTML = doodleSVG(it.doodle, 40, it.type === 'routine' ? '#111' : itemHex(it), { boil: false });
        drawOn(b, { duration: 420 });
        return;
      }
      if (b.hasAttribute('data-delete')) {
        const ok = await confirmSheet({ title: `Delete ${it.title}?`, text: 'Its future blocks disappear from your plan. Finished work stays in your history.', yes: 'Delete', no: 'Keep it' });
        if (ok) { await deleteItem(it.id); s.close(); toast(`${it.title} deleted.`); }
      }
    };
    f.querySelector('[name="title"]').addEventListener('input', (e) => {
      if (it.doodleSource === 'user') return;
      const d = call('matchDoodle', { title: e.target.value, type: it.type }).doodle;
      if (d === it.doodle) return;
      it.doodle = d;
      const b = f.querySelector('[data-doodle]');
      b.innerHTML = doodleSVG(d, 40, it.type === 'routine' ? '#111' : itemHex(it), { boil: false });
      drawOn(b, { duration: 380 });
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      readFields(f);
      if (!it.title) { f.elements.title.focus(); toast('Give it a little name first.'); return; }
      if (it.type === 'routine' && it.routine.recur.freq === 'weekly' && !(it.routine.recur.days || []).length) { toast('Pick at least one day.'); return; }
      for (const k of ['start', 'end', 'due', 'startBy']) if (!it[k]) delete it[k];
      if (it.type !== 'routine') delete it.routine;
      if (isNew) {
        if (it.type === 'routine') it.routine.order = groupItems(it.routine.group || it.routine.anchor).length;
        await addItem(it);
        toast(`${it.title} added.`);
      } else {
        await updateItem(it);
        toast('Saved.');
      }
      s.close();
    };
  }
  return sheet;
}
