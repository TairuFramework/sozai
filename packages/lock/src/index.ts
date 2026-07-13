/**
 * Cross-process file mutex for Node.js.
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

export type { LockEntry } from './file.js'
export type { FileLock, FileLockOptions } from './lock.js'
export { acquireFileLock, withFileLock } from './lock.js'
export type { LockRecord } from './record.js'
