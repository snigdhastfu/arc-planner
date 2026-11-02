// Tiny spring-physics motion engine.
// One shared requestAnimationFrame loop that sleeps when idle and pauses while
// the tab is hidden. Only transform, opacity and SVG stroke-dashoffset move.

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export const motion = {
  prefersReduced: !!(mq && mq.matches),
  setting: 'full', // 'full' | 'gentle'
  get reduced() { return this.prefersReduced || this.setting === 'gentle'; },
  listeners: new Set(),
  set(level) { this.setting = level; this.listeners.forEach((f) => f()); },
};
if (mq && mq.addEventListener) mq.addEventListener('change', (e) => { motion.prefersReduced = e.matches; motion.listeners.forEach((f) => f()); });

// ---- the loop --------------------------------------------------------------
const active = new Set(); // things with step(dt) -> boolean (true = keep going)
let raf = 0;
let last = 0;
export const stats = { frames: 0, long: 0, worst: 0 };

function frame(t) {
  raf = 0;
  const dt = Math.min(0.064, last ? (t - last) / 1000 : 1 / 60);
  if (last) {
    const ms = t - last;
    stats.frames++;
    if (ms > 20) stats.long++;
    if (ms > stats.worst) stats.worst = ms;
  }
  last = t;
  for (const a of [...active]) {
    let keep = false;
    try { keep = a.step(dt, t); } catch (e) { console.error(e); }
    if (!keep) active.delete(a);
  }
  if (active.size && !document.hidden) raf = requestAnimationFrame(frame);
  else last = 0;
}
function wake() { if (!raf && !document.hidden && active.size) raf = requestAnimationFrame(frame); }
export function run(thing) { active.add(thing); wake(); return thing; }
export function stop(thing) { active.delete(thing); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = 0; wake(); } });

// ---- springs ---------------------------------------------------------------
export const presets = {
  gentle: { stiffness: 120, damping: 20 },
  snappy: { stiffness: 380, damping: 32 },
  bouncy: { stiffness: 300, damping: 14 },
  wobbly: { stiffness: 180, damping: 10 },
  stiff: { stiffness: 520, damping: 40 },
  default: { stiffness: 220, damping: 24 },
};

/** A 1-D spring. Retargeting keeps velocity (velocity carry-over). */
export class Spring {
  constructor(value = 0, opts = {}) {
    this.value = value; this.target = value; this.velocity = 0;
    this.configure(opts);
  }
  configure({ stiffness = 220, damping = 24, mass = 1, precision = 0.005, onUpdate, onRest } = {}) {
    Object.assign(this, { stiffness, damping, mass, precision });
    if (onUpdate) this.onUpdate = onUpdate;
    if (onRest !== undefined) this.onRest = onRest;
    return this;
  }
  to(target, velocity) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    run(this);
    return this;
  }
  jump(v) { this.value = this.target = v; this.velocity = 0; stop(this); this.onUpdate && this.onUpdate(v); return this; }
  step(dt) {
    // semi-implicit Euler in small sub-steps for stability
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const f = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += (f / this.mass) * h;
      this.value += this.velocity * h;
    }
    const done = Math.abs(this.velocity) < this.precision * 10 && Math.abs(this.value - this.target) < this.precision;
    if (done) { this.value = this.target; this.velocity = 0; }
    this.onUpdate && this.onUpdate(this.value);
    if (done && this.onRest) { const r = this.onRest; this.onRest = null; r(this.value); }
    return !done;
  }
}

