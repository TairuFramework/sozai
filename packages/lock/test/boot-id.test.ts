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

    expect(readBootID()).toBe('9a1c4b2e-0c3d-4f5a-8b6c-7d8e9f0a1b2c')
    expect(readFileSpy).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8')
    expect(execFileSpy).not.toHaveBeenCalled()
  })

  test('darwin: the kernel boot session UUID, trimmed', async () => {
    const { readBootID } = await loadRecord({
      platform: 'darwin',
      execFileSync: () => 'B7A91B99-73E1-43BF-BEDC-38BCEADBB0D0\n',
    })

    expect(readBootID()).toBe('B7A91B99-73E1-43BF-BEDC-38BCEADBB0D0')
    expect(execFileSpy).toHaveBeenCalledWith(
      '/usr/sbin/sysctl',
      ['-n', 'kern.bootsessionuuid'],
      expect.anything(),
    )
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  // A lock claim must NEVER fail because the boot ID could not be read: a null one only costs the
  // fallback comparison in `checkLiveness`, while a throw here would fail the claim outright.
  test('a read failure is null, never a throw', async () => {
    const linux = await loadRecord({
      platform: 'linux',
      readFileSync: () => {
        const err: NodeJS.ErrnoException = new Error('no such file')
        err.code = 'ENOENT'
        throw err
      },
    })
    expect(linux.readBootID()).toBeNull()

    const darwin = await loadRecord({
      platform: 'darwin',
      execFileSync: () => {
        throw new Error('sysctl: unknown oid')
      },
    })
    expect(darwin.readBootID()).toBeNull()
  })

  test('an empty or blank source is null, not an empty string', async () => {
    const linux = await loadRecord({ platform: 'linux', readFileSync: () => '  \n' })
    expect(linux.readBootID()).toBeNull()

    const darwin = await loadRecord({ platform: 'darwin', execFileSync: () => '' })
    expect(darwin.readBootID()).toBeNull()
  })

  test('an unsupported platform is null, and neither source is touched', async () => {
    const { readBootID } = await loadRecord({ platform: 'win32' })

    expect(readBootID()).toBeNull()
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

  // Null is a VALUE, not a miss: an unsupported platform must not re-run the failing read on every
  // liveness check (a `sysctl` spawn per stale-vs-alive decision, in the hot acquisition loop).
  test('caches a null boot ID too, rather than retrying the read', async () => {
    const { getBootID } = await loadRecord({
      platform: 'linux',
      readFileSync: () => {
        throw new Error('boom')
      },
    })

    expect(getBootID()).toBeNull()
    expect(getBootID()).toBeNull()
    expect(readFileSpy).toHaveBeenCalledTimes(1)
  })
})
