// Pointer-event drag helper with velocity tracking. Works for mouse, touch and
// pen; cancels cleanly on pointercancel.

/**
 * drag(el, { onStart, onMove({dx,dy,vx,vy,e}), onEnd({dx,dy,vx,vy,cancelled}), threshold, axis, longPress })
 * Returns a function that removes the listeners.
 */
export function drag(el, opts) {
  const threshold = opts.threshold ?? 6;
  let st = null;
  const samples = [];

  function down(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (opts.ignore && e.target.closest(opts.ignore)) return;
    st = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false, t: performance.now(), pressed: true };
    samples.length = 0;
    samples.push({ x: e.clientX, y: e.clientY, t: st.t });
    if (opts.longPress) {
      st.lp = setTimeout(() => {
        if (st && !st.active) { st.active = true; st.long = true; capture(e); opts.onStart && opts.onStart({ long: true, e }); }
      }, opts.longPress);
    }
    opts.onPress && opts.onPress(e);
  }
  function capture(e) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } }
  function move(e) {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (samples.length > 6) samples.shift();
    if (!st.active) {
      if (Math.hypot(dx, dy) < threshold) return;
      if (opts.longPress) { clearTimeout(st.lp); cancel(); return; } // scrolling: let it go
      if (opts.axis === 'x' && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
      if (opts.axis === 'y' && Math.abs(dx) > Math.abs(dy)) { cancel(); return; }
      st.active = true;
      capture(e);
      opts.onStart && opts.onStart({ e });
    }
    const v = velocity();
    opts.onMove && opts.onMove({ dx, dy, vx: v.x, vy: v.y, e, long: st.long });
  }
  function up(e, cancelled = false) {
    if (!st || (e && e.pointerId !== st.id)) return;
    clearTimeout(st.lp);
    const wasActive = st.active;
    const dx = e ? e.clientX - st.x : 0, dy = e ? e.clientY - st.y : 0;
    const v = velocity();
    const long = st.long;
    st = null;
    opts.onRelease && opts.onRelease();
    if (wasActive) opts.onEnd && opts.onEnd({ dx, dy, vx: v.x, vy: v.y, cancelled, long });
  }
  function cancel() { if (st) { clearTimeout(st.lp); st = null; opts.onRelease && opts.onRelease(); } }
  function velocity() {
    if (samples.length < 2) return { x: 0, y: 0 };
    const a = samples[0], b = samples[samples.length - 1];
    const dt = Math.max(1, b.t - a.t) / 1000;
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
  const onUp = (e) => up(e);
  const onCancel = (e) => up(e, true);
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('lostpointercapture', onCancel);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('lostpointercapture', onCancel);
  };
}

/** Rubber-band: resistance past the edge (iOS-like). */
export function rubber(x, limit = 120) {
  const s = Math.sign(x), a = Math.abs(x);
  return s * (limit * (1 - 1 / (a / limit + 1)));
}
