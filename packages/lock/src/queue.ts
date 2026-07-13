import { resolve } from 'node:path'

import { defer } from '@sozai/async'

export type QueueSlot = {
  /** Resolves when every earlier caller on this path has released. */
  turn: Promise<void>
  /**
   * Whether the path was free at the instant this slot entered: no earlier caller still holds it,
   * so `turn` is already destined to resolve and only the filesystem can contend.
   *
   * Decided SYNCHRONOUSLY, from a count, rather than by racing `turn` against a resolved
   * sentinel: the chain resolves each link with a thenable, costing two extra microtask hops, so a
   * slot behind a fully-released predecessor would still read as pending — and the verdict would
   * depend on how many hops the caller happened to sit behind.
   */
  free: boolean
  /** Hand the path to the next caller. Idempotent, and safe to call before the turn arrives. */
  release: () => void
}

/** The tail of one path's chain, and how many of its callers have yet to release. */
type QueueState = {
  tail: Promise<void>
  holding: number
}

/**
 * FIFO chain of same-process callers, one per resolved path.
 *
 * Without it, two callers in one process fight through the filesystem: the second reads a
 * lockfile with its OWN live pid, so it can never reap it and simply polls until the first
 * releases (correct, but pays backoff latency for the common case).
 *
 * Per-realm, like any module state — does not span worker threads or `vm` contexts, and does not
 * need to; the file is the lock, this is only a fast path in front of it. Keyed on `resolve`, not
 * `realpath`, because the lockfile need not exist yet: two aliased paths (via a symlinked
 * directory) fall back to filesystem contention, merely slower.
 */
const queues = new Map<string, QueueState>()

export function enterQueue(lockPath: string): QueueSlot {
  const key = resolve(lockPath)
  const state = queues.get(key)
  const previous = state?.tail ?? Promise.resolve()
  // Counted BEFORE this slot joins: zero means every earlier caller has released, so nobody in
  // this process holds the path right now. A state left in the map with `holding: 0` is a chain
  // whose tail has settled but whose entry has not been dropped yet — free, all the same.
  const free = (state?.holding ?? 0) === 0

  const ticket = defer<void>()
  // The chain is built from tickets that only ever resolve, so it can never reject and no
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
      // Synchronous, and before the ticket resolves: the next `enterQueue` on this path sees the
      // path free in the very same tick, with no microtask in between.
      const entry = queues.get(key)
      if (entry != null) {
        entry.holding -= 1
      }
      ticket.resolve()
      void current.then(() => {
        // Only the tail may drop the entry: a later caller may already have chained onto it. The
        // tail settling means every ticket before it resolved, so `holding` is necessarily 0 here.
        if (queues.get(key)?.tail === current) {
          queues.delete(key)
        }
      })
    },
  }
}

/** Test-only introspection: the number of paths currently queued. Not part of the public API. */
export function getQueueSize(): number {
  return queues.size
}
