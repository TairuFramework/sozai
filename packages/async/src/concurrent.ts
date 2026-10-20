import { onAbort } from './on-abort.js'
import { raceSignal } from './utils.js'

export type ConcurrentOptions = {
  /** Maximum number of calls in flight, a positive integer. */
  limit: number
  /** Aborting rejects with `signal.reason` once in-flight calls have settled. */
  signal?: AbortSignal
}

export type PrefetchOptions = {
  /** Maximum number of fetches started but not yet yielded, a positive integer. */
  window: number
  /** Aborting makes the generator throw `signal.reason` and aborts outstanding fetches. */
  signal?: AbortSignal
}

function noop() {}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`)
  }
}

// Captures synchronous throws as rejections without delaying the call.
function call<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  return new Promise((resolve) => resolve(fn()))
}

/**
 * Map items with at most `limit` calls in flight, resolving results in input order.
 *
 * On the first rejection (or outer abort) the signal passed to running calls is aborted, no new
 * call starts, in-flight calls are awaited, then the promise rejects with the first error
 * (or the outer signal's reason).
 */
export async function mapConcurrent<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  options: ConcurrentOptions,
): Promise<Array<R>> {
  const { limit, signal } = options
  assertPositiveInteger(limit, 'limit')
  const list = Array.from(items)
  const results = new Array<R>(list.length)
  const controller = new AbortController()
  let failed = false
  let failure: unknown
  let next = 0

  function fail(error: unknown): void {
    if (!failed) {
      failed = true
      failure = error
      controller.abort(error)
    }
  }

  async function worker(): Promise<void> {
    while (!failed && next < list.length) {
      const index = next++
      try {
        results[index] = await call(() => fn(list[index] as T, index, controller.signal))
      } catch (error) {
        fail(error)
        return
      }
    }
  }

  const unsubscribe = onAbort(signal, () => fail(signal?.reason))
  try {
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  } finally {
    unsubscribe()
  }
  if (failed) {
    throw failure
  }
  return results
}

type Slot<R> =
  | { status: 'pending' }
  | { status: 'miss' }
  | { status: 'hit'; value: R }
  | { status: 'error'; error: unknown }

type Outcome<R> = { ok: true; value: R | null } | { ok: false; error: unknown }

/**
 * Hedged failover: ask up to `limit` items concurrently and resolve with the result of the
 * earliest item in list order that returns a non-null value, once every earlier item has settled
 * as a miss (null, undefined or rejection).
 *
 * Resolves `null` when no item hits, except when every item rejected (and there is at least one
 * item): then it rejects with an AggregateError of all the errors in list order. The signals of
 * the other items are aborted once decided, and the promise settles after in-flight calls have.
 * Outer abort rejects with `signal.reason`.
 */
export function firstInOrder<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R | null | undefined>,
  options: ConcurrentOptions,
): Promise<R | null> {
  const { limit, signal } = options
  const list = Array.from(items)

  return new Promise<R | null>((resolve, reject) => {
    assertPositiveInteger(limit, 'limit')
    const slots: Array<Slot<R>> = list.map(() => ({ status: 'pending' }))
    const controllers = new Map<number, AbortController>()
    let outcome: Outcome<R> | undefined
    let winner = -1
    let head = 0
    let next = 0
    let inflight = 0
    // Items at or beyond the lowest hit index cannot win over it, so are never started.
    let bound = list.length
    let unsubscribe = noop

    function maybeFinish(): void {
      if (outcome != null && inflight === 0) {
        unsubscribe()
        if (outcome.ok) {
          resolve(outcome.value)
        } else {
          reject(outcome.error)
        }
      }
    }

    function decide(result: Outcome<R>): void {
      if (outcome != null) {
        return
      }
      outcome = result
      for (const [index, controller] of controllers) {
        if (index !== winner) {
          controller.abort()
        }
      }
      maybeFinish()
    }

    function advance(): void {
      while (outcome == null && head < list.length) {
        const slot = slots[head] as Slot<R>
        if (slot.status === 'pending') {
          return
        }
        if (slot.status === 'hit') {
          winner = head
          decide({ ok: true, value: slot.value })
          return
        }
        head++
      }
      if (outcome == null) {
        const errors = slots.flatMap((slot) => (slot.status === 'error' ? [slot.error] : []))
        if (list.length > 0 && errors.length === list.length) {
          decide({ ok: false, error: new AggregateError(errors, 'All items failed') })
        } else {
          decide({ ok: true, value: null })
        }
      }
    }

    function settle(index: number, slot: Slot<R>): void {
      inflight--
      controllers.delete(index)
      if (outcome == null) {
        slots[index] = slot
        if (slot.status === 'hit' && index < bound) {
          bound = index
          // Later items can no longer win.
          for (const [other, controller] of controllers) {
            if (other > index) {
              controller.abort()
            }
          }
        }
        advance()
        pump()
      }
      maybeFinish()
    }

    function pump(): void {
      while (outcome == null && inflight < limit && next < bound) {
        const index = next++
        const controller = new AbortController()
        controllers.set(index, controller)
        inflight++
        call(() => fn(list[index] as T, index, controller.signal)).then(
          (value) => settle(index, value == null ? { status: 'miss' } : { status: 'hit', value }),
          (error) => settle(index, { status: 'error', error }),
        )
      }
    }

    unsubscribe = onAbort(signal, () => decide({ ok: false, error: signal?.reason }))
    if (outcome == null) {
      advance()
      pump()
    }
    maybeFinish()
  })
}

/**
 * Yield `fetch(0..count-1)` results strictly in index order, keeping up to `window` fetches
 * started but not yet yielded.
 *
 * An error in fetch `i` is thrown when the consumer reaches `i`. When the generator ends for any
 * reason (error, `break`, `return`, outer abort) outstanding fetches are aborted and awaited.
 */
export async function* prefetchOrdered<T>(
  count: number,
  fetch: (index: number, signal: AbortSignal) => Promise<T>,
  options: PrefetchOptions,
): AsyncGenerator<T> {
  const { window, signal } = options
  assertPositiveInteger(window, 'window')
  const controller = new AbortController()
  const pending = new Map<number, Promise<T>>()
  const unsubscribe = onAbort(signal, () => controller.abort(signal?.reason))
  let started = 0

  function start(yielded: number): void {
    while (started < count && started - yielded < window && !controller.signal.aborted) {
      const index = started++
      const promise = call(() => fetch(index, controller.signal))
      // Errors surface when the consumer reaches the index, never as unhandled rejections.
      promise.catch(noop)
      pending.set(index, promise)
    }
  }

  try {
    for (let index = 0; index < count; index++) {
      controller.signal.throwIfAborted()
      start(index)
      const value = await raceSignal(pending.get(index) as Promise<T>, controller.signal)
      pending.delete(index)
      start(index + 1)
      yield value
    }
  } finally {
    unsubscribe()
    controller.abort()
    await Promise.allSettled(pending.values())
  }
}
