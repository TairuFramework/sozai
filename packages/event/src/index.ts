/**
 *
 *
 * Simple events emitter.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/event
 * ```
 *
 * @module event
 */

import { onAbort } from '@sozai/async'
import type { Logger } from '@sozai/log'

export type UnsubscribeFunction = () => void

export type ListenerOptions<Data> = {
  filter?: (data: Data) => boolean
  signal?: AbortSignal
}

export type DatalessEventNames<Events extends Record<string, unknown>> = {
  [Key in keyof Events]: Events[Key] extends void ? Key : never
}[keyof Events]

export type EventEmitterOptions = {
  logger?: Logger
}

/**
 * Listen-only view of an {@link EventEmitter}. Hand this to consumers that may
 * subscribe to events but must not emit them.
 */
export type EventsSource<Events extends Record<string, unknown>> = {
  on<Name extends keyof Events>(
    name: Name,
    listener: (data: Events[Name]) => void | Promise<void>,
    options?: ListenerOptions<Events[Name]>,
  ): UnsubscribeFunction
  once<Name extends keyof Events>(
    name: Name,
    options?: ListenerOptions<Events[Name]>,
  ): Promise<Events[Name]>
  readable<Name extends keyof Events>(
    name: Name,
    options?: ListenerOptions<Events[Name]>,
  ): ReadableStream<Events[Name]>
}

/**
 * Write-only view of an {@link EventEmitter}. Hand this to producers that may
 * emit events but must not subscribe to them.
 */
export type EventsSink<Events extends Record<string, unknown>> = {
  emit<Name extends DatalessEventNames<Events>>(name: Name): Promise<void>
  emit<Name extends keyof Events>(name: Name, data: Events[Name]): Promise<void>
  fire<Name extends DatalessEventNames<Events>>(name: Name): void
  fire<Name extends keyof Events>(name: Name, data: Events[Name]): void
  writable<Name extends keyof Events>(name: Name): WritableStream<Events[Name]>
}

export class EventEmitter<Events extends Record<string, unknown>>
  implements EventsSource<Events>, EventsSink<Events>
{
  #listeners = new Map<keyof Events, Set<(data: unknown) => void | Promise<void>>>()
  #logger?: Logger

  constructor(options?: EventEmitterOptions) {
    this.#logger = options?.logger
  }

  on<Name extends keyof Events>(
    name: Name,
    listener: (data: Events[Name]) => void | Promise<void>,
    options?: ListenerOptions<Events[Name]>,
  ): UnsubscribeFunction {
    const filter = options?.filter
    const wrappedListener = filter
      ? (data: unknown) => {
          if (filter(data as Events[Name])) {
            return listener(data as Events[Name])
          }
        }
      : (data: unknown) => {
          return listener(data as Events[Name])
        }

    let listeners = this.#listeners.get(name)
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(name, listeners)
    }
    listeners.add(wrappedListener)

    const off = () => {
      listeners.delete(wrappedListener)
    }

    onAbort(options?.signal, off)
    return off
  }

  once<Name extends keyof Events>(
    name: Name,
    options?: ListenerOptions<Events[Name]>,
  ): Promise<Events[Name]> {
    return new Promise((resolve, reject) => {
      const signal = options?.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      let unsubscribeAbort: () => void = () => {}
      const off = this.on(
        name,
        (data) => {
          off()
          unsubscribeAbort()
          resolve(data)
        },
        { filter: options?.filter },
      )
      unsubscribeAbort = onAbort(signal, () => {
        off()
        reject(signal?.reason)
      })
    })
  }

  /**
   * Emits an event to all listeners.
   *
   * Listeners are awaited and their failures are rethrown (a single error as-is,
   * multiple as an `AggregateError`). A fire-and-forget call — `void emit(...)`
   * — therefore turns a listener failure into an unhandled promise rejection.
   * For fire-and-forget emits, attach a handler: `emit(...).catch(...)`.
   */
  emit<Name extends DatalessEventNames<Events>>(name: Name): Promise<void>
  emit<Name extends keyof Events>(name: Name, data: Events[Name]): Promise<void>
  async emit<Name extends keyof Events>(name: Name, data?: Events[Name]): Promise<void> {
    const listeners = this.#listeners.get(name)
    if (!listeners || listeners.size === 0) return
    const results = await Promise.allSettled(
      [...listeners].map((fn) => {
        try {
          return fn(data)
        } catch (err) {
          return Promise.reject(err)
        }
      }),
    )
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors)
  }

  /**
   * Fire-and-forget synchronous emit.
   *
   * Calls {@link EventEmitter.emit} without awaiting and returns immediately. Listener
   * failures are swallowed — if a logger was provided to the constructor they are
   * reported via `logger.warn`, otherwise they are silently discarded. Use
   * {@link EventEmitter.emit} directly when you need to await completion or handle
   * errors.
   */
  fire<Name extends DatalessEventNames<Events>>(name: Name): void
  fire<Name extends keyof Events>(name: Name, data: Events[Name]): void
  fire<Name extends keyof Events>(name: Name, data?: Events[Name]): void {
    void this.emit(name as Name, data as Events[Name]).catch((error) => {
      this.#logger?.warn('Event listener failed during fire()', { name, error })
    })
  }

  readable<Name extends keyof Events>(
    name: Name,
    options: ListenerOptions<Events[Name]> = {},
  ): ReadableStream<Events[Name]> {
    const abortController = new AbortController()
    const signal = options.signal
      ? AbortSignal.any([options.signal, abortController.signal])
      : abortController.signal

    let isClosed = false
    let unsubscribeAbort: () => void = () => {}
    return new ReadableStream({
      start: (controller) => {
        if (signal.aborted) {
          isClosed = true
          controller.close()
          return
        }
        const off = this.on(name, (data) => controller.enqueue(data), {
          filter: options.filter,
          signal,
        })
        unsubscribeAbort = onAbort(signal, () => {
          off()
          if (!isClosed) {
            isClosed = true
            controller.close()
          }
        })
      },
      cancel() {
        isClosed = true
        unsubscribeAbort()
        abortController.abort()
      },
    })
  }

  writable<Name extends keyof Events>(name: Name): WritableStream<Events[Name]> {
    return new WritableStream({
      write: async (data) => {
        await this.emit(name, data)
      },
    })
  }
}
