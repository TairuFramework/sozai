import { defer } from './defer.js'

/** A reserved turn in a keyed queue. */
export type QueueSlot = {
  /** Resolves when every earlier caller on this key has released. */
  turn: Promise<void>
  /**
   * Whether the key was free at the instant this slot entered: no earlier caller still
   * holds it, so `turn` is already destined to resolve and only an external resource can contend.
   *
   * Decided SYNCHRONOUSLY, from a count, rather than by racing `turn` against a resolved
   * sentinel: that would cost extra microtask hops, so a slot behind a fully-released
   * predecessor would still read as pending, with the verdict depending on timing.
   */
  free: boolean
  /** Hand the key to the next caller. Idempotent, and safe to call before the turn arrives. */
  release: () => void
}

/** The tail of one key's chain, and how many of its callers have yet to release. */
type QueueState = {
  tail: Promise<void>
  holding: number
}

/** A FIFO queue whose keys run independently. Each queue instance owns its state. */
export type KeyedQueue<TKey = unknown> = {
  /** Number of keys whose slot chains have not drained yet. */
  get size(): number
  /** Reserve a slot synchronously. Release it even if its turn is abandoned. */
  enter: (key: TKey) => QueueSlot
  /** Run a task on its turn, releasing its slot after success or failure. */
  run: <TResult>(key: TKey, fn: () => TResult | PromiseLike<TResult>) => Promise<TResult>
}

/**
 * Create a FIFO queue per key. Failures never block later tasks.
 * Slot chains only resolve, and drained tails remove their map entries.
 */
export function createKeyedQueue<TKey = unknown>(): KeyedQueue<TKey> {
  const queues = new Map<TKey, QueueState>()

  function enter(key: TKey): QueueSlot {
    const state = queues.get(key)
    const previous = state?.tail ?? Promise.resolve()
    // Counted BEFORE this slot joins: zero means every earlier caller has released. A
    // `holding: 0` entry still in the map is a settled chain not yet dropped -- free, all the same.
    const free = (state?.holding ?? 0) === 0

    const ticket = defer<void>()
    // Built from tickets that only ever resolve, so the chain can never reject and no
    // caller can poison the queue for the ones behind it.
    const current = previous.then(() => ticket.promise)
    if (state == null) {
      queues.set(key, { tail: current, holding: 1 })
    } else {
      state.tail = current
      state.holding += 1
    }

    let released = false
    return {
      turn: previous,
      free,
      release(): void {
        if (released) {
          return
        }
        released = true
        // Synchronous, and before the ticket resolves: the next `enter` on this key
        // sees the key free in the very same tick.
        const entry = queues.get(key)
        if (entry != null) {
          entry.holding -= 1
        }
        ticket.resolve()
        void current.then(() => {
          // Only the tail may drop the entry: a later caller may already have chained onto
          // it. The tail settling means every ticket before it resolved, so `holding` is
          // necessarily 0 here.
          if (queues.get(key)?.tail === current) {
            queues.delete(key)
          }
        })
      },
    }
  }

  return {
    get size(): number {
      return queues.size
    },

    enter,
    async run<TResult>(key: TKey, fn: () => TResult | PromiseLike<TResult>): Promise<TResult> {
      const slot = enter(key)
      try {
        await slot.turn
        return await fn()
      } finally {
        slot.release()
      }
    },
  }
}
