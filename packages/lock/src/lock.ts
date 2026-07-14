import { onAbort, raceSignal, ScheduledTimeout, TimeoutInterruption } from '@sozai/async'

import { claimLockFile, type LockEntry, reapLockFile } from './file.js'
import { isStale } from './liveness.js'
import { enterQueue } from './queue.js'
import { createLockRecord, retryBootIDRead } from './record.js'

export type FileLockOptions = {
  /**
   * Milliseconds to wait for the lock before throwing. Bounds ACQUISITION ONLY — once
   * the lock is held, the critical section runs to completion. Default 10_000.
   *
   * `0` is a TRY-LOCK: one attempt, no waiting, no backoff, no queuing behind a
   * same-process caller. Any contention throws `TimeoutInterruption` at once.
   */
  timeout?: number
  /**
   * Milliseconds after which a holder whose liveness cannot be proven (a foreign host,
   * a different boot, a corrupt record) is treated as stale. A provably-alive holder is
   * never stale, whatever this is set to. Default 60_000.
   */
  staleTimeout?: number
  /** Initial backoff ceiling in milliseconds; halved and jittered. Default 10. */
  retryDelay?: number
  /** Retry delay ceiling in milliseconds. Default 250. */
  maxRetryDelay?: number
  /** Aborts a pending acquisition. Has no effect once the lock is held. */
  signal?: AbortSignal
}

export type FileLock = Disposable & {
  readonly path: string
  /** Unlink the lockfile, but only while it is still the one we claimed. Idempotent. */
  release(): void
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_STALE_TIMEOUT = 60_000
const DEFAULT_RETRY_DELAY = 10
const DEFAULT_MAX_RETRY_DELAY = 250

/**
 * Locks this process currently holds, so a clean exit does not leave one behind. Covers
 * only `process.exit()` and a natural event-loop drain — a default-handled SIGINT/SIGTERM
 * skips `'exit'`, and SIGKILL always does. That's fine: a signalled process's pid is
 * gone, so the next waiter's probe returns `'dead'` and reaps at once, no TTL wait.
 */
type HeldLock = { path: string; entry: LockEntry }

const heldLocks = new Set<HeldLock>()
let exitHookInstalled = false

function trackHeldLock(held: HeldLock): void {
  heldLocks.add(held)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const { path, entry } of heldLocks) {
        // Guarded, like `release()` — see `reapLockFile` for the residual window this cannot close.
        reapLockFile(path, entry)
      }
    })
  }
}

/** Exponential backoff, halved and jittered so processes released together do not re-collide. */
function backoffDelay(attempt: number, retryDelay: number, maxRetryDelay: number): number {
  const ceiling = Math.min(retryDelay * 2 ** attempt, maxRetryDelay)
  return ceiling / 2 + Math.random() * (ceiling / 2)
}

/**
 * Sleep, CANCELLABLY. `sleep()` from `@sozai/async` never clears its timer, and racing
 * it against `raceSignal` would leave that timer holding the event loop open past an
 * abort — `maxRetryDelay` is a public option, so that could be seconds.
 */
function sleepFor(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve()
    }, delay)
    const unsubscribe = onAbort(signal, () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })
}

/**
 * Acquire an exclusive cross-process lock on `lockPath`, waiting for the current holder
 * to release it. Throws `TimeoutInterruption` when the lock cannot be taken within
 * `timeout`, and rejects with `signal.reason` when the caller aborts. Never resolves
 * without the lock.
 *
 * `timeout: 0` is a TRY-LOCK: one attempt, no waiting at all. See `FileLockOptions.timeout`.
 *
 * `lockPath` MUST be on a local filesystem: the atomicity of `link()` is not guaranteed on NFS.
 *
 * Not reentrant: acquiring the same path twice in one process, without releasing,
 * deadlocks until the timeout fires.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLock> {
  const {
    timeout = DEFAULT_TIMEOUT,
    staleTimeout = DEFAULT_STALE_TIMEOUT,
    retryDelay = DEFAULT_RETRY_DELAY,
    maxRetryDelay = DEFAULT_MAX_RETRY_DELAY,
    signal,
  } = options

  // Must happen before `createLockRecord()` below, whose `bootID` is frozen on the record
  // for the life of the hold. See `retryBootIDRead`.
  retryBootIDRead()

  // A try-lock still schedules (and disposes) the deadline below, but throws from the
  // path that would have waited, so the timer never gets to decide anything.
  const tryLock = timeout === 0
  const timeoutMessage = `Timeout acquiring lock ${lockPath} after ${timeout}ms`

  using deadline = ScheduledTimeout.in(timeout, { message: timeoutMessage })
  const controller = new AbortController()
  const unsubscribeDeadline = onAbort(deadline.signal, () => {
    controller.abort(deadline.signal.reason)
  })
  const unsubscribeCaller = onAbort(signal, () => {
    controller.abort(signal?.reason)
  })

  // Must be released on EVERY exit path, or the callers behind us wait forever.
  const slot = enterQueue(lockPath)
  try {
    if (tryLock) {
      // A try-lock does not queue behind a same-process predecessor either: that is
      // contention like any other. `slot.free` is decided synchronously at entry (see
      // `enterQueue`), so this never depends on microtask timing.
      if (!slot.free) {
        throw new TimeoutInterruption({ message: timeoutMessage })
      }
      await slot.turn
    } else {
      await raceSignal(slot.turn, controller.signal)
    }

    const record = createLockRecord()
    let attempt = 0

    for (;;) {
      controller.signal.throwIfAborted()

      const result = claimLockFile(lockPath, record)
      if ('held' in result) {
        const held = { path: lockPath, entry: result.held }
        trackHeldLock(held)

        let released = false
        const release = (): void => {
          if (released) {
            return
          }
          released = true
          heldLocks.delete(held)
          reapLockFile(lockPath, held.entry)
          slot.release()
        }
        return { path: lockPath, release, [Symbol.dispose]: release }
      }

      const entry = result.conflict
      if (entry.inode != null && isStale(entry, staleTimeout)) {
        if (!tryLock) {
          // Desynchronize before reaping: `reapLockFile` is guarded but not atomic, and
          // lockstep reaping by multiple waiters is exactly what a stale lock produces.
          // A try-lock skips this and accepts the odds.
          await sleepFor(Math.random() * retryDelay, controller.signal)
        }
        if (reapLockFile(lockPath, entry)) {
          // The holder is gone and its file with it. Claim again immediately.
          continue
        }
      }
      // Either the holder is alive, or we lost the reap race to another waiter. Back off
      // and look again — which a try-lock does not do.
      if (tryLock) {
        throw new TimeoutInterruption({ message: timeoutMessage })
      }
      await sleepFor(backoffDelay(attempt++, retryDelay, maxRetryDelay), controller.signal)
    }
  } catch (err) {
    slot.release()
    throw err
  } finally {
    unsubscribeDeadline()
    unsubscribeCaller()
  }
}

/**
 * Run `fn` under an exclusive cross-process lock on `lockPath`, releasing it however
 * `fn` settles. If the lock cannot be acquired within `timeout`, this THROWS and `fn` is
 * never called — running the critical section unlocked is not an option.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lock = await acquireFileLock(lockPath, options)
  try {
    return await fn()
  } finally {
    lock.release()
  }
}
