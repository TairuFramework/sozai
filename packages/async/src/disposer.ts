import { defer } from './defer.js'
import { DisposeInterruption } from './interruptions.js'
import { scheduleMicrotask } from './microtask.js'
import { onAbort } from './on-abort.js'

export type DisposerParams = {
  dispose?: (reason?: unknown) => Promise<void>
  onDisposeError?: (error: unknown) => void
  signal?: AbortSignal
}

/**
 * Disposer class, providing a dispose function and a disposed Promise.
 *
 * Given a signal that has **already** aborted, dispose is deferred until the construction frame
 * completes, so a subclass dispose callback always sees an initialized `this` — `signal.aborted`
 * reads `false` until then. A signal aborting later still disposes synchronously.
 *
 * A subclass constructor that throws after `super()` still gets disposed, on the half-built
 * instance: its field initializers have run, its constructor-body assignments read as `undefined`.
 */
export class Disposer extends AbortController implements AsyncDisposable {
  #deferred = defer<void>()
  #unsubscribeSignal: () => void = () => {}
  #pendingReason: unknown

  constructor(params: DisposerParams = {}) {
    super()

    let disposing = false
    this.signal.addEventListener(
      'abort',
      () => {
        this.#unsubscribeSignal()
        // Releases the reference; not load-bearing. `abort()` is idempotent, so a later `dispose()`
        // is a no-op whatever the latch holds.
        this.#pendingReason = undefined
        if (!disposing) {
          disposing = true
          if (params.dispose == null) {
            this.#deferred.resolve()
          } else {
            params.dispose(this.signal.reason).then(
              () => this.#deferred.resolve(),
              (error) => {
                try {
                  if (params.onDisposeError != null) {
                    params.onDisposeError(error)
                  } else {
                    console.warn('Disposer dispose callback rejected', error)
                  }
                } catch (handlerError) {
                  // A throwing onDisposeError must never escape as an unhandled rejection
                  console.warn('Disposer onDisposeError handler threw', handlerError)
                } finally {
                  // `disposed` must settle even if onDisposeError itself throws
                  this.#deferred.resolve()
                }
              },
            )
          }
        }
      },
      { once: true },
    )
    const signal = params.signal
    if (signal?.aborted) {
      // Deferred, not synchronous: `onAbort` would fire this from inside `super()`, before a
      // subclass constructor has initialized `this`. The dispose callback would then throw a
      // ReferenceError on its first `this` access, which this class swallows into a resolved
      // `disposed` — teardown skipped, caller told it succeeded.
      // Latch the reason: a `dispose()` in the construction frame beats this microtask and would
      // otherwise substitute a `DisposeInterruption` for the external reason.
      this.#pendingReason = signal.reason
      scheduleMicrotask(() => this.dispose(signal.reason))
    } else {
      this.#unsubscribeSignal = onAbort(signal, () => this.dispose(signal?.reason))
    }
  }

  get disposed(): Promise<void> {
    return this.#deferred.promise
  }

  dispose(reason?: unknown): Promise<void> {
    this.abort(reason ?? this.#pendingReason ?? new DisposeInterruption())
    return this.#deferred.promise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }
}
