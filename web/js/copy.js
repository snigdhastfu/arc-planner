// Copy bank: warm, quirky, never guilt. Picks are deterministic per day (and
// per item) so text does not flicker between renders.
import { hash } from './rough.js';

const BANK = {
  greeting: ['Hey you', 'Hi there', 'Hello, star', 'Morning, legend', 'Oh hey'],
  greetingEvening: ['Evening, you', 'Hey night owl', 'Soft evening'],
  drift: ['Your day got interesting · new plan?', 'Plans wiggled · peek at a new one?', 'Things shifted · want a fresh plan?'],
  nothingNow: ['Nothing on right now. Breathe.', 'Free air. Enjoy it.', 'A gap! Stretch, sip, wander.'],
  allClear: ['Nothing planned. A blank page is a nice page.', 'All clear. Add something with the + when you like.', 'Wide open skies today.'],
  finished: ['Done and dusted.', 'Stamped. Lovely work.', 'That one is in the bag.', 'Look at you go.'],
  snoozed: ['Snoozed for 15. No rush.', 'Fifteen more minutes, granted.', 'Pushed back a smidge.'],
  sleepingIn: ['Sleeping in until tomorrow.', 'Tucked away for later.', 'Resting this one. Totally fine.'],
  tuckedIn: ["Tucked in. Good day's work.", 'Day folded neatly. Sleep well.', 'Postcard sent to future you.'],
  routineDone: {
    pill: ['Pill bottle: opened. You: a legend.', 'Meds: handled. Body: grateful.', 'Tiny pill, big win.'],
    cream: ['Cream: applied. Skin: thrilled.', 'Moisture levels: excellent.', 'Glow mode: on.'],
    water: ['Hydration achieved.', 'Glug glug, hooray.', 'Your cells say thanks.'],
    bed: ['Bed made. Very fancy.', 'Hotel-level bed. Nice.', 'Pillows fluffed, world better.'],
    clock: ['Up and at it.', 'Good morning, early bird.', 'Awake! The best first step.'],
    apple: ['Fuel: acquired.', 'Snack: secured.', 'Crunch. Lovely.'],
    moon: ['Winding down nicely.', 'Soft lights, soft mind.', 'Night mode engaged.'],
    book: ['Brain: fed.', 'Pages turned. Smart cookie.', 'A little study goes a long way.'],
    laptop: ['Plan for tomorrow: sorted.', 'Future you says thanks.', 'Laptop closed, mind clear.'],
    sun: ['Sunshine absorbed.', 'Vitamin D, delivered.', 'Bright move.'],
    dumbbell: ['Muscles: moved.', 'Strong stuff.', 'Sweat equity earned.'],
    mug: ['Cozy cup moment.', 'Sip sip hooray.', 'Warm hands, warm heart.'],
    plant: ['Plants: thriving.', 'Green thumbs up.', 'Leafy friends say hi.'],
    default: ['Nice one.', 'Tiny win, big smile.', 'Checked off with style.'],
  },
  routinesAllDone: ['Done for the day. Go be a person.', 'Every routine stamped. Hero status.', 'Full set! Take a bow.'],
  emptyRoutines: ['No routines yet. Little habits live here: meds, cream, making the bed.', 'Nothing here yet. Try "cream every night" with the + button.'],
  emptyHorizon: ['The horizon is clear. Add an exam or project and it shows up here.', 'Nothing on the radar. Smooth sailing.'],
  emptyReview: ['Nothing to review. Your plan is happy as it is.', 'All calm. No changes needed.'],
  reviewIntro: ['Nothing moves until you say so.'],
  quickAddHint: ['chem exam nov 20, want 12h prep', 'cream every night after shower', 'dentist tomorrow 4pm', 'stats assignment due fri 3h', 'vitamin d morning with food'],
  loading: ['Sharpening pencils…', 'Uncapping markers…', 'Fluffing the clouds…'],
  approved: ['New plan, fresh start.', 'Plan updated. Onward.', 'All set. Nice and tidy.'],
  undone: ['Back the way it was.', 'Undone. No harm done.'],
};

export function dayKeyOf(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** pick('finished', salt) -> deterministic by today's day key + salt. */
export function pick(key, salt = '', day = dayKeyOf()) {
  const list = key.includes('.') ? key.split('.').reduce((o, k) => (o ? o[k] : undefined), BANK) : BANK[key];
  const arr = Array.isArray(list) ? list : (list && list.default) || [''];
  return arr[hash(`${day}|${key}|${salt}`) % arr.length];
}
export function routineLine(doodle, salt = '') {
  const arr = BANK.routineDone[doodle] || BANK.routineDone.default;
  return arr[hash(`${dayKeyOf()}|${doodle}|${salt}`) % arr.length];
}
export const all = (key) => BANK[key];
