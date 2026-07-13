import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { TimeoutInterruption } from '@sozai/async'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { claimLockFile, readLockEntry } from '../src/file.js'
import { TimeoutInterruption as LockTimeoutInterruption } from '../src/index.js'
import { acquireFileLock, withFileLock } from '../src/lock.js'
import { getBootAt, getBootID, getUptimeAt, type LockRecord } from '../src/record.js'

/**
 * A same-host holder is aged MONOTONICALLY, from `os.uptime()` — so a test that fabricates a
 * 61-second-old holder needs a host that has been up for at least 61 seconds. CI runs on
 * freshly-booted VMs, where it has not been. Left to the real uptime, every reap test below
 * silently becomes its own opposite: the fabricated `uptimeAt` bottoms out, the holder's monotonic
 * age collapses to the host's own uptime, nothing is stale, and the reap never happens.
 *
 * Pin the uptime instead. The ages these tests claim are then the ages they have.
 */
const { HOST_UPTIME_SECONDS } = vi.hoisted(() => ({ HOST_UPTIME_SECONDS: 60 * 60 }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, uptime: () => HOST_UPTIME_SECONDS }
})

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-'))
  lockPath = join(dir, 'store.lock')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../src/file.js')
  vi.doUnmock('../src/record.js')
  vi.resetModules()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A holder this process cannot probe: same host, but a boot that is not ours — by the boot ID
 * (a different one) and, for a platform that publishes none, by a `bootAt` far outside the
 * tolerance. Same-host holders are aged monotonically, so the record's uptime has to carry the
 * same age as its `startedAt`.
 */
function unprovableHolder(startedAt: number): LockRecord {
  const age = Date.now() - startedAt
  const uptimeAt = getUptimeAt() - age
  if (uptimeAt < 0) {
    // Never clamp: a record older than the host's uptime cannot be written, and clamping it to 0
    // would quietly hand back a holder younger than the test asked for — turning a reap test into
    // a no-op that passes for the wrong reason, or hangs for the wrong reason.
    throw new Error(
      `unprovableHolder: a holder aged ${age}ms cannot exist on a host up for ${getUptimeAt()}ms. Raise HOST_UPTIME_SECONDS.`,
    )
  }
  return {
    pid: 999_999,
    hostname: hostname(),
    bootID: 'f1c0de00-0000-4000-8000-notourboot',
    bootAt: getBootAt() - 10 * 60 * 60 * 1000,
    startedAt,
    uptimeAt,
  }
}

