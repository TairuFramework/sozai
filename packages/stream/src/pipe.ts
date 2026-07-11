import { type ChannelOptions, createChannel } from './channel.js'

export type Pipe<T> = ReadableWritablePair<T, T> & {
  drain: (pipePromise: Promise<void>) => Promise<void>
}

/**
 * Create a `ReadableWritablePair` stream queuing written messages until they are read from the other end.
 *
 * The returned `drain` function closes the readable directly (bypassing the
 * writable's writer lock) and waits for the given `pipePromise` to flush all
 * buffered values.
 */
export function createPipe<T>(options: ChannelOptions = {}): Pipe<T> {
  const { readable, writable, close } = createChannel<T>(options)

  async function drain(pipePromise: Promise<void>): Promise<void> {
    close()
    try {
      await pipePromise
    } catch {
      // Pipe may have errored
    }
  }

  return { readable, writable, drain }
}