/** Time-based tween for things that are not physical (draw-on, fades). */
export function tween({ from = 0, to = 1, duration = 400, delay = 0, ease = easeOutCubic, onUpdate, onDone }) {
  let t0 = null;
  const job = {
    step(dt, now) {
      if (t0 === null) t0 = now + delay;
      const p = Math.min(1, Math.max(0, (now - t0) / duration));
      onUpdate && onUpdate(from + (to - from) * ease(p), p);
      if (p >= 1) { onDone && onDone(); return false; }
      return true;
    },
    cancel() { stop(job); },
  };
  if (motion.reduced && duration > 0) { onUpdate && onUpdate(to, 1); onDone && onDone(); return job; }
  return run(job);
}
export const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
export const easeOutBack = (p) => { const c = 1.7; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

// ---- element animation (transform + opacity only) ---------------------------
const els = new WeakMap();
const KEYS = ['x', 'y', 'scale', 'rotate', 'rx', 'ry', 'opacity'];
const DEFAULTS = { x: 0, y: 0, scale: 1, rotate: 0, rx: 0, ry: 0, opacity: 1 };

function stateOf(el) {
  let s = els.get(el);
  if (!s) {
    s = { v: { ...DEFAULTS }, springs: {}, dirty: false };
    els.set(el, s);
  }
  return s;
}
function write(el, v) {
  const t = [];
  if (v.x || v.y) t.push(`translate3d(${v.x.toFixed(2)}px,${v.y.toFixed(2)}px,0)`);
  if (v.rx || v.ry) t.push(`perspective(700px) rotateX(${v.rx.toFixed(2)}deg) rotateY(${v.ry.toFixed(2)}deg)`);
  if (v.rotate) t.push(`rotate(${v.rotate.toFixed(2)}deg)`);
  if (v.scale !== 1) t.push(`scale(${v.scale.toFixed(4)})`);
  el.style.transform = t.join(' ');
  el.style.opacity = v.opacity >= 0.999 ? '' : String(Math.max(0, v.opacity).toFixed(3));
}

/** Set values immediately. */
export function set(el, props) {
  if (!el) return;
  const s = stateOf(el);
  for (const k of KEYS) if (k in props) {
    s.v[k] = props[k];
    if (s.springs[k]) s.springs[k].jump(props[k]);
  }
  write(el, s.v);
}
export function get(el, k) { return stateOf(el).v[k]; }

/** Spring element props to targets. opts: preset name or {stiffness,damping}, velocity:{k:v}, onRest. */
export function to(el, props, opts = {}) {
  if (!el) return Promise.resolve();
  const s = stateOf(el);
  const cfg = typeof opts === 'string' ? presets[opts] : { ...(presets[opts.preset] || presets.default), ...opts };
  const keys = KEYS.filter((k) => k in props);
  if (motion.reduced && !opts.force) {
    // gentle: positions settle instantly, opacity still fades
    for (const k of keys) if (k !== 'opacity') { s.v[k] = props[k]; if (s.springs[k]) s.springs[k].jump(props[k]); }
    write(el, s.v);
    if ('opacity' in props) {
      const from = s.v.opacity;
      return new Promise((res) => tween({ from, to: props.opacity, duration: 180, onUpdate: (v) => { s.v.opacity = v; write(el, s.v); }, onDone: res }));
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let pending = keys.length;
    if (!pending) return resolve();
    for (const k of keys) {
      let sp = s.springs[k];
      if (!sp) sp = s.springs[k] = new Spring(s.v[k]);
      sp.configure({ ...cfg, onUpdate: (val) => { s.v[k] = val; if (!s.dirty) { s.dirty = true; queueMicrotask(() => { s.dirty = false; write(el, s.v); }); } } });
      sp.onRest = () => { if (--pending === 0) { opts.onRest && opts.onRest(); resolve(); } };
      sp.to(props[k], opts.velocity && opts.velocity[k]);
    }
  });
}

// ---- FLIP --------------------------------------------------------------------
/** Measure keyed children, mutate, then spring them from old to new spots. */
export function flip(root, mutate, { selector = '[data-flip]', preset = 'default', enter = 'pop', stagger = 30 } = {}) {
  const first = new Map();
  root.querySelectorAll(selector).forEach((el) => first.set(el.dataset.flip, el.getBoundingClientRect()));
  mutate();
  let i = 0;
  const entered = [];
  root.querySelectorAll(selector).forEach((el) => {
    const f = first.get(el.dataset.flip);
    if (f) {
      const l = el.getBoundingClientRect();
      const dx = f.left - l.left, dy = f.top - l.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        set(el, { x: dx, y: dy });
        to(el, { x: 0, y: 0 }, preset);
      }
    } else if (enter) {
      entered.push(el);
      const delay = (i++) * stagger;
      set(el, enter === 'pop' ? { scale: 0.85, opacity: 0, y: 8 } : { opacity: 0, y: 12 });
      setTimeout(() => to(el, { scale: 1, opacity: 1, y: 0 }, 'bouncy'), delay);
    }
  });
  return entered;
}

/** Same-document View Transition with a spring-fade fallback. */
export function viewTransition(mutate) {
  if (document.startViewTransition && !motion.reduced) {
    try { return document.startViewTransition(mutate).finished.catch(() => {}); } catch (_) { /* fall through */ }
  }
  mutate();
  return Promise.resolve();
}

