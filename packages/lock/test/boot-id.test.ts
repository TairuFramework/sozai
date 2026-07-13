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
   */
  test('a failed read is retried, and a boot ID that becomes readable is picked up and cached', async () => {
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

    expect(getBootID()).toBeNull()
    expect(getBootID()).toBe('late-boot-id')
    expect(getBootID()).toBe('late-boot-id')
    expect(readFileSpy).toHaveBeenCalledTimes(2)
  })

  // ...and the retry is bounded, so a permanently-failing source can never become a per-turn read
  // (or a per-turn `sysctl` spawn) in the acquisition loop. At most two reads per process, ever.
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
