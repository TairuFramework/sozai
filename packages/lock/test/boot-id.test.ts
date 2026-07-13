import { afterEach, describe, expect, test, vi } from 'vitest'

/**
 * The boot ID is read from the OS once per process and cached in a module-level slot, so every
 * test here loads a FRESH copy of `src/record.js` (`vi.resetModules()` + a dynamic import) with the
 * platform and the two possible sources mocked underneath it. Mocking the source rather than
 * depending on the host's real one is the whole point: these assertions must hold on a linux CI
 * runner, on a darwin laptop, and on a platform that publishes no boot ID at all.
 */
type RecordModule = typeof import('../src/record.js')

type Sources = {
  platform: NodeJS.Platform
  readFileSync?: (path: string, encoding: string) => string
  execFileSync?: (file: string, args: Array<string>) => string
}

const readFileSpy = vi.fn()
const execFileSpy = vi.fn()

async function loadRecord(sources: Sources): Promise<RecordModule> {
  vi.resetModules()
  readFileSpy.mockReset()
  execFileSpy.mockReset()

  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os')
    return { ...actual, platform: () => sources.platform }
  })
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    readFileSpy.mockImplementation((path: string, encoding: string) => {
      if (sources.readFileSync == null) {
        throw new Error(`unexpected readFileSync(${path})`)
      }
      return sources.readFileSync(path, encoding)
    })
    return { ...actual, readFileSync: readFileSpy }
  })
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    execFileSpy.mockImplementation((file: string, args: Array<string>) => {
      if (sources.execFileSync == null) {
        throw new Error(`unexpected execFileSync(${file})`)
      }
      return sources.execFileSync(file, args)
    })
    return { ...actual, execFileSync: execFileSpy }
  })

  return await import('../src/record.js')
}

afterEach(() => {
  vi.doUnmock('node:os')
  vi.doUnmock('node:fs')
  vi.doUnmock('node:child_process')
  vi.resetModules()
})

describe('readBootID()', () => {
  test('linux: the kernel boot_id, trimmed', async () => {
    const { readBootID } = await loadRecord({
      platform: 'linux',
      readFileSync: () => '9a1c4b2e-0c3d-4f5a-8b6c-7d8e9f0a1b2c\n',
    })

    expect(readBootID()).toEqual({ status: 'ok', bootID: '9a1c4b2e-0c3d-4f5a-8b6c-7d8e9f0a1b2c' })
    expect(readFileSpy).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8')
    expect(execFileSpy).not.toHaveBeenCalled()
  })

  // The exec options are part of the hardening, not incidental: an absolute path (no `PATH` this
  // process does not control), a bounded `timeout` (a wedged `sysctl` must not wedge a lock claim),
  // and `stdio` that never inherits — pinned exactly, because `expect.anything()` would let any of
  // them be dropped in a refactor without a test noticing.
  test('darwin: the kernel boot session UUID, trimmed, from a hardened exec', async () => {
    const { readBootID } = await loadRecord({
      platform: 'darwin',
      execFileSync: () => 'B7A91B99-73E1-43BF-BEDC-38BCEADBB0D0\n',
    })

    expect(readBootID()).toEqual({ status: 'ok', bootID: 'B7A91B99-73E1-43BF-BEDC-38BCEADBB0D0' })
    expect(execFileSpy).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    })
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  // A lock claim must NEVER fail because the boot ID could not be read: a failed read only costs
  // the fallback comparison in `checkLiveness`, while a throw here would fail the claim outright.
  // And it is reported as FAILED, not as "this platform has none" — the difference is what lets
  // `getBootID` retry an EMFILE or a denied exec instead of downgrading the process for its life.
  test('a read failure is a failed read, never a throw', async () => {
    const linux = await loadRecord({
      platform: 'linux',
      readFileSync: () => {
        const err: NodeJS.ErrnoException = new Error('no such file')
        err.code = 'ENOENT'
        throw err
      },
    })
    expect(linux.readBootID()).toEqual({ status: 'failed' })

    const darwin = await loadRecord({
      platform: 'darwin',
      execFileSync: () => {
        throw new Error('sysctl: unknown oid')
      },
    })
    expect(darwin.readBootID()).toEqual({ status: 'failed' })
  })

  // Never an empty string: an empty ID would compare EQUAL to another empty one and manufacture a
  // "same boot" proof out of two failed reads. A supported platform that answers with nothing has
  // FAILED, so it is retried rather than cached.
  test('an empty or blank source is a failed read, not an empty boot ID', async () => {
    const linux = await loadRecord({ platform: 'linux', readFileSync: () => '  \n' })
    expect(linux.readBootID()).toEqual({ status: 'failed' })

    const darwin = await loadRecord({ platform: 'darwin', execFileSync: () => '' })
    expect(darwin.readBootID()).toEqual({ status: 'failed' })
  })

  test('an unsupported platform is unsupported, and neither source is touched', async () => {
    const { readBootID } = await loadRecord({ platform: 'win32' })

    expect(readBootID()).toEqual({ status: 'unsupported' })
    expect(readFileSpy).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
  })
})

