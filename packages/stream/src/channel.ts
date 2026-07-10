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

  const strategy = highWaterMark == null ? undefined : new CountQueuingStrategy({ highWaterMark })
  const readable = new ReadableStream<T>(
    {
      start(ctrl) {
        controller = ctrl
      },
    },
    strategy,
  )

  function close(): void {
    if (closed) {
      return
    }
    closed = true
    try {
      controller.close()
    } catch {
      // Controller may already be closed or errored
    }
  }

  const writable = new WritableStream<T>({
    write(msg) {
      controller.enqueue(msg)
    },
    close() {
      close()
    },
  })

  return { readable, writable, close }
}
