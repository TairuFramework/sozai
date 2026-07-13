import { resolve } from 'node:path'

import { defer } from '@sozai/async'

export type QueueSlot = {
  /** Resolves when every earlier caller on this path has released. */
  turn: Promise<void>
  /** Hand the path to the next caller. Idempotent, and safe to call before the turn arrives. */
  release: () => void
}

/**
 * FIFO chain of same-process callers, one per resolved path.
 *
 * Without it, two callers in one process fight through the filesystem — and the second reads a
 * lockfile whose pid is its OWN live pid, so it can never reap it and simply polls until the
 * first releases. Correct, but it pays backoff latency for the most common case in an app.
 *
 * The map is per-realm, like any module state: it does not span worker threads or `vm` contexts,
 * and it does not need to. The file is the lock; this is only a fast path in front of it.
 *
 * Keyed on `resolve`, not `realpath`, because the lockfile need not exist yet. Two aliased paths
 * (through a symlinked directory) therefore fall back to filesystem contention — correct, merely
 * slower.
 */
const queues = new Map<string, Promise<void>>()

export function enterQueue(lockPath: string): QueueSlot {
  const key = resolve(lockPath)
  const previous = queues.get(key) ?? Promise.resolve()
  const ticket = defer<void>()
  // The chain is built from tickets that only ever resolve, so it can never reject and no
  // caller can poison the queue for the ones behind it.
  const current = previous.then(() => ticket.promise)
  queues.set(key, current)

  let released = false
  return {
    turn: previous,
    release(): void {
      if (released) {
        return
      }
      released = true
      ticket.resolve()
      void current.then(() => {
        // Only the tail may drop the entry: a later caller may already have chained onto it.
        if (queues.get(key) === current) {
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
