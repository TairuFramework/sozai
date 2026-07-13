import { onAbort, raceSignal, ScheduledTimeout, TimeoutInterruption } from '@sozai/async'

import { claimLockFile, reapLockFile } from './file.js'
import { isStale } from './liveness.js'
import { enterQueue } from './queue.js'
import { createLockRecord, retryBootIDRead } from './record.js'

export type FileLockOptions = {
  /**
   * Milliseconds to wait for the lock before throwing. Bounds ACQUISITION ONLY — once the lock
   * is held, the critical section runs to completion. Default 10_000.
   *
   * `0` means TRY-LOCK: one attempt, no waiting. It may still reap a stale holder and re-attempt
   * the claim immediately (reaping is not waiting), but it never backs off and never queues
   * behind a same-process caller — any live contention throws `TimeoutInterruption` at once.
   */
  timeout?: number
  /**
   * Milliseconds after which a holder whose liveness cannot be proven (a foreign host, a
   * different boot, a corrupt record) is treated as stale. A holder that IS provably alive is
   * never stale, whatever this is set to. Default 60_000.
   */
  staleTimeout?: number
  /**
   * Initial backoff ceiling in milliseconds: the backoff is halved and jittered, so the first
   * realized delay is uniform in `[retryDelay / 2, retryDelay)`. Default 10.
   */
  retryDelay?: number
  /** Retry delay ceiling in milliseconds. Default 250. */
  maxRetryDelay?: number
  /** Aborts a pending acquisition. Has no effect once the lock is held. */
  signal?: AbortSignal
}

export type FileLock = Disposable & {
  readonly path: string
  /** Unlink the lockfile, but only while it still holds the inode we linked. Idempotent. */
  release(): void
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_STALE_TIMEOUT = 60_000
const DEFAULT_RETRY_DELAY = 10
const DEFAULT_MAX_RETRY_DELAY = 250

/**
 * Every lock this process currently holds, so a clean exit does not leave one behind for the next
 * run to wait out.
 *
 * It covers EXACTLY two exits: `process.exit()`, and a natural drain of the event loop. Nothing
 * else. A default-handled SIGINT or SIGTERM terminates Node WITHOUT emitting `'exit'`, so the
 * hook does not run — and SIGKILL and hard crashes never could. That is fine, and deliberate: a
 * signalled process's pid is gone, so the next waiter's probe returns `'dead'` and reaps the
 * lockfile at once, with no TTL wait. Installing SIGINT/SIGTERM handlers here would buy nothing
 * and cost a great deal — a library that handles them silently changes its host process's
 * termination behavior.
 */
const heldLocks = new Set<{ path: string; inode: number }>()
let exitHookInstalled = false

function trackHeldLock(entry: { path: string; inode: number }): void {
  heldLocks.add(entry)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const held of heldLocks) {
        // Inode-guarded, like `release()`: it will not remove a lock that has already been replaced
        // by another holder's. (Guarded, not atomic — `reapLockFile` explains the residual window
        // this cannot close. The temp-file `rmSync` in `claimLockFile` and the sweeper are NOT
        // inode-guarded, and need not be: they only ever touch our own temp name, or orphans too
        // old for any live claim to still be linking.)
        reapLockFile(held.path, held.inode)
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
 * Sleep, CANCELLABLY. `sleep()` from `@sozai/async` is a bare `setTimeout` with no cancellation,
 * and `raceSignal` only wins the race — it never clears the loser's timer. Racing the two would
 * therefore leave a live timer holding the event loop open for up to `maxRetryDelay` after this
 * acquisition has already rejected, and `maxRetryDelay` is a public option: a caller passing
 * 30_000 would keep their process alive for 30s past an abort. Rejecting here clears the timer.
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
 * Acquire an exclusive cross-process lock on `lockPath`, waiting for the current holder to
 * release it. Throws `TimeoutInterruption` when the lock cannot be taken within `timeout`, and
 * rejects with `signal.reason` when the caller aborts. It never resolves without the lock.
 *
 * `timeout: 0` is a TRY-LOCK: one attempt, no waiting at all. See `FileLockOptions.timeout`.
 *
 * `lockPath` MUST be on a local filesystem: the atomicity of `link()` is not guaranteed on NFS.
 *
 * Not reentrant: acquiring the same path twice in one process, without releasing, deadlocks until
 * the timeout fires.
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

  // A boot-ID source that failed at an earlier claim is read again here, and only here: the two
  // reads of one acquisition's budget land in the same tick, so the gap between one acquisition and
  // the next is the only real time this synchronous path has to let an `EMFILE` storm or a sandbox
  // hiccup clear. It must happen BEFORE `createLockRecord()` below, whose `bootID` is frozen on the
  // record for the life of the hold. Free on the path everyone is actually on: a boot ID that has
  // been read, or a platform that publishes none, is never re-read. See `retryBootIDRead`.
  retryBootIDRead()

  // One attempt, no waiting: the deadline below is scheduled all the same (and disposed), but a
  // try-lock throws from the code path that WOULD have waited, so the timer never decides.
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

  // The queue slot must be released on EVERY exit path, or the callers behind us wait forever.
  const slot = enterQueue(lockPath)
  try {
    if (tryLock) {
      // A try-lock does not queue behind a same-process predecessor either: that is contention
      // like any other. `slot.free` answers "does anyone in this process hold the path right now"
      // synchronously, from a count taken at entry — exact, and free of the microtask timing that
      // a promise race would have made the verdict depend on. The turn is then already destined to
      // resolve; awaiting it only lets the chain hand the path over in order.
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
      if ('inode' in result) {
        const held = { path: lockPath, inode: result.inode }
        trackHeldLock(held)

        let released = false
        const release = (): void => {
          if (released) {
            return
          }
          released = true
          heldLocks.delete(held)
          reapLockFile(lockPath, held.inode)
          slot.release()
        }
        return { path: lockPath, release, [Symbol.dispose]: release }
      }

      const entry = result.conflict
      if (entry.inode != null && isStale(entry, staleTimeout)) {
        if (!tryLock) {
          // Reaping is inode-guarded but NOT atomic — see `reapLockFile`, which spells out the
          // residual window. That window only opens when waiters reap in LOCKSTEP, which is
          // exactly what a stale lock produces: N waiters, all released by the same conflict, all
          // classifying it stale in the same tick. Desynchronize them first. (A try-lock does not
          // wait, so it skips this and accepts the odds.)
          await sleepFor(Math.random() * retryDelay, controller.signal)
        }
        if (reapLockFile(lockPath, entry.inode)) {
          // The holder is gone and its file with it. Claim again immediately.
          continue
        }
      }
      // Either the holder is alive, or we lost the reap race to another waiter. Both mean: back
      // off and look again — and backing off is waiting, which a try-lock does not do.
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
 * Run `fn` under an exclusive cross-process lock on `lockPath`, releasing it however `fn`
 * settles. If the lock cannot be acquired within `timeout`, this THROWS and `fn` is never called:
 * running the critical section unlocked would drop the guard at exactly the moment contention is
 * real.
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
