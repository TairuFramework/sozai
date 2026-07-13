import { acquireFileLock } from '../../src/index.js'

const [lockPath] = process.argv.slice(2)

await acquireFileLock(lockPath, { timeout: 15_000 })

// Exit WITHOUT releasing: this fixture exists to pin the `process.on('exit')` hook in
// src/lock.ts, the only thing that can clean up after a process that quits without calling
// `release()`.
process.exit(0)