describe('getBootID()', () => {
  test('reads the source at most once per process', async () => {
    const { getBootID } = await loadRecord({
      platform: 'linux',
      readFileSync: () => 'cached-boot-id\n',
    })

    expect(getBootID()).toBe('cached-boot-id')
    expect(getBootID()).toBe('cached-boot-id')
    expect(getBootID()).toBe('cached-boot-id')
    expect(readFileSpy).toHaveBeenCalledTimes(1)
  })

  // "This platform publishes none" is a VALUE, and no retry can change it: re-running the check on
  // every liveness decision would put a failing read (a `sysctl` spawn, on darwin) in the hot
  // acquisition loop, for an answer that is already known.
  test('an unsupported platform is null forever, and never touches a source', async () => {
    const { getBootID } = await loadRecord({ platform: 'win32' })

    expect(getBootID()).toBeNull()
    expect(getBootID()).toBeNull()
    expect(getBootID()).toBeNull()
    expect(readFileSpy).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
  })

  /**
   * A FAILED read is not a value, and caching it as one is a silent downgrade. One EMFILE at the
   * first claim, or a sandbox that denies the exec once, would otherwise put this process on the
   * clock-step-vulnerable `bootAt` fallback for its whole life — on a platform whose docs promise
   * it will not be. So a failure is retried; a success is then cached like any other.
   *
   * THE RETRY IS SPENT BEFORE THE FIRST CALLER IS ANSWERED, and that is the whole point of it: a
   * `null` handed to a caller is not a private disappointment, it is what the caller then WRITES
   * into a lock record (frozen there for the life of the hold) and what it decides a live holder's
   * fate from. A retry that only pays off on the NEXT call pays off after the damage.
   */
  test('a failed read is retried before anybody is answered, and the boot ID is cached', async () => {
    let attempt = 0
    const { getBootID } = await loadRecord({
      platform: 'linux',
      readFileSync: () => {
        attempt += 1
        if (attempt === 1) {
          const err: NodeJS.ErrnoException = new Error('too many open files')
          err.code = 'EMFILE'
          throw err
        }
        return 'late-boot-id\n'
      },
    })

    // The FIRST call, not the second: nobody ever sees the `null` the source has already recanted.
    expect(getBootID()).toBe('late-boot-id')
    expect(readFileSpy).toHaveBeenCalledTimes(2)
    expect(getBootID()).toBe('late-boot-id')
    expect(readFileSpy).toHaveBeenCalledTimes(2)
  })

  // ...and the retry is bounded, so a permanently-failing source can never become a per-turn read
  // (or a per-turn `sysctl` spawn) in the acquisition loop. At most two reads per acquisition.
  test('a persistently failing read is retried once, then cached as null', async () => {
    const { getBootID } = await loadRecord({
      platform: 'linux',
      readFileSync: () => {
        throw new Error('boom')
      },
    })

    for (let call = 0; call < 5; call += 1) {
      expect(getBootID()).toBeNull()
    }
    expect(readFileSpy).toHaveBeenCalledTimes(2)
  })
})

