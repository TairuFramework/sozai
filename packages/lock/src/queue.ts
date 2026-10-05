import { resolve } from 'node:path'
import type { QueueSlot } from '@sozai/async'
import { createKeyedQueue } from '@sozai/async'

export type { QueueSlot } from '@sozai/async'

/**
 * FIFO chain of same-process callers, one per resolved path.
 *
 * Without it, two callers in one process fight through the filesystem: the second reads
 * a lockfile with its OWN live pid, so it can never reap it and simply polls until the
 * first releases (correct, but pays backoff latency for the common case).
 *
 * Per-realm, like any module state — does not span worker threads or `vm` contexts, and
 * does not need to; the file is the lock, this is only a fast path in front of it. Keyed
 * on `resolve`, not `realpath`, because the lockfile need not exist yet: two aliased
 * paths (via a symlinked directory) fall back to filesystem contention, merely slower.
 */
const queue = createKeyedQueue<string>()

export function enterQueue(lockPath: string): QueueSlot {
  return queue.enter(resolve(lockPath))
}

/** Test-only introspection: the number of paths currently queued. Not part of the public API. */
export function getQueueSize(): number {
  return queue.size
}
