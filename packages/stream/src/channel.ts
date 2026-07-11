import { type Deferred, defer, onAbort } from '@sozai/async'

/**
 * Internal half-duplex channel: a `ReadableStream` and the `WritableStream` that feeds it.
 *
 * Not exported from the package. `createPipe` is one channel; `createConnection` is two
 * channels crossed. The abort, cancel, backpressure and close-guard semantics live here so
 * they are written and tested once.
 */

export type ChannelOptions = {
  /**
   * Bound the number of messages buffered in the readable before `write` awaits a read.
   *
   * Omitted (the default), the readable's queue grows without bound and `write` always
   * resolves immediately, matching a queue-until-read contract.
   */
  highWaterMark?: number
}

export type Channel<T> = {
  readable: ReadableStream<T>
  writable: WritableStream<T>
  /** Idempotent close of the readable side. Safe to call after close or error. */
  close: () => void
}

export function createChannel<T>(options: ChannelOptions = {}): Channel<T> {
  const { highWaterMark } = options

  let controller: ReadableStreamDefaultController<T>
  let closed = false
  // Set when the readable is cancelled. A WritableStream cannot be errored from outside
  // without its writer lock, so the reason crosses to the writable through this slot and
  // is thrown by the sink callbacks.
  let failure: { reason: unknown } | undefined
  // Resolved by `pull` when the readable's queue has room again.
  let capacity: Deferred<void> | undefined

  function releaseCapacity(): void {
    capacity?.resolve()
    capacity = undefined
  }

  function rejectCapacity(reason: unknown): void {
    capacity?.reject(reason)
    capacity = undefined
  }

  const strategy = highWaterMark == null ? undefined : new CountQueuingStrategy({ highWaterMark })
  const readable = new ReadableStream<T>(
    {
      start(ctrl) {
        controller = ctrl
      },
      pull() {
        releaseCapacity()
      },
      cancel(reason) {
        closed = true
        failure ??= { reason }
        rejectCapacity(reason)
      },
    },
    strategy,
  )

  function close(): void {
    if (closed) {
      return
    }
    closed = true
    // Settle any write parked on backpressure. It cannot be enqueued after close, so reject
    // it rather than leave its promise dangling. (cancel/abort already settle the parked write;
    // close is the third teardown path and must too.)
    rejectCapacity(new Error('Stream closed'))
    try {
      controller.close()
    } catch {
      // Controller may already be closed or errored
    }
  }

  /**
   * Wait until the readable's queue has room.
   *
   * Races the `pull` signal against the writable's abort signal: the streams spec defers a
   * WritableStream's `abort` callback until any in-flight write settles, so a write parked
   * here can only be released by the signal, never by the sink's `abort`.
   */
  async function waitForCapacity(signal: AbortSignal): Promise<void> {
    while ((controller.desiredSize ?? 0) <= 0) {
      signal.throwIfAborted()
      capacity = defer<void>()
      const unsubscribe = onAbort(signal, () => {
        rejectCapacity(signal.reason)
      })
      try {
        await capacity.promise
      } finally {
        unsubscribe()
      }
      if (failure != null) {
        throw failure.reason
      }
    }
  }

  const writable = new WritableStream<T>({
    async write(msg, ctrl) {
      if (failure != null) {
        throw failure.reason
      }
      if (highWaterMark != null) {
        await waitForCapacity(ctrl.signal)
      }
      controller.enqueue(msg)
    },
    close() {
      if (failure != null) {
        throw failure.reason
      }
      close()
    },
    abort(reason) {
      if (closed) {
        return
      }
      closed = true
      controller.error(reason)
    },
  })

  return { readable, writable, close }
}
