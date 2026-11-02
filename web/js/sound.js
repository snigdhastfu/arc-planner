// Tiny WebAudio-synthesised sounds. Off by default; no audio files.
let ctx = null;
let enabled = false;

export function setSound(on) { enabled = !!on; if (on) ensure(); }
export const soundOn = () => enabled;

function ensure() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function env(g, t, a, d, peak) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

/** A soft bubbly pop. pitch multiplies the base frequency. */
export function pop(pitch = 1) {
  if (!enabled || !ensure()) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(520 * pitch, t);
  o.frequency.exponentialRampToValueAtTime(980 * pitch, t + 0.08);
  env(g, t, 0.01, 0.14, 0.18);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.2);
}

/** A short pencil scratch: band-passed noise. */
export function scratch() {
  if (!enabled || !ensure()) return;
  const t = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * 0.18);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < len; i++) { seed = (seed * 16807) % 2147483647; data[i] = ((seed / 2147483647) * 2 - 1) * (1 - i / len); }
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = buf;
  bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 1.4;
  env(g, t, 0.01, 0.16, 0.12);
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
}

/** A little three-note chime for celebrations. */
export function chime() {
  if (!enabled || !ensure()) return;
  [0, 0.09, 0.18].forEach((dt, i) => {
    const t = ctx.currentTime + dt;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = [660, 830, 990][i];
    env(g, t, 0.01, 0.3, 0.12);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.35);
  });
}

/** Gentle haptic where supported (navigator.vibrate does not exist on iOS). */
export function buzz(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) { /* ignore */ }
}
