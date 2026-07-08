import { onAbort } from './on-abort.js'

/**
 * Converts a function returning a value or promise to a Promise.
 */
export function toPromise<T = unknown>(execute: () => T | PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(() => execute())
}

export function raceSignal<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      // Route through onAbort for uniformity: already-aborted fires synchronously
      // (reject is in scope), otherwise the listener is removed once the promise
      // settles so nothing stays attached to a long-lived signal.
      const unsubscribe = onAbort(signal, () => reject(signal.reason))
      promise.then(unsubscribe, unsubscribe)
    }),
  ])
}

export async function sleep(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay))
}
