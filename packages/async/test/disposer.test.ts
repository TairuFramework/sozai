import { describe, expect, test, vi } from 'vitest'

import { Disposer } from '../src/disposer.js'

describe('Disposer', () => {
  test('only disposes once', async () => {
    const disposeFn = vi.fn(() => Promise.resolve())
    const disposer = new Disposer({ dispose: disposeFn })

    await expect(disposer.dispose()).resolves.toBeUndefined()
    await expect(disposer.dispose()).resolves.toBeUndefined()

    expect(disposeFn).toHaveBeenCalledTimes(1)
  })

  test('calls dispose function with abort reason', async () => {
    const disposeFn = vi.fn(() => Promise.resolve())
    const disposer = new Disposer({ dispose: disposeFn })
    const reason = new Error('test reason')

    await disposer.dispose(reason)

    expect(disposeFn).toHaveBeenCalledWith(reason)
  })

  test('resolves disposed promise when dispose is called', async () => {
    const disposer = new Disposer()

    const disposePromise = disposer.dispose()
    await expect(disposePromise).resolves.toBeUndefined()
    await expect(disposer.disposed).resolves.toBeUndefined()
  })

  test('works without dispose function', async () => {
    const disposer = new Disposer()

    await expect(disposer.dispose()).resolves.toBeUndefined()
  })

  test('implements AsyncDisposable', async () => {
    const disposer = new Disposer()

    // Test using await using
    await (async () => {
      await using _ = disposer
      // disposer should be disposed when this block exits
    })()

    expect(disposer.signal.aborted).toBe(true)
  })

  test('listens to external abort signal', async () => {
    const externalController = new AbortController()
    const disposeFn = vi.fn(() => Promise.resolve())
    const disposer = new Disposer({
      dispose: disposeFn,
      signal: externalController.signal,
    })

    externalController.abort('external reason')

    await expect(disposer.disposed).resolves.toBeUndefined()
    expect(disposeFn).toHaveBeenCalledWith('external reason')
  })

  test('disposed settles even if the dispose callback rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const disposer = new Disposer({
        dispose: () => Promise.reject(new Error('cleanup failed')),
      })
      // Pre-fix these promises never settle (test times out)
      await expect(disposer.dispose()).resolves.toBeUndefined()
      await expect(disposer.disposed).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('disposed settles even if onDisposeError throws', async () => {
    const disposer = new Disposer({
      dispose: () => Promise.reject(new Error('cleanup failed')),
      onDisposeError: () => {
        throw new Error('handler boom')
      },
    })
    await expect(disposer.dispose()).resolves.toBeUndefined()
    await expect(disposer.disposed).resolves.toBeUndefined()
  })

  test('surfaces dispose callback rejection via onDisposeError', async () => {
    const onDisposeError = vi.fn()
    const error = new Error('cleanup failed')
    const disposer = new Disposer({
      dispose: () => Promise.reject(error),
      onDisposeError,
    })
    await disposer.dispose()
    expect(onDisposeError).toHaveBeenCalledWith(error)
  })

  test('defers dispose to a microtask when constructed with an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort('external reason')
    const disposeFn = vi.fn(() => Promise.resolve())
    const disposer = new Disposer({ dispose: disposeFn, signal: controller.signal })

    // Not during construction: a subclass constructor body has not run yet at this point.
    expect(disposeFn).not.toHaveBeenCalled()
    expect(disposer.signal.aborted).toBe(false)

    await expect(disposer.disposed).resolves.toBeUndefined()
    expect(disposeFn).toHaveBeenCalledTimes(1)
    expect(disposeFn).toHaveBeenCalledWith('external reason')
    expect(disposer.signal.aborted).toBe(true)
  })

  test('runs a subclass dispose callback after the derived constructor completes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const teardown = vi.fn()

    class Resource extends Disposer {
      #name: string

      constructor(name: string, signal: AbortSignal) {
        super({
          dispose: async () => {
            // Pre-fix this throws `ReferenceError: Must call super constructor in derived class
            // before accessing 'this'`, Disposer swallows it, and `disposed` resolves anyway.
            teardown(this.#name)
          },
          signal,
        })
        this.#name = name
      }
    }

    try {
      const controller = new AbortController()
      controller.abort()
      const resource = new Resource('db', controller.signal)

      await expect(resource.disposed).resolves.toBeUndefined()
      expect(teardown).toHaveBeenCalledWith('db')
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('subclass dispose callback observes constructor-body values, not field initializers', async () => {
    const seen: Array<string> = []

    class Resource extends Disposer {
      #state = 'initializing'

      constructor(signal: AbortSignal) {
        super({
          dispose: async () => {
            seen.push(this.#state)
          },
          signal,
        })
        this.#state = 'ready'
      }
    }

    const controller = new AbortController()
    controller.abort()
    const resource = new Resource(controller.signal)

    await expect(resource.disposed).resolves.toBeUndefined()
    expect(seen).toEqual(['ready'])
  })

  test('dispose() called synchronously wins the race against the deferred microtask and still receives the external reason', async () => {
    const controller = new AbortController()
    controller.abort('external reason')
    const disposeFn = vi.fn(() => Promise.resolve())
    const disposer = new Disposer({ dispose: disposeFn, signal: controller.signal })

    // Same synchronous frame as construction: races the scheduled microtask.
    await expect(disposer.dispose()).resolves.toBeUndefined()

    expect(disposeFn).toHaveBeenCalledTimes(1)
    expect(disposeFn).toHaveBeenCalledWith('external reason')
    await expect(disposer.disposed).resolves.toBeUndefined()
  })

  test('await using landing synchronously wins the race against the deferred microtask and still receives the external reason', async () => {
    const controller = new AbortController()
    controller.abort('external reason')
    const disposeFn = vi.fn(() => Promise.resolve())

    await (async () => {
      await using disposer = new Disposer({ dispose: disposeFn, signal: controller.signal })
      void disposer
    })()

    expect(disposeFn).toHaveBeenCalledTimes(1)
    expect(disposeFn).toHaveBeenCalledWith('external reason')
  })

  test('an explicit dispose reason still overrides the latched external reason', async () => {
    const controller = new AbortController()
    controller.abort('external reason')
    const disposeFn = vi.fn(() => Promise.resolve())
    const ownReason = new Error('own reason')
    const disposer = new Disposer({ dispose: disposeFn, signal: controller.signal })

    await expect(disposer.dispose(ownReason)).resolves.toBeUndefined()

    expect(disposeFn).toHaveBeenCalledTimes(1)
    expect(disposeFn).toHaveBeenCalledWith(ownReason)
  })

  test('still disposes synchronously when an external signal aborts after construction', async () => {
    const controller = new AbortController()
    const disposeFn = vi.fn(() => Promise.resolve())
    const disposer = new Disposer({ dispose: disposeFn, signal: controller.signal })

    controller.abort('late reason')

    // The late-abort path is unchanged by the deferral: it fires within the abort dispatch.
    expect(disposeFn).toHaveBeenCalledTimes(1)
    expect(disposeFn).toHaveBeenCalledWith('late reason')
    expect(disposer.signal.aborted).toBe(true)
    await expect(disposer.disposed).resolves.toBeUndefined()
  })

  test('a derived constructor that throws after super() still disposes, on a half-built instance', async () => {
    // Pins the documented caveat of the deferral: the scheduled dispose is already queued when the
    // derived constructor throws, so it fires on the discarded instance. Field initializers have run
    // by then; constructor-body assignments have not, so they read as `undefined`.
    const seen: Array<unknown> = []

    class Broken extends Disposer {
      #initialized = 'from field initializer'
      #assigned: string | undefined

      constructor(signal: AbortSignal) {
        super({
          dispose: async () => {
            seen.push([this.#initialized, this.#assigned])
          },
          signal,
        })
        throw new Error('derived constructor failed')
      }
    }

    const controller = new AbortController()
    controller.abort()
    expect(() => new Broken(controller.signal)).toThrow('derived constructor failed')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([['from field initializer', undefined]])
  })
})
