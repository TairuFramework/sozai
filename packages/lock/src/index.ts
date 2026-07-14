/**
 * Filesystem-based cross-process mutex.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/lock
 * ```
 *
 * @module lock
 */

export { TimeoutInterruption } from '@sozai/async'

export type { FileLock, FileLockOptions } from './lock.js'
export { acquireFileLock, withFileLock } from './lock.js'
export type { LockRecord } from './record.js'