describe('acquireFileLock()', () => {
  test('acquires a free lock and writes a record', async () => {
    const lock = await acquireFileLock(lockPath)

    expect(lock.path).toBe(lockPath)
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)

    lock.release()
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  /**
   * The boot-ID retry budget is per ACQUISITION, and `acquireFileLock` is what resets it: two reads
   * of a failing source land in one tick, so an outage that outlasts a tick fails both — and
   * without a reset that single unlucky claim would leave the process on the clock-step-vulnerable
   * `bootAt` fallback for the rest of its life. The next acquisition is the only real time this
   * synchronous path has, so it is where the source is tried again.
   *
   * It must be reset BEFORE the record is built: the record's `bootID` is frozen for the life of
   * the hold, so a record built from the previous acquisition's settled `null` carries that `null`
   * to every waiter that ever evaluates it.
   */
  test('resets the boot-ID retry budget before it builds a record', async () => {
    vi.resetModules()
    const retryBootIDRead = vi.fn()
    const createLockRecord = vi.fn()
    vi.doMock('../src/record.js', async () => {
      const actual = await vi.importActual<typeof import('../src/record.js')>('../src/record.js')
      retryBootIDRead.mockImplementation(actual.retryBootIDRead)
      createLockRecord.mockImplementation(actual.createLockRecord)
      return { ...actual, retryBootIDRead, createLockRecord }
    })
    const { acquireFileLock: acquireWithSpiedRecord } = await import('../src/lock.js')

    const lock = await acquireWithSpiedRecord(lockPath, { timeout: 1_000 })
    lock.release()

    expect(retryBootIDRead).toHaveBeenCalledTimes(1)
    expect(createLockRecord).toHaveBeenCalledTimes(1)
    expect(retryBootIDRead.mock.invocationCallOrder[0] as number).toBeLessThan(
      createLockRecord.mock.invocationCallOrder[0] as number,
    )
  })

  test('release is idempotent and never removes a lock that is not ours', async () => {
    const lock = await acquireFileLock(lockPath)
    lock.release()

    // Someone else takes the path.
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const holder = readLockEntry(lockPath).record

    lock.release()

    expect(readLockEntry(lockPath).record).toEqual(holder)
  })

  test('works as a Disposable', async () => {
    {
      using lock = await acquireFileLock(lockPath)
      expect(lock.path).toBe(lockPath)
      expect(readLockEntry(lockPath).record).not.toBeNull()
    }
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  test('reaps a dead holder and takes the lock', async () => {
    // A record with our host and boot, but a pid that no longer exists.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process')
      err.code = 'ESRCH'
      throw err
    })
    claimLockFile(lockPath, {
      pid: 999_999,
      hostname: hostname(),
      bootID: getBootID(),
      bootAt: getBootAt(),
      startedAt: Date.now(),
      uptimeAt: getUptimeAt(),
    })

    const lock = await acquireFileLock(lockPath, { timeout: 1_000 })
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    lock.release()
  })

  // `statSync` then `rmSync` is two syscalls: N waiters released together by the same stale lock
  // classify it in lockstep, and the lockstep reap is the interleaving that can slip a waiter's
  // unlink between another's inode check and its own claim. A short jitter breaks the lockstep.
  test('waits a jitter before reaping a stale holder, so waiters do not reap in lockstep', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    claimLockFile(lockPath, unprovableHolder(Date.now() - 61_000))

    const start = Date.now()
    const lock = await acquireFileLock(lockPath, {
      timeout: 1_000,
      staleTimeout: 60_000,
      retryDelay: 200,
    })
    const elapsed = Date.now() - start

    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    // Uniform in [0, retryDelay): 0.5 of 200ms.
    expect(elapsed).toBeGreaterThanOrEqual(60)
    lock.release()
  })

  // A try-lock does not wait, and the jitter is waiting.
  test('a try-lock reaps a stale holder without the jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    claimLockFile(lockPath, unprovableHolder(Date.now() - 61_000))

    const start = Date.now()
    const lock = await acquireFileLock(lockPath, {
      timeout: 0,
      staleTimeout: 60_000,
      retryDelay: 400,
    })
    const elapsed = Date.now() - start

    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    expect(elapsed).toBeLessThan(100)
    lock.release()
  })

  test('reaps an unprovable holder once its TTL has expired', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now() - 61_000))

    const lock = await acquireFileLock(lockPath, { timeout: 1_000, staleTimeout: 60_000 })
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    lock.release()
  })

  test('reaps a corrupt record once its TTL has expired', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    writeFileSync(lockPath, '{ not json')
    // A corrupt record cannot date itself, so the file's mtime dates it. Backdate the file rather
    // than passing `staleTimeout: 0`, which would race the millisecond the file was written.
    const longAgo = new Date(Date.now() - 61_000)
    utimesSync(lockPath, longAgo, longAgo)

    const lock = await acquireFileLock(lockPath, { timeout: 1_000, staleTimeout: 60_000 })
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    lock.release()
  })

  test('times out rather than taking a lock from a holder within its TTL', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const holder = readLockEntry(lockPath).record

    await expect(
      acquireFileLock(lockPath, { timeout: 100, staleTimeout: 60_000 }),
    ).rejects.toBeInstanceOf(TimeoutInterruption)

    // The holder's lock is untouched.
    expect(readLockEntry(lockPath).record).toEqual(holder)
  })

  // "Someone else holds the lock" is the most misleading diagnosis this package can emit about a
  // path that is simply not a lockfile. The real error, at once.
  test('reports a misconfigured path immediately, not as a held lock', async () => {
    mkdirSync(lockPath, { recursive: true })

    const acquiring = acquireFileLock(lockPath, { timeout: 5_000 })
    await expect(acquiring).rejects.toThrow(/EISDIR|EPERM|EACCES/)
    await expect(acquiring).rejects.not.toBeInstanceOf(TimeoutInterruption)
  })

  // Consumers must be able to catch this without adding @sozai/async as their own dependency.
  test('rejects with a TimeoutInterruption importable from the package entrypoint', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))

    await expect(
      acquireFileLock(lockPath, { timeout: 100, staleTimeout: 60_000 }),
    ).rejects.toBeInstanceOf(LockTimeoutInterruption)
  })

  test('rejects with the caller reason when the signal aborts mid-wait', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const controller = new AbortController()
    const reason = new Error('caller gave up')

    const acquiring = acquireFileLock(lockPath, { timeout: 5_000, signal: controller.signal })
    setTimeout(() => controller.abort(reason), 20)

    await expect(acquiring).rejects.toBe(reason)
  })

  describe('timeout: 0 (try-lock)', () => {
    test('acquires an uncontended lock', async () => {
      const lock = await acquireFileLock(lockPath, { timeout: 0 })
      expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
      lock.release()
    })

    // Reaping is not waiting: a stale holder's file is removed and the claim retried at once.
    test('reaps a stale holder and takes the lock, without waiting', async () => {
      claimLockFile(lockPath, unprovableHolder(Date.now() - 61_000))

      const lock = await acquireFileLock(lockPath, { timeout: 0, staleTimeout: 60_000 })
      expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
      lock.release()
    })

    // A macrotask never runs: the rejection has to arrive before a timer queued BEFORE the call.
    test('throws rather than backing off against a live holder, in the same tick', async () => {
      claimLockFile(lockPath, unprovableHolder(Date.now()))
      const holder = readLockEntry(lockPath).record
      let timerFired = false
      setTimeout(() => {
        timerFired = true
      }, 0)

      await expect(
        acquireFileLock(lockPath, { timeout: 0, staleTimeout: 60_000 }),
      ).rejects.toBeInstanceOf(TimeoutInterruption)

      expect(timerFired).toBe(false)
      expect(readLockEntry(lockPath).record).toEqual(holder)
    })

    // A same-process predecessor holding the queue slot is contention like any other.
    test('throws rather than queueing behind an in-process holder, in the same tick', async () => {
      const held = await acquireFileLock(lockPath)
      let timerFired = false
      setTimeout(() => {
        timerFired = true
      }, 0)

      await expect(acquireFileLock(lockPath, { timeout: 0 })).rejects.toBeInstanceOf(
        TimeoutInterruption,
      )

      expect(timerFired).toBe(false)
      held.release()
    })

    // The predecessor is GONE — the lockfile is not on disk — so this must acquire. Deciding
    // availability by racing the queue turn against a resolved sentinel made this throw: a chain
    // resolved with a thenable stays pending for two more microtask hops after the release, so the
    // verdict depended on how many hops the caller happened to sit behind.
    test('acquires a lock its in-process predecessor has already released', async () => {
      const held = await acquireFileLock(lockPath)
      held.release()
      expect(readLockEntry(lockPath).record).toBeNull()

      const lock = await acquireFileLock(lockPath, { timeout: 0 })
      expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
      lock.release()
    })

    // The natural try-lock loop — try, work, release, try again — must not fail on iteration two.
    test('a try-lock loop acquires on every iteration', async () => {
      for (let index = 0; index < 3; index++) {
        const lock = await acquireFileLock(lockPath, { timeout: 0 })
        expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
        lock.release()
      }
    })

    test('releases its queue slot when it throws, so the next caller is not stranded', async () => {
      const held = await acquireFileLock(lockPath)
      await expect(acquireFileLock(lockPath, { timeout: 0 })).rejects.toBeInstanceOf(
        TimeoutInterruption,
      )

      const successor = acquireFileLock(lockPath, { timeout: 1_000 })
      held.release()

      const lock = await successor
      expect(lock.path).toBe(lockPath)
      lock.release()
    })
  })

  // A backoff timer that outlives the rejection keeps the event loop open for up to
  // `maxRetryDelay` — a public option — so an aborted acquire could hold a process up for the
  // 30s the caller configured, long after it gave up.
  test('leaves no timer running once the acquisition has rejected', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))

    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    // Only long timers are tracked: short ones belong to the test runner, not to us.
    const pending = new Map<unknown, number>()
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      delay?: number,
    ): NodeJS.Timeout => {
      const handle = realSetTimeout(fn, delay)
      if ((delay ?? 0) >= 1_000) {
        pending.set(handle, delay as number)
      }
      return handle
    }) as typeof globalThis.setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: NodeJS.Timeout): void => {
      pending.delete(handle)
      realClearTimeout(handle)
    }) as typeof globalThis.clearTimeout)

    const controller = new AbortController()
    const acquiring = acquireFileLock(lockPath, {
      timeout: 30_000,
      staleTimeout: 60_000,
      retryDelay: 20_000,
      maxRetryDelay: 20_000,
      signal: controller.signal,
    })
    await new Promise((resolve) => realSetTimeout(resolve, 20))
    controller.abort(new Error('gave up'))
    await expect(acquiring).rejects.toThrow('gave up')

    // Both the 30s deadline and the 10-20s backoff sleep must be gone.
    expect([...pending.values()]).toEqual([])
  })

  // `using deadline` disposes its `ScheduledTimeout` when this function returns. If that `using`
  // ever degraded to a plain `const`, a SUCCESSFUL acquire would leave the deadline's timer
  // running for the rest of `timeout` — a CLI that acquires, does its work, and releases would
  // hang open for up to `timeout` past the point it had nothing left to do.
  test('leaves no timer running after a successful acquire and release', async () => {
    vi.useFakeTimers()
    try {
      const lock = await acquireFileLock(lockPath, { timeout: 30_000 })
      lock.release()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // The abort-driven `catch { slot.release(); throw }` is shared by every exit path, but a caller
  // whose OWN `timeout` fires while still queued behind an in-process holder (no signal involved)
  // is a different trigger through that same catch. If it failed to release the slot, a live
  // caller queued behind the timed-out one would wait forever.
  test('releases its queue slot when its own timeout fires while still queued, so the next caller is not stranded', async () => {
    const held = await acquireFileLock(lockPath)

    await expect(acquireFileLock(lockPath, { timeout: 50 })).rejects.toBeInstanceOf(
      TimeoutInterruption,
    )

    held.release()
    const lock = await acquireFileLock(lockPath, { timeout: 1_000 })
    expect(lock.path).toBe(lockPath)
    lock.release()
  })

  // A `claimLockFile` throw mid-loop (a real I/O error, not EEXIST/ENOENT) goes through the same
  // catch as an abort. Pin that it releases the queue slot too: a caller stuck here would strand
  // every same-process caller behind it on this path.
  test('releases its queue slot when claimLockFile throws mid-loop, so the next caller is not stranded', async () => {
    vi.resetModules()
    let throwOnce = true
    vi.doMock('../src/file.js', async () => {
      const actual = await vi.importActual<typeof import('../src/file.js')>('../src/file.js')
      return {
        ...actual,
        claimLockFile: (path: string, record: LockRecord) => {
          if (throwOnce) {
            throwOnce = false
            const err: NodeJS.ErrnoException = new Error('EACCES: permission denied')
            err.code = 'EACCES'
            throw err
          }
          return actual.claimLockFile(path, record)
        },
      }
    })

    const { acquireFileLock: acquireWithFaultyClaim } = await import('../src/lock.js')

    await expect(acquireWithFaultyClaim(lockPath, { timeout: 1_000 })).rejects.toThrow('EACCES')

    const lock = await acquireWithFaultyClaim(lockPath, { timeout: 1_000 })
    expect(lock.path).toBe(lockPath)
    lock.release()
  })

  test('an abandoned waiter does not strand the next caller in this process', async () => {
    const held = await acquireFileLock(lockPath)
    const controller = new AbortController()

    const abandoned = acquireFileLock(lockPath, { timeout: 5_000, signal: controller.signal })
    const successor = acquireFileLock(lockPath, { timeout: 5_000 })

    controller.abort(new Error('gave up'))
    await expect(abandoned).rejects.toThrow('gave up')

    held.release()
    const lock = await successor
    expect(lock.path).toBe(lockPath)
    lock.release()
  })
})

describe('withFileLock()', () => {
  test('runs the critical section under the lock and releases after it', async () => {
    const result = await withFileLock(lockPath, async () => {
      expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
      return 'done'
    })

    expect(result).toBe('done')
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  test('releases the lock when the critical section throws, and rethrows', async () => {
    const failure = new Error('boom')

    await expect(withFileLock(lockPath, () => Promise.reject(failure))).rejects.toBe(failure)
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  // The whole point of the package: a contended lock must never fall through to the section.
  test('does NOT run the critical section when acquisition times out', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const fn = vi.fn(() => Promise.resolve('ran'))

    await expect(
      withFileLock(lockPath, fn, { timeout: 100, staleTimeout: 60_000 }),
    ).rejects.toBeInstanceOf(TimeoutInterruption)

    expect(fn).not.toHaveBeenCalled()
  })

  test('serializes concurrent callers in this process without interleaving', async () => {
    const events: Array<string> = []
    const section = (id: string) =>
      withFileLock(lockPath, async () => {
        events.push(`enter ${id}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        events.push(`exit ${id}`)
      })

    await Promise.all([section('a'), section('b'), section('c')])

    expect(events).toEqual(['enter a', 'exit a', 'enter b', 'exit b', 'enter c', 'exit c'])
  })

  test('the timeout bounds acquisition only, never the critical section', async () => {
    const result = await withFileLock(
      lockPath,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return 'finished'
      },
      { timeout: 20 },
    )

    expect(result).toBe('finished')
  })
})
