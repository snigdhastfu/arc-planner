// First run: wake/sleep -> energy windows -> daily goal, then fresh or sample.
import { S, setProfile, setMeta, loadSample, defaultProfile } from '../state.js';
import * as T from '../time.js';
import { doodleSVG } from '../doodle.js';
import { drawOn, set, to, motion } from '../anim.js';
import { esc, toast } from '../dom.js';
import { burst } from '../fx.js';
import { pop } from '../sound.js';
import { openSheet } from './sheet.js';

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + (m || 0); };
const LV = ['high', 'med', 'low'];
const BLOCKS = [['Early morning', 'morning'], ['Late morning', 'late'], ['Afternoon', 'afternoon'], ['Evening', 'evening'], ['Night', 'night']];

export function openOnboarding() {
  let step = 0;
  const p = { ...defaultProfile(), ...(S.profile || {}), tz: (S.profile && S.profile.tz) || T.deviceTZ };
  const parts = { morning: 'med', late: 'high', afternoon: 'low', evening: 'high', night: 'low' };
  openSheet({
    label: 'Welcome to Arc',
    seed: 'onb',
    tall: true,
    body: '<div class="onb" data-onb></div>',
    onMount: (s) => {
      const box = s.el.querySelector('[data-onb]');
      const draw = () => {
        const art = { 0: ['clock', '#FDDEB2'], 1: ['sun', '#7CBB93'], 2: ['book', '#B3D7F2'], 3: ['sparkle', '#F7C8D3'] }[step];
        box.innerHTML = `
          <div class="onb-dots" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<span class="${i === step ? 'on' : ''}"></span>`).join('')}</div>
          <div class="onb-art">${doodleSVG(art[0], 104, art[1])}</div>
          ${[stepDay, stepEnergy, stepGoal, stepStart][step]()}
          <div class="sheet-actions">
            ${step < 3 ? `<button class="btn btn-primary" data-next>${step === 2 ? 'Looks good' : 'Next'}</button><button class="btn btn-text" data-skip>Skip for now</button>` : ''}
          </div>`;
        drawOn(box.querySelector('.onb-art'), { duration: 900, stagger: 120 });
        if (!motion.reduced) { const c = box.querySelector('.onb-step'); set(c, { x: 30, opacity: 0 }); to(c, { x: 0, opacity: 1 }, 'gentle'); }
      };
      const stepDay = () => `<div class="onb-step"><h2 class="sheet-title">Hello! When does your day run?</h2>
        <p class="m sheet-text">Arc plans around you, never the other way round.</p>
        <label class="field"><span class="m">What should Arc call you? (optional)</span><input class="input" type="text" data-name maxlength="40" value="${esc(p.name || '')}" autocomplete="given-name" placeholder="Your name"></label>
        <div class="row"><label class="field"><span class="m">I wake up</span><input class="input" type="time" data-w value="${hhmm(p.wakeMin)}"></label>
        <label class="field"><span class="m">Lights out</span><input class="input" type="time" data-s value="${hhmm(p.sleepMin)}"></label></div></div>`;
      const stepEnergy = () => `<div class="onb-step"><h2 class="sheet-title">When do you feel sharpest?</h2>
        <p class="m sheet-text">Tap to cycle: peak, okay, low. Big work goes to peaks.</p>
        <div class="seg" style="flex-direction:column">${BLOCKS.map(([l, k]) => `<button type="button" data-part="${k}" class="row" style="justify-content:space-between;width:100%" aria-label="${l}: ${parts[k]}"><span>${l}</span><span class="lvl-${parts[k]}" style="padding:4px 10px;border-radius:10px;color:var(--ink)">${{ high: 'peak', med: 'okay', low: 'low' }[parts[k]]}</span></button>`).join('')}</div></div>`;
      const stepGoal = () => `<div class="onb-step"><h2 class="sheet-title">How much focused work a day?</h2>
        <p class="m sheet-text">A comfy goal. Busy days can stretch a little, and Arc will say so.</p>
        <div class="stepper" style="justify-content:center"><button type="button" data-g="-30" aria-label="Less">−</button><output data-gout style="font-size:28px">${T.hours(p.ambitionMin)}</output><button type="button" data-g="30" aria-label="More">+</button></div></div>`;
      const stepStart = () => `<div class="onb-step"><h2 class="sheet-title">All set. How would you like to start?</h2>
        <p class="m sheet-text">Start with a blank planner, or explore a marked sample week. You can remove sample data any time in Settings.</p>
        <div class="sheet-actions"><button class="btn btn-primary" data-empty>Start fresh</button><button class="btn btn-ghost" data-sample>Show me a sample week</button></div></div>`;
      const energy = () => {
        const w = p.wakeMin, sl = p.sleepMin;
        const cuts = [w, Math.min(w + 150, sl), Math.min(12 * 60 + 30, sl), Math.min(16 * 60, sl), Math.min(20 * 60, sl), sl];
        const keys = BLOCKS.map((b) => b[1]);
        const out = [];
        for (let i = 0; i < 5; i++) if (cuts[i + 1] > cuts[i]) out.push({ startMin: cuts[i], endMin: cuts[i + 1], level: parts[keys[i]] });
        return out;
      };
      const finish = async (sample) => {
        await setProfile({ ...p, name: (p.name || '').trim(), energy: energy() }, { rebuild: false });
        if (sample) await loadSample();
        await setMeta('onboarded', true);
        const r = s.el.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + 80, { count: 14, seed: 'welcome' });
        pop(1.2);
        s.close();
        toast(sample ? 'Sample week loaded. Poke around!' : 'A blank page. Tap + whenever you like.');
      };
      box.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.part) { parts[b.dataset.part] = LV[(LV.indexOf(parts[b.dataset.part]) + 1) % 3]; pop(1); draw(); box.querySelector(`[data-part="${b.dataset.part}"]`).focus(); return; }
        if (b.dataset.g) { p.ambitionMin = Math.max(30, Math.min(600, p.ambitionMin + Number(b.dataset.g))); box.querySelector('[data-gout]').textContent = T.hours(p.ambitionMin); return; }
        if (b.hasAttribute('data-next')) {
          if (step === 0) {
            p.name = box.querySelector('[data-name]').value.trim().slice(0, 40);
            const w = toMin(box.querySelector('[data-w]').value || '07:00'), sl = toMin(box.querySelector('[data-s]').value || '23:00');
            if (sl <= w + 120) { toast('Leave at least two hours between waking and lights out.'); return; }
            p.wakeMin = w; p.sleepMin = sl;
          }
          step++; draw(); return;
        }
        if (b.hasAttribute('data-skip')) { step = 3; draw(); return; }
        if (b.hasAttribute('data-sample')) return finish(true);
        if (b.hasAttribute('data-empty')) return finish(false);
      });
      draw();
    },
  });
}
