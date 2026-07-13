import { appendFileSync } from 'node:fs'

import { withFileLock } from '../../src/index.js'

const [lockPath, witnessPath, id, holdMs] = process.argv.slice(2)

await withFileLock(
  lockPath,
  async () => {
    appendFileSync(witnessPath, `enter ${id}\n`)
    await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
    appendFileSync(witnessPath, `exit ${id}\n`)
  },
  // Above execFile's 8s kill in cross-process.test.ts (so a genuine deadlock is caught
  // there first, killing this process) and below vitest's 20s test timeout (so the
  // Promise.all is never abandoned while children are still alive).
  { timeout: 15_000 },
)
