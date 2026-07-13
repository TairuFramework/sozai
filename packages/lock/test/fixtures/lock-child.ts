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
  { timeout: 30_000 },
)