/**
 * The budget is per ACQUISITION, not per process — `acquireFileLock` calls this before it builds a
 * record. Both reads of one acquisition land inside a single tick, so what they survive on their
 * own is a source that fails NON-DETERMINISTICALLY; an EMFILE storm or a sandbox denial that
 * outlasts a tick fails both. Without a reset that would downgrade the process to the
 * clock-step-vulnerable fallback FOR ITS WHOLE LIFE on the first unlucky claim. With one, it
 * downgrades a single acquisition, and the next one — separated from it by however long the caller
 * took, which is the only real time this synchronous path has — reads the source again.
 */
describe('retryBootIDRead()', () => {
  test('a source that failed for a whole acquisition is read again on the next one', async () => {
    let failing = true
    const { getBootID, retryBootIDRead } = await loadRecord({
      platform: 'linux',
      readFileSync: () => {
        if (failing) {
          const err: NodeJS.ErrnoException = new Error('too many open files')
          err.code = 'EMFILE'
          throw err
        }
        return 'recovered-boot-id\n'
      },
    })

    expect(getBootID()).toBeNull()
    expect(readFileSpy).toHaveBeenCalledTimes(2)

    // The storm clears — but nothing re-reads the source WITHIN this acquisition: a settled null is
    // settled, or the reads would be back in the hot loop.
    failing = false
    expect(getBootID()).toBeNull()
    expect(readFileSpy).toHaveBeenCalledTimes(2)

    // ...and the next acquisition picks the boot ID up.
    retryBootIDRead()
    expect(getBootID()).toBe('recovered-boot-id')
  })

  // The reset is for FAILURES only. "This platform publishes no boot ID" is settled forever, and no
  // acquisition can change it: re-reading would put a pointless `sysctl` spawn in front of a lock.
  test('an unsupported platform is never read again, however many acquisitions there are', async () => {
    const { getBootID, retryBootIDRead } = await loadRecord({ platform: 'win32' })

    expect(getBootID()).toBeNull()
    retryBootIDRead()
    expect(getBootID()).toBeNull()
    expect(readFileSpy).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
  })

  test('a boot ID that has been read is not read again', async () => {
    const { getBootID, retryBootIDRead } = await loadRecord({
      platform: 'linux',
      readFileSync: () => 'cached-boot-id\n',
    })

    expect(getBootID()).toBe('cached-boot-id')
    retryBootIDRead()
    expect(getBootID()).toBe('cached-boot-id')
    expect(readFileSpy).toHaveBeenCalledTimes(1)
  })
})

/**
 * The record's `bootID` is FROZEN for the life of the hold: every waiter that evaluates this holder
 * — for as long as it holds — decides from what was written here. A record written during a failing
 * window with `bootID: null` therefore puts that hold, and every waiter of it, on the unsafe
 * `bootAt` fallback for the lock's entire life, long after the process itself has recovered a real
 * boot ID. So the retry is spent HERE, where it is worth something.
 */
describe('createLockRecord()', () => {
  test('never writes a null boot ID the source would have answered on a retry', async () => {
    let attempt = 0
    const { createLockRecord } = await loadRecord({
      platform: 'linux',
      readFileSync: () => {
        attempt += 1
        if (attempt === 1) {
          const err: NodeJS.ErrnoException = new Error('too many open files')
          err.code = 'EMFILE'
          throw err
        }
        return 'late-boot-id\n'
      },
    })

    expect(createLockRecord().bootID).toBe('late-boot-id')
    expect(readFileSpy).toHaveBeenCalledTimes(2)
  })

  // A source that is not merely flaking is a `null` on the record — the fallback, honestly declared,
  // rather than a lock claim that fails or an empty string that fabricates a "same boot" proof.
  test('writes a null boot ID when the source will not answer at all', async () => {
    const { createLockRecord } = await loadRecord({
      platform: 'darwin',
      execFileSync: () => {
        throw new Error('sandbox denied the exec')
      },
    })

    expect(createLockRecord().bootID).toBeNull()
    expect(execFileSpy).toHaveBeenCalledTimes(2)
  })
})
