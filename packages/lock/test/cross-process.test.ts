import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'

const run = promisify(execFile)

const CHILD = fileURLToPath(new URL('./fixtures/lock-child.ts', import.meta.url))
const CHILDREN = 6

let dir: string
let lockPath: string
let witnessPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-xp-'))
  lockPath = join(dir, 'store.lock')
  witnessPath = join(dir, 'witness.log')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('concurrent processes never hold the lock at the same time', async () => {
  await Promise.all(
    Array.from({ length: CHILDREN }, (_unused, index) =>
      run(
        process.execPath,
        [
          '--import',
          'tsx',
          CHILD,
          lockPath,
          witnessPath,
          `child-${index}`,
          // Varied hold times, so a broken lock interleaves visibly rather than by luck.
          String(20 + index * 15),
        ],
        // Comfortably above real runtime (~350ms of hold time plus node/tsx startup) but
        // well under the child's own 15s lock timeout, so a genuine deadlock kills the
        // child and rejects here instead of hanging until vitest's timeout abandons the
        // still-running processes.
        { timeout: 8_000 },
      ),
    ),
  )

  const lines = readFileSync(witnessPath, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(CHILDREN * 2)

  // Every `enter` is immediately followed by its OWN `exit`. Any interleaving means two
  // processes were inside the critical section at once — the bug this package exists to stop.
  for (let index = 0; index < lines.length; index += 2) {
    const [enterWord, enterID] = lines[index].split(' ')
    const [exitWord, exitID] = lines[index + 1].split(' ')
    expect(enterWord).toBe('enter')
    expect(exitWord).toBe('exit')
    expect(exitID).toBe(enterID)
  }

  // Every child got its turn.
  const ids = new Set(lines.map((line) => line.split(' ')[1]))
  expect(ids.size).toBe(CHILDREN)

  // The last holder released: no lockfile is left behind.
  expect(() => readFileSync(lockPath, 'utf8')).toThrow()
}, 20_000)
