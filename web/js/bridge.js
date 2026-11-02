// Loads the Go core (arc.wasm) and wraps its JSON-string API.
// Instantiation never blocks first paint: the boot doodle draws meanwhile.

let ready = null;

export function loadCore() {
  if (ready) return ready;
  ready = (async () => {
    if (globalThis.arcReady && globalThis.arc) return globalThis.arc;
    const go = new globalThis.Go();
    let result;
    try {
      result = await WebAssembly.instantiateStreaming(fetch('arc.wasm'), go.importObject);
    } catch (_) {
      // Wrong MIME type (some static hosts) or no streaming support.
      const buf = await (await fetch('arc.wasm')).arrayBuffer();
      result = await WebAssembly.instantiate(buf, go.importObject);
    }
    const readyEvt = new Promise((res) => {
      if (globalThis.arcReady) res();
      else globalThis.addEventListener('arc-ready', () => res(), { once: true });
    });
    go.run(result.instance); // never resolves: main blocks on select{}
    await readyEvt;
    return globalThis.arc;
  })();
  return ready;
}

export class CoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Call a core function with a JS object; returns data or throws CoreError. */
export function call(name, req = {}) {
  const fn = globalThis.arc && globalThis.arc[name];
  if (!fn) throw new CoreError('not_ready', `core function ${name} is not available`);
  const env = JSON.parse(fn(JSON.stringify(req)));
  if (!env.ok) throw new CoreError(env.error.code, env.error.message);
  return env.data;
}
