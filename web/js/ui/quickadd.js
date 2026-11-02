// Quick add: one field, live parse into chips + a cross-drawing doodle preview.
import { S, addItem } from '../state.js';
import { call } from '../bridge.js';
import * as T from '../time.js';
import { doodleSVG } from '../doodle.js';
import { set, to, drawOn, erase, motion } from '../anim.js';
import { esc, itemHex, announce, toast } from '../dom.js';
import { all } from '../copy.js';
import { burst } from '../fx.js';
import { pop } from '../sound.js';
import { openSheet } from './sheet.js';

const TYPE_LABEL = { exam: 'Exam', assignment: 'Assignment', project: 'Project', event: 'Event', routine: 'Routine' };

export function openQuickAdd({ text = '', from = null } = {}) {
  const hints = all('quickAddHint');
  const hint = hints[Math.floor(T.nowMs() / 86400000) % hints.length];
  let result = null;
  let shownDoodle = '';
  const sheet = openSheet({
    title: 'Quick add',
    from,
    seed: 'qa',
    body: `
      <label class="sr-only" for="qa-input">What's coming up?</label>
      <input id="qa-input" class="input" data-qa autocomplete="off" autocapitalize="sentences" enterkeyhint="done" placeholder="${esc(hint)}" value="${esc(text)}" autofocus>
      <div class="qa-preview" aria-live="polite">
        <div class="qa-doodle" data-tile style="background:#111"></div>
        <div class="chips" data-chips></div>
      </div>
      <p class="m qa-hint" data-note>Try: “${esc(hint)}”</p>
      <div class="sheet-actions">
        <button class="btn btn-primary" data-save disabled>Save</button>
        <button class="btn btn-text" data-form>Fill in a form instead</button>
      </div>`,
    onMount: (s) => {
      const input = s.el.querySelector('[data-qa]');
      const chips = s.el.querySelector('[data-chips]');
      const tile = s.el.querySelector('[data-tile]');
      const save = s.el.querySelector('[data-save]');
      const note = s.el.querySelector('[data-note]');
      let timer = 0;
      const parse = () => {
        const txt = input.value.trim();
        if (!txt) { result = null; renderChips([]); setDoodle(''); save.disabled = true; note.textContent = `Try: “${hint}”`; return; }
        try { result = call('parseQuickAdd', { text: txt, now: T.iso(T.now()), tz: S.profile.tz }); } catch (e) { result = null; return; }
        const it = result.item;
        renderChips(result.understood.filter((u) => u.field !== 'doodle' && u.field !== 'title'));
        setDoodle(it.doodle, it);
        const usable = result.confidence === 'high' || it.type === 'routine' || (it.title && (it.start || it.due));
        save.disabled = !it.title;
        save.textContent = usable ? `Save ${TYPE_LABEL[it.type].toLowerCase()}` : 'Save as…';
        note.textContent = usable ? `“${it.title}”${it.type === 'routine' ? ' joins your routines.' : ' gets planned around your day.'}` : "Not sure about the when. Saving opens the form so you can check.";
      };
      const renderChips = (list) => {
        const want = list.map((u) => `${u.field}|${u.value}`);
        const have = new Map([...chips.children].map((c) => [c.dataset.key, c]));
        // remove stale chips
        for (const [k, c] of have) if (!want.includes(k)) { have.delete(k); to(c, { scale: 0.6, opacity: 0 }, 'snappy').then(() => c.remove()); }
        // add new chips in order with a springy pop
        list.forEach((u, i) => {
          const k = want[i];
          if (have.has(k)) return;
          const c = document.createElement('button');
          c.type = 'button';
          c.className = 'chip';
          c.dataset.key = k;
          c.innerHTML = `<b>${esc(u.field)}</b> ${esc(u.value)}`;
          c.setAttribute('aria-label', `${u.field}: ${u.value}. Tap to edit.`);
          chips.appendChild(c);
          if (!motion.reduced) { set(c, { scale: 0.4, opacity: 0, y: 6 }); setTimeout(() => to(c, { scale: 1, opacity: 1, y: 0 }, 'bouncy'), i * 40); }
        });
      };
      const setDoodle = async (name, it) => {
        tile.style.background = it ? itemHex(it) + (it.type === 'routine' ? '' : '') : '#111';
        if (it && it.type !== 'routine') tile.style.background = '#000';
        tile.style.boxShadow = it && it.type !== 'routine' ? `inset 0 0 0 2px ${itemHex(it)}` : 'none';
        if (name === shownDoodle) return;
        shownDoodle = name;
        const old = tile.querySelector('svg.doodle');
        const color = it && it.type !== 'routine' ? itemHex(it) : '#111';
        if (old) {
          old.removeAttribute('data-boil');
          erase(old, { duration: 200 }).then(() => old.remove());
        }
        if (name) {
          tile.insertAdjacentHTML('beforeend', doodleSVG(name, 44, color, { boil: false }));
          drawOn(tile.lastElementChild, { delay: old ? 120 : 0, duration: 460, stagger: 50 });
        }
      };
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(parse, 90); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !save.disabled) { e.preventDefault(); save.click(); } });
      chips.addEventListener('click', () => openForm());
      s.el.querySelector('[data-form]').addEventListener('click', () => openForm());
      save.addEventListener('click', async () => {
        if (!result) return;
        const it = result.item;
        const usable = result.confidence === 'high' || it.type === 'routine' || (it.title && (it.start || it.due));
        if (!usable) return openForm();
        save.disabled = true;
        const r = tile.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, { count: 8, seed: it.title });
        pop(1.15);
        const added = await addItem({ ...it, id: '' });
        s.close();
        const placed = S.plan.blocks.some((block) => block.itemId === added.id);
        toast(`${added.title} added.${added.type === 'routine' ? '' : placed ? ' It now has blocks on your arc.' : ' Review the proposed block changes to place it.'}`);
        announce(`${added.title} added`);
      });
      async function openForm() {
        const base = result ? { ...result.item, id: '' } : { type: 'assignment', title: input.value.trim() };
        s.close();
        const { openEditor } = await import('./editor.js');
        openEditor(base, { isNew: true });
      }
      if (text) parse();
    },
  });
  return sheet;
}
