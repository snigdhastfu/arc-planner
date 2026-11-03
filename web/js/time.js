// Time helpers. Everything displayed is in the profile's IANA zone.
// `?now=<ISO>` in the URL freezes the start of the clock (used by e2e tests
// and screenshots); time still ticks forward from there.

let offsetMs = 0;
try {
  const p = new URLSearchParams(location.search).get('now');
  if (p) { const t = Date.parse(p); if (!Number.isNaN(t)) offsetMs = t - Date.now(); }
} catch (_) { /* ignore */ }

let TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } })();
export const deviceTZ = TZ;
export function setTZ(tz) { if (tz) { TZ = tz; fmts.clear(); } }
export const tz = () => TZ;

export const now = () => new Date(Date.now() + offsetMs);
export const nowMs = () => Date.now() + offsetMs;
export const clockFrozen = () => offsetMs !== 0;

/** RFC3339 in UTC without milliseconds (Go parses it exactly). */
export function iso(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

const fmts = new Map();
function fmt(opts) {
  const k = JSON.stringify(opts);
  if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }));
  return fmts.get(k);
}
/** Wall-clock parts in the profile zone. */
export function parts(d) {
  const o = {};
  for (const p of fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(d))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
export function dayKey(d = now()) {
  const p = parts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
export function minOfDay(d = now()) { const p = parts(d); return p.hh * 60 + p.mm; }
export function scheduleDayKey(d, wakeMin) {
  const key = dayKey(d);
  return minOfDay(d) < wakeMin ? addDays(key, -1) : key;
}
export function scheduleMinute(d, wakeMin) {
  const key = scheduleDayKey(d, wakeMin);
  return daysBetween(key, dayKey(d)) * 1440 + minOfDay(d);
}

/** The instant for a wall-clock time on a day key in the profile zone. */
export function at(dayKeyStr, min) {
  const [y, m, d] = dayKeyStr.split('-').map(Number);
  // start from the UTC guess, then correct by the zone offset (twice for DST edges)
  let t = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60);
  for (let i = 0; i < 2; i++) {
    const p = parts(t);
    const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    t += Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60) - asUTC;
  }
  return new Date(t);
}
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
export function weekdayOf(key) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const weekdayName = (i) => WD[i];
export const weekdayShort = (i) => WD[i].slice(0, 3);
export const weekdayLetter = (i) => WD[i][0];
export const monthShort = (i) => MON[i].slice(0, 3);

/** "Tuesday 3 November" */
export function longDate(d = now()) { const p = parts(d); return `${WD[p.wd]} ${p.d} ${MON[p.m - 1]}`; }
/** "Fri 6 Nov" */
export function shortDate(d) { const p = parts(d); return `${WD[p.wd].slice(0, 3)} ${p.d} ${MON[p.m - 1].slice(0, 3)}`; }
export function shortDateKey(key) { const [y, m, d] = key.split('-').map(Number); return `${WD[weekdayOf(key)].slice(0, 3)} ${d} ${MON[m - 1].slice(0, 3)}`; }
/** "4 pm", "9:30 am" */
export function clock(d) { const p = parts(d); return clockMin(p.hh * 60 + p.mm); }
export function clockMin(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`;
}
/** "Today 4 pm", "Tonight 8 pm", "Wed 9:30 am", "Tomorrow 9 am" */
export function relWhen(d) {
  const k = dayKey(d), today = dayKey();
  const diff = daysBetween(today, k);
  const p = parts(d);
  if (diff === 0) return `${p.hh >= 18 ? 'Tonight' : 'Today'} ${clock(d)}`;
  if (diff === 1) return `Tomorrow ${clock(d)}`;
  if (diff > 1 && diff < 7) return `${weekdayShort(p.wd)} ${clock(d)}`;
  return `${shortDate(d)} ${clock(d)}`;
}
/** "Due Fri", "Due tomorrow", "Due 20 Nov" */
export function dueText(d, prefix = 'Due') {
  const diff = daysBetween(dayKey(), dayKey(d));
  const p = parts(d);
  if (diff < 0) return `${prefix} ${shortDate(d)}`;
  if (diff === 0) return `${prefix} today`;
  if (diff === 1) return `${prefix} tomorrow`;
  if (diff < 7) return `${prefix} ${weekdayShort(p.wd)}`;
  return `${prefix} ${p.d} ${MON[p.m - 1].slice(0, 3)}`;
}
export const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
/** "4 h", "4.5 h", "45 min" */
export function hours(min) {
  if (min < 60) return `${Math.round(min)} min`;
  return `${Math.round((min / 60) * 10) / 10} h`;
}
export function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
