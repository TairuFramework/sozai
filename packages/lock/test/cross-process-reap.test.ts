import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { readLockEntry } from '../src/file.js'
import { acquireFileLock } from '../src/lock.js'

const run = promisify(execFile)

const FOREVER_CHILD = fileURLToPath(new URL('./fixtures/lock-child-forever.ts', import.meta.url))
const EXIT_CHILD = fileURLToPath(new URL('./fixtures/lock-child-exit.ts', import.meta.url))

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-reap-'))
  lockPath = join(dir, 'store.lock')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Every other stale-reap test in test/lock.test.ts runs in-process against a FABRICATED record
// with `process.kill` MOCKED. None of them proves that a genuinely SIGKILLed holder's lockfile is
// reaped by a genuinely separate process — which is the package's primary recovery path. This
// test spawns a real child, waits for its real claim to land on disk, kills it for real, and
// asserts the parent recovers promptly — well inside `staleTimeout`, so the recovery can only be
// explained by the dead-pid probe (`checkLiveness` returning `'dead'`), never by the TTL expiring.
test("a genuinely SIGKILLed holder's lockfile is reaped promptly by the real pid probe, not the TTL", async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', FOREVER_CHILD, lockPath], {
    stdio: 'ignore',
    // Backstop only, in case an assertion below throws before the explicit kill: bounds a leak
    // well under vitest's own timeout for this test.
    timeout: 8_000,
    killSignal: 'SIGKILL',
  })

  try {
    // Wait until the lockfile carries the CHILD's own pid, not just any lockfile.
    await vi.waitFor(
      () => {
        const entry = readLockEntry(lockPath)
        if (entry.record?.pid !== child.pid) {
          throw new Error('lockfile not yet claimed by the child')
        }
      },
      { timeout: 5_000, interval: 20 },
    )

    child.kill('SIGKILL')
    // Wait for the OS to actually reap the child, so the probe below observes a truly dead pid
    // rather than racing a not-yet-collected process table entry.
    await once(child, 'exit')

    const start = Date.now()
    // staleTimeout is set far above anything the assertion below tolerates: passing can only be
    // explained by the pid probe, never by the wall-clock TTL expiring.
    const lock = await acquireFileLock(lockPath, { timeout: 5_000, staleTimeout: 60_000 })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(3_000)
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    lock.release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
}, 20_000)

// The exit hook (`src/lock.ts`, `process.on('exit')`) has no other coverage: nothing currently
// proves it actually removes a still-held lockfile. Note what this does NOT test: a
// default-handled SIGINT/SIGTERM terminates Node without emitting `'exit'`, so the hook does not
// run for those — only `process.exit()` and a natural event-loop drain.
test('a child that exits via process.exit(0) without releasing has its lockfile cleaned by the exit hook', async () => {
  await run(process.execPath, ['--import', 'tsx', EXIT_CHILD, lockPath], { timeout: 8_000 })

  expect(() => readFileSync(lockPath, 'utf8')).toThrow()
}, 20_000)
