/**
 * Sozai generator utilities.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/generator
 * ```
 *
 * @module generator
 */

import { type Deferred, defer, onAbort } from '@sozai/async'
import type { EventEmitter } from '@sozai/event'

export function consume<T, TReturn = unknown>(
  iterator: AsyncIterator<T, TReturn>,
  callback: (value: T) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<TReturn> {
  let closed = false
  const ended = defer<TReturn>()

  const close = () => {
    if (closed) return
    closed = true
    // Run the source's cleanup (finally blocks). Swallow errors so cleanup
    // failures never mask the resolve/reject reason already settled below.
    Promise.resolve(iterator.return?.()).catch(() => {})
  }

  const abort = () => {
    close()
    ended.reject(signal?.reason)
  }

  if (signal?.aborted) {
    // Already aborted: settle immediately; the listener won't fire for
    // signals that are aborted before addEventListener is called.
    abort()
  } else {
    signal?.addEventListener('abort', abort)
  }

  async function pull() {
    if (signal?.aborted) return
    try {
      const { done, value } = await iterator.next()
      if (signal?.aborted || done) {
        if (done && !signal?.aborted) {
          ended.resolve(value)
        }
        close()
        return
      }

      await callback(value)
      void pull()
    } catch (reason) {
      close()
      ended.reject(reason)
    }
  }
  void pull()

  return ended.promise
}

export function fromEmitter<
  Events extends Record<string, unknown>,
  EventName extends keyof Events & string = keyof Events & string,
>(
  emitter: EventEmitter<Events>,
  name: EventName,
  options?: { filter?: (event: Events[EventName]) => boolean; signal?: AbortSignal },
): AsyncGenerator<Events[EventName], void, void> {
  let isDone = false
  const pending: Array<Deferred<IteratorResult<Events[EventName], void>>> = []
  const queue: Array<Events[EventName]> = []

  const unsubscribe = emitter.on(
    name,
    (event) => {
      const waiter = pending.shift()
      if (waiter == null) {
        queue.push(event)
      } else {
        waiter.resolve({ value: event, done: false })
      }
    },
    { filter: options?.filter },
  )

  let unsubscribeSignal: () => void = () => {}
  const stop = () => {
    unsubscribe()
    unsubscribeSignal()
    isDone = true
    while (pending.length > 0) {
      const waiter = pending.shift() as Deferred<IteratorResult<Events[EventName], void>>
      waiter.resolve({ done: true, value: undefined })
    }
  }
  unsubscribeSignal = onAbort(options?.signal, stop)

  return {
    [Symbol.asyncDispose]() {
      stop()
      return Promise.resolve()
    },
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => {
      if (isDone) {
        return Promise.resolve({ done: true, value: undefined })
      }
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift() as Events[EventName], done: false })
      }
      const deferred = defer<IteratorResult<Events[EventName], void>>()
      pending.push(deferred)
      return deferred.promise
    },
    return: () => {
      stop()
      return Promise.resolve({ done: true, value: undefined })
    },
    throw: (reason: unknown) => {
      stop()
      return Promise.reject(reason)
    },
  }
}

export async function* fromStream<T>(
  stream: ReadableStream<T>,
  options: { preventCancel?: boolean } = {},
): AsyncGenerator<T> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      yield value
    }
  } finally {
    if (!options.preventCancel) {
      // Early return / break / throw: cancel the source so its cancel()
      // callback runs and resources are released. cancel() on an
      // already-closed stream is a no-op, so normal completion is unaffected.
      await reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}
