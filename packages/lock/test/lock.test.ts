import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { TimeoutInterruption } from '@sozai/async'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { claimLockFile, readLockEntry } from '../src/file.js'
import { TimeoutInterruption as LockTimeoutInterruption } from '../src/index.js'
import { acquireFileLock, withFileLock } from '../src/lock.js'
import { getBootAt, getUptimeAt, type LockRecord } from '../src/record.js'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-'))
  lockPath = join(dir, 'store.lock')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A holder this process cannot probe: same host, but a boot that is not ours. Same-host holders
 * are aged monotonically, so the record's uptime has to carry the same age as its `startedAt`.
 */
function unprovableHolder(startedAt: number): LockRecord {
  const age = Date.now() - startedAt
  return {
    pid: 999_999,
    hostname: hostname(),
    bootAt: getBootAt() - 10 * 60 * 60 * 1000,
    startedAt,
    uptimeAt: Math.max(0, getUptimeAt() - age),
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
      bootAt: getBootAt(),
      startedAt: Date.now(),
      uptimeAt: getUptimeAt(),
    })

    const lock = await acquireFileLock(lockPath, { timeout: 1_000 })
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
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
