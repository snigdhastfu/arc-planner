// Loads the Go core (arc.wasm) and wraps its JSON-string API.
// Instantiation never blocks first paint: the boot doodle draws meanwhile.

let ready = null;

export function loadCore() {
  if (ready) return ready;
  ready = (async () => {
    if (globalThis.arcReady && globalThis.arc) return globalThis.arc;
    const go = new globalThis.Go();
    let result;
    if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('fetching the .wasm file');
    const response = await fetch('arc.wasm');
    if (!response.ok) throw new Error(`Fetching arc.wasm failed: ${response.status} ${response.statusText}`);

    if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('WebAssembly.instantiate');
    if (WebAssembly.instantiateStreaming) {
      try {
        result = await WebAssembly.instantiateStreaming(response.clone(), go.importObject);
      } catch (streamError) {
        const buf = await response.arrayBuffer();
        try {
          result = await WebAssembly.instantiate(buf, go.importObject);
        } catch (fallbackError) {
          fallbackError.message += ` (instantiateStreaming also failed: ${streamError.message})`;
          throw fallbackError;
        }
      }
    } else {
      const buf = await response.arrayBuffer();
      result = await WebAssembly.instantiate(buf, go.importObject);
    }
    const readyEvt = new Promise((res) => {
      if (globalThis.arcReady) res();
      else globalThis.addEventListener('arc-ready', () => res(), { once: true });
    });
    if (globalThis.__arcBootSetStage) globalThis.__arcBootSetStage('starting Go');
    const run = go.run(result.instance);
    await Promise.race([readyEvt, run.then(() => {
      throw new Error('The Go runtime exited before the Arc bridge became ready.');
    })]);
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
