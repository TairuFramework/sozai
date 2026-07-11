import { type ChannelOptions, createChannel } from './channel.js'

/**
 * Create a tuple of `ReadableWritablePair` streams connected to each other.
 *
 * Each direction is an independent channel: aborting or cancelling one leaves the other
 * usable. The `highWaterMark` option, if given, applies to both directions.
 */
export function createConnection<AtoB, BtoA = AtoB>(
  options: ChannelOptions = {},
): [ReadableWritablePair<BtoA, AtoB>, ReadableWritablePair<AtoB, BtoA>] {
  // `toA` carries messages B writes and A reads; `toB` the reverse.
  const toA = createChannel<BtoA>(options)
  const toB = createChannel<AtoB>(options)

  return [
    { readable: toA.readable, writable: toB.writable },
    { readable: toB.readable, writable: toA.writable },
  ]
}
