import { defer } from './defer.js'
import { onAbort } from './on-abort.js'

/**
 * Resolve when the signal aborts, or immediately if already aborted.
 * The abort reason never rejects the promise. The listener is removed on settlement.
 */
export function whenAborted(signal: AbortSignal): Promise<void> {
  const deferred = defer<void>()
  const unsubscribe = onAbort(signal, () => deferred.resolve())
  return deferred.promise.finally(unsubscribe)
}
