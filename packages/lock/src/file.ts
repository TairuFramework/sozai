import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { type LockRecord, parseLockRecord } from './record.js'

/** A record and the inode and mtime it was read from — captured together, from one descriptor. */
export type LockEntry = {
  record: LockRecord | null
  inode: number | null
  mtimeMs: number | null
}

export type ClaimResult = { inode: number } | { conflict: LockEntry }

/** Old enough that no claim can still be mid-flight. */
const TEMP_RECORD_MAX_AGE_MS = 10_000

/**
 * Read the record, its inode, and its mtime through a SINGLE open descriptor so the
 * three cannot straddle a replacement of the file — the inode is what a later reap
 * depends on still matching.
 *
 * ENOENT alone is an absent lock. Every other I/O error is thrown: collapsing them would
 * make a misconfigured path look like contention and back the loop off until it times
 * out instead of surfacing the real error.
 */
export function readLockEntry(lockPath: string): LockEntry {
  let fd: number
  try {
    fd = openSync(lockPath, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { record: null, inode: null, mtimeMs: null }
    }
    throw err
  }
  try {
    const stats = fstatSync(fd)
    return {
      record: parseLockRecord(readFileSync(fd, 'utf8')),
      inode: stats.ino,
      mtimeMs: stats.mtimeMs,
    }
  } finally {
    closeSync(fd)
  }
}

/** Write the record to a fresh sibling file, complete before it has a name a reader could look up. */
function writeTempRecord(lockPath: string, record: LockRecord): { tmpPath: string; inode: number } {
  const tmpPath = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmpPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { tmpPath, inode: statSync(tmpPath).ino }
}

/**
 * Exactly what `writeTempRecord` produces: `.<pid>.<12 hex>.tmp`. A looser match would
 * also catch the lockfile of a lock literally named `<basename>.tmp`.
 */
const TEMP_RECORD_SUFFIX = /^\.\d+\.[0-9a-f]{12}\.tmp$/

/**
 * Remove orphaned `.tmp` siblings left by a SIGKILL between write and link. Only files
 * older than `TEMP_RECORD_MAX_AGE_MS` are touched, so a concurrent claimer's fresh temp
 * file is never pulled out from under it. Best-effort throughout: tidying up must never
 * fail a claim.
 */
export function sweepTempRecords(lockPath: string): void {
  const lockName = basename(lockPath)
  const cutoff = Date.now() - TEMP_RECORD_MAX_AGE_MS
  try {
    for (const name of readdirSync(dirname(lockPath))) {
      if (!name.startsWith(lockName) || !TEMP_RECORD_SUFFIX.test(name.slice(lockName.length))) {
        continue
      }
      const tmpPath = join(dirname(lockPath), name)
      try {
        if (statSync(tmpPath).mtimeMs < cutoff) {
          rmSync(tmpPath, { force: true })
        }
      } catch {
        // Raced by another sweeper, or not ours to remove. Leave it.
      }
    }
  } catch {
    // An unreadable directory is not a reason to fail the claim we just won.
  }
}

/**
 * Take an exclusive claim on `lockPath` via `link()` — the single atomic primitive this
 * design rests on. `link` fails with EEXIST when the name is taken, like `O_EXCL`, but
 * the name it creates is already complete: the record is written to a temp file first,
 * so a racer can never read the lockfile mid-write. (Create-then-write leaves a
 * zero-byte file visible for a moment; a racer reading it there concludes "nobody home"
 * and reaps the winner's fresh lock.)
 *
 * The winner gets the inode it linked, which it must present to release the lock.
 * Losers get the conflicting entry and must unlink nothing.
 */
export function claimLockFile(lockPath: string, record: LockRecord): ClaimResult {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const { tmpPath, inode } = writeTempRecord(lockPath, record)

  try {
    linkSync(tmpPath, lockPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EEXIST: the name is taken, someone else holds the lock.
    // ENOENT: our own temp file was collected by a sweeper — only possible if this
    // process was suspended past the sweep cutoff between writing and linking it. Retryable.
    if (code !== 'EEXIST' && code !== 'ENOENT') {
      throw err
    }
    return { conflict: readLockEntry(lockPath) }
  } finally {
    // The lockfile is a second link to the same inode; ours is now redundant.
    rmSync(tmpPath, { force: true })
  }

  // We won the claim: the one moment we know the previous holder is gone and can safely
  // tidy up the temp files its crash may have orphaned.
  sweepTempRecords(lockPath)

  return { inode }
}

function inodeOf(lockPath: string): number | null {
  try {
    return statSync(lockPath).ino
  } catch {
    return null
  }
}

/**
 * Unlink the lockfile only if its inode still matches `expectedInode`. Required: an
 * unguarded unlink removes whatever now sits at the path, which — after any await — may
 * be a different holder's live lock. Read the inode with `readLockEntry` at the same
 * moment you read the record you are classifying, and present it here.
 *
 * Returns whether the file was removed. Losing this race is not an error: the winner's
 * lock is simply left alone.
 *
 * GUARDED, NOT ATOMIC: `statSync` and `rmSync` are two syscalls, and POSIX offers no
 * unlink-if-inode, so a residual window remains where two waiters reaping the same stale
 * lock in lockstep can both believe they won it. `acquireFileLock` jitters before reaping
 * so N waiters released by one stale lock do not step through that window together — a
 * probabilistic mitigation, not a proof. This is the one place this package's exclusion
 * is not absolute.
 */
export function reapLockFile(lockPath: string, expectedInode: number): boolean {
  if (inodeOf(lockPath) !== expectedInode) {
    return false
  }
  try {
    rmSync(lockPath)
    return true
  } catch {
    return false
  }
}
