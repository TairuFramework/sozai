// `queueMicrotask` is a host API (WHATWG/Node), not part of ECMA-262: Hermes does not provide it,
// React Native polyfills it, and bare Hermes, QuickJS and older React Native do not. Fall back to a
// promise continuation, which is available anywhere `Disposer` can already run. Under React Native's
// legacy Promise polyfill that continuation lands on `setImmediate` (a macrotask) rather than a true
// microtask — later, but still strictly after the current synchronous frame, which is the only
// ordering guarantee callers rely on.
const schedule: (fn: () => void) => void =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn) => {
        void Promise.resolve().then(fn)
      }

/**
 * Runs the given function after the current synchronous execution completes.
 *
 * Internal to `@sozai/async` — not part of the public API.
 */
export function scheduleMicrotask(fn: () => void): void {
  schedule(fn)
}
