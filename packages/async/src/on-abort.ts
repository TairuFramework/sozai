function noop() {}

/**
 * Registers an abort listener that cleans itself up, returning an unsubscribe function.
 *
 * - No signal: returns a noop unsubscribe.
 * - Already-aborted signal: invokes `fn` synchronously and returns a noop unsubscribe
 *   (abort events do not replay for listeners added after the abort).
 * - Otherwise: adds a `{ once: true }` abort listener and returns an unsubscribe that
 *   removes it. Call the unsubscribe on normal settlement so the listener does not leak
 *   on a long-lived signal.
 */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (signal == null) {
    return noop
  }
  if (signal.aborted) {
    fn()
    return noop
  }
  signal.addEventListener('abort', fn, { once: true })
  return () => signal.removeEventListener('abort', fn)
}