// ---- hand-drawn draw-on --------------------------------------------------------
/** Draw every path in an SVG (or element containing SVGs) on, in DOM order. */
export function drawOn(root, { delay = 0, duration = 520, stagger = 70 } = {}) {
  if (!root) return;
  const paths = root.matches && root.matches('path') ? [root] : [...root.querySelectorAll('path[data-draw]')];
  paths.forEach((p, i) => {
    if (motion.reduced) {
      p.style.opacity = '0';
      tween({ from: 0, to: 1, duration: 200, delay: delay + i * 20, onUpdate: (v) => { p.style.opacity = String(v); } });
      return;
    }
    p.setAttribute('pathLength', '1');
    const dash = p.getAttribute('stroke-dasharray');
    if (dash && dash !== '1') return; // dotted strokes keep their pattern
    p.style.strokeDasharray = '1';
    p.style.strokeDashoffset = '1';
    tween({
      from: 1, to: 0, duration, delay: delay + i * stagger, ease: easeInOut,
      onUpdate: (v) => { p.style.strokeDashoffset = String(v); },
      onDone: () => { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; p.removeAttribute('pathLength'); },
    });
  });
}

/** Erase (reverse draw) then resolve. */
export function erase(root, { duration = 260 } = {}) {
  const paths = [...root.querySelectorAll('path[data-draw]')];
  if (motion.reduced || !paths.length) return Promise.resolve();
  return new Promise((res) => {
    paths.forEach((p, i) => {
      p.setAttribute('pathLength', '1');
      p.style.strokeDasharray = '1';
      tween({ from: 0, to: 1, duration, delay: i * 25, onUpdate: (v) => { p.style.strokeDashoffset = String(v); }, onDone: i === paths.length - 1 ? res : undefined });
    });
  });
}

// ---- line boil -------------------------------------------------------------------
// A single shared feTurbulence filter whose seed steps at ~5 fps. Doodles opt in
// with data-boil; only those on screen get the filter. Never applied to text.
let boilTimer = 0;
let boilSeed = 1;
const visible = new Set();
const io = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const g = e.target.querySelector('g.dg');
      if (!g) continue;
      if (e.isIntersecting) { visible.add(g); if (boilOn()) g.setAttribute('filter', 'url(#boil)'); }
      else { visible.delete(g); g.removeAttribute('filter'); }
    }
    syncBoil();
  }, { rootMargin: '40px' })
  : null;
function boilOn() { return !motion.reduced && !document.hidden; }
function syncBoil() {
  const want = boilOn() && visible.size > 0;
  if (want && !boilTimer) {
    boilTimer = setInterval(() => {
      const n = document.getElementById('boil-noise');
      boilSeed = (boilSeed % 4) + 1;
      if (n) n.setAttribute('seed', String(boilSeed));
    }, 200);
  } else if (!want && boilTimer) { clearInterval(boilTimer); boilTimer = 0; }
  if (!boilOn()) visible.forEach((g) => g.removeAttribute('filter'));
}
export function observeBoil(root) {
  if (!io || !root) return;
  root.querySelectorAll('svg[data-boil]').forEach((svg) => io.observe(svg));
}
export function forgetBoil(root) {
  if (!io || !root) return;
  root.querySelectorAll('svg[data-boil]').forEach((svg) => { io.unobserve(svg); const g = svg.querySelector('g.dg'); if (g) visible.delete(g); });
}
document.addEventListener('visibilitychange', syncBoil);
motion.listeners.add(() => { syncBoil(); if (boilOn()) visible.forEach((g) => g.setAttribute('filter', 'url(#boil)')); });

// ---- small reactions ---------------------------------------------------------------
export function wiggle(el, amount = 6) {
  if (!el || motion.reduced) return;
  set(el, { rotate: amount });
  to(el, { rotate: 0 }, { stiffness: 300, damping: 6 });
}
export function hop(el) {
  if (!el || motion.reduced) return;
  to(el, { y: 0 }, { stiffness: 260, damping: 9, velocity: { y: -420 } });
}
export function spin(el) {
  if (!el || motion.reduced) return;
  set(el, { rotate: -360 });
  to(el, { rotate: 0 }, { stiffness: 90, damping: 14 });
}
export function squish(el, down) {
  if (!el) return;
  to(el, { scale: down ? 0.96 : 1 }, down ? { stiffness: 600, damping: 30 } : 'bouncy');
}
export function pulse(el) {
  if (!el || motion.reduced) return;
  set(el, { scale: 1.12 });
  to(el, { scale: 1 }, 'bouncy');
}
