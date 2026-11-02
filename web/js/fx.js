// Moments of delight: sparkle bursts, ink stamps, floating doodles, showers.
// Doodles are rendered from the reference set unchanged; only moved/faded.
import { set, to, tween, motion, drawOn, wiggle, hop, spin } from './anim.js';
import { doodleSVG } from './doodle.js';
import { roughCircle, rng } from './rough.js';

const layer = () => document.getElementById('layer');

function fxNode(html, x, y, owner = '') {
  const el = document.createElement('div');
  el.className = 'fx';
  if (owner) el.dataset.fxOwner = owner;
  el.innerHTML = html;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  layer().appendChild(el);
  return el;
}

/** A burst of sparkles and tiny doodle fragments from a point. */
export function burst(x, y, { colors = ['#FFF7E6', '#FDDEB2', '#7CBB93', '#F7C8D3'], count = 10, seed = 'b', doodles = ['sparkle'], owner = '' } = {}) {
  if (motion.reduced) return;
  const R = rng(seed + x + y);
  for (let i = 0; i < count; i++) {
    const c = colors[i % colors.length];
    const frag = i % 3 === 2;
    const size = frag ? 10 : 14 + R() * 10;
    const html = frag
      ? `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 10 C4 6 7 4 10 2" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`
      : doodleSVG(doodles[i % doodles.length], size, c, { boil: false, draw: false });
    const el = fxNode(html, x - size / 2, y - size / 2, owner);
    const a = (i / count) * Math.PI * 2 + R() * 0.6;
    const dist = 50 + R() * 60;
    set(el, { scale: 0.3, opacity: 1, rotate: R() * 90 - 45 });
    to(el, { x: Math.cos(a) * dist, y: Math.sin(a) * dist - 20, scale: 1, rotate: R() * 180 - 90 }, { stiffness: 120, damping: 14 });
    setTimeout(() => to(el, { opacity: 0, y: Math.sin(a) * dist + 10 }, 'gentle').then(() => el.remove()), 420 + R() * 200);
  }
}

/** An ink stamp that slams onto an element: a wobbly ring with a check. */
export function stamp(host, { color = '#7CBB93', label = 'Done', seed = 'stamp', size = 110, owner = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'stamp';
  if (owner) el.dataset.fxOwner = owner;
  el.setAttribute('aria-hidden', 'true');
  const ring = roughCircle(size / 2, size / 2, size / 2 - 6, seed, { jitter: 1.4, turns: 1.08 });
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <path d="${ring}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
    <path d="M${size * 0.3} ${size * 0.52} l${size * 0.13} ${size * 0.13} l${size * 0.27} ${size * -0.3}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg><span style="color:${color}">${label}</span>`;
  host.appendChild(el);
  if (motion.reduced) { el.style.opacity = '1'; return el; }
  set(el, { scale: 2.4, opacity: 0, rotate: -24 });
  to(el, { scale: 1, opacity: 1, rotate: -12 }, { stiffness: 520, damping: 18 });
  return el;
}

/** Stamped check bounce on a small badge element. */
export function checkBounce(el) {
  if (!el || motion.reduced) return;
  set(el, { scale: 0.2, rotate: -30 });
  to(el, { scale: 1, rotate: 0 }, { stiffness: 420, damping: 12 });
}

/** A doodle that drifts away (moon floats up, clock spins). */
export function floatDoodle(name, x, y, { color = '#F7C8D3', size = 72, dir = 'up', owner = '' } = {}) {
  const el = fxNode(doodleSVG(name, size, color, { boil: false }), x - size / 2, y - size / 2, owner);
  if (motion.reduced) { tween({ from: 1, to: 0, duration: 600, onUpdate: (v) => { el.style.opacity = String(v); }, onDone: () => el.remove() }); return; }
  drawOn(el, { duration: 380, stagger: 40 });
  if (dir === 'up') {
    set(el, { y: 20, opacity: 0, scale: 0.8 });
    to(el, { y: -10, opacity: 1, scale: 1 }, 'gentle');
    setTimeout(() => to(el, { y: -160, opacity: 0, rotate: -12 }, { stiffness: 40, damping: 12 }).then(() => el.remove()), 520);
  } else if (dir === 'spin') {
    set(el, { scale: 0.6, opacity: 0 });
    to(el, { scale: 1, opacity: 1 }, 'bouncy');
    setTimeout(() => spin(el.firstElementChild), 80);
    setTimeout(() => to(el, { opacity: 0, x: -60 }, 'gentle').then(() => el.remove()), 900);
  }
}

export function clearFx(owner) {
  document.querySelectorAll(`[data-fx-owner="${owner}"]`).forEach((el) => el.remove());
}

/** Celebratory shower of doodles falling from the top. */
export function shower(names, { count = 18, colors = ['#FDDEB2', '#FFF7E6', '#F7C8D3', '#B3D7F2', '#7CBB93'] } = {}) {
  if (motion.reduced) return;
  const W = innerWidth;
  const R = rng('shower' + count + names.join());
  for (let i = 0; i < count; i++) {
    const size = 26 + R() * 22;
    const el = fxNode(doodleSVG(names[i % names.length], size, colors[i % colors.length], { boil: false, draw: false }), R() * (W - size), -size - 10);
    set(el, { rotate: R() * 60 - 30, opacity: 1 });
    setTimeout(() => {
      to(el, { y: innerHeight * (0.55 + R() * 0.4), rotate: R() * 120 - 60 }, { stiffness: 18 + R() * 10, damping: 6 });
      setTimeout(() => to(el, { opacity: 0 }, 'gentle').then(() => el.remove()), 1500 + R() * 600);
    }, i * 60);
  }
}

/** A silly reaction for a tapped doodle, chosen deterministically per doodle. */
export function react(el, name) {
  const pickers = [wiggle, hop, spin];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  pickers[h % 3](el);
}
