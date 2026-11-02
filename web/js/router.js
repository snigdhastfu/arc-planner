// Hash router: #/today #/routines #/horizon #/review #/settings #/guided/<group>
const routes = new Map();
let current = null;
let onChange = null;

export function route(name, handler) { routes.set(name, handler); }
export function onRoute(fn) { onChange = fn; }

export function parse(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'today', params: parts.slice(1) };
}
export function go(path, { replace = false } = {}) {
  const h = '#/' + path.replace(/^#?\/?/, '');
  if (location.hash === h) { dispatch(); return; }
  if (replace) { history.replaceState(null, '', h); dispatch(); } else location.hash = h;
}
export function currentRoute() { return current; }
function dispatch() {
  const r = parse();
  if (!routes.has(r.name)) { go('today', { replace: true }); return; }
  const prev = current;
  current = r;
  onChange && onChange(r, prev);
}
export function start() {
  addEventListener('hashchange', dispatch);
  dispatch();
}
