import { acquireFileLock } from '../../src/index.js'

const [lockPath] = process.argv.slice(2)

await acquireFileLock(lockPath, { timeout: 15_000 })

// Held forever, on purpose: this fixture exists to be SIGKILLed while holding the lock
// (test/cross-process-reap.test.ts), never to release cleanly. A SIGKILL bypasses both the
// `release()` call and the `process.on('exit')` hook, which is exactly the case that only the
// dead-pid probe in `checkLiveness` can recover from.
//
// A bare unresolved top-level-await promise is not enough: with nothing else keeping the event
// loop alive, Node detects the dangling await and exits the process on its own, before the
// parent ever gets to kill it. An uncleared interval keeps the loop — and the lock — alive.
setInterval(() => {}, 1 << 30)
