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
 * Read the record, its inode and its mtime through a SINGLE open descriptor, so the three
 * cannot straddle a replacement of the file. Callers that reap after an await depend on that:
 * the inode is what tells them the file they classified is still the file they are about to
 * unlink. The mtime dates a record too corrupt to date itself.
 *
 * ENOENT — and ONLY ENOENT — is an absent lock, reported as the all-null entry. Every other I/O
 * error is thrown. Collapsing them all into "absent" made a misconfigured path (a directory at
 * `lockPath`, an unreadable file) look exactly like a lock held by someone else: no inode, so no
 * reap, so the acquiring loop backed off until it timed out and told the caller the lock was
 * contended. The most misleading diagnosis this package can emit; the real error is better.
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

/**
 * Write the record to a fresh sibling file. The full content exists before the file is ever
 * given a name a reader could look up, which is what makes the claim below atomic to any
 * observer.
 */
function writeTempRecord(lockPath: string, record: LockRecord): { tmpPath: string; inode: number } {
  const tmpPath = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmpPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { tmpPath, inode: statSync(tmpPath).ino }
}

/**
 * What `writeTempRecord` produces, and nothing else: `.<pid>.<12 hex>.tmp`. A looser match — any
 * sibling starting with `<basename>.` and ending in `.tmp` — also matches the LOCKFILE of a lock
 * named `<basename>.tmp`, and would unlink a live lock once it aged past the cutoff.
 */
const TEMP_RECORD_SUFFIX = /^\.\d+\.[0-9a-f]{12}\.tmp$/

/**
 * Remove orphaned `.tmp` siblings. The claim is only atomic because the content exists under a
 * throwaway name first — but a SIGKILL landing in that window leaves the throwaway behind
 * forever, and a crash-looping process quietly accumulates them. Only files old enough that no
 * live claim could still be linking one are touched, so a concurrent claimer's fresh temp file
 * is never pulled out from under it. Best-effort throughout: a claim must never fail because
 * tidying up did.
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
 * Take an exclusive claim on `lockPath` via `link()` — the single atomic primitive this design
 * rests on. `link` fails with EEXIST when the name is taken, exactly like `O_EXCL`, but the
 * name it creates is already complete: the record is written to a temp file first, so no racer
 * can ever read the lockfile mid-write. (A create-then-write claim leaves a zero-byte file
 * visible for a moment; a racer reading it there parses nothing, concludes "nobody home", and
 * reaps the winner's fresh lock — the very check-then-act this design exists to remove.)
 *
 * The winner gets the inode it linked, which is what it must present to release the lock.
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
    // ENOENT: OUR temp file is gone — only possible if this process was suspended past the sweep
    // cutoff between writing it and linking it (laptop sleep, SIGSTOP), so a sweeper collected it
    // as an orphan. Retryable, not fatal: report a conflict and let the caller claim again.
    if (code !== 'EEXIST' && code !== 'ENOENT') {
      throw err
    }
    return { conflict: readLockEntry(lockPath) }
  } finally {
    // The lockfile is a second link to the same inode; ours is now redundant.
    rmSync(tmpPath, { force: true })
  }

  // We won the claim: the one moment we know the previous holder is gone and can safely tidy up
  // the temp files its crash may have orphaned.
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
 * Unlink the lockfile only if its inode still matches `expectedInode`. Required, not optional:
 * an unguarded unlink removes whatever happens to sit at the path right now, which — after any
 * await — may be a different holder's live lock. Read the inode with `readLockEntry` at the same
 * moment you read the record you are classifying, and present it here. Releasing a lock you hold
 * is the same operation, against the inode you linked.
 *
 * Returns whether the file was removed. Losing this race is not an error: the winner's lock is
 * simply left alone.
 *
 * GUARDED, NOT ATOMIC. The guard narrows the window; it does not close it. `statSync` and
 * `rmSync` are two syscalls, and a residual window remains DURING the call:
 *
 *   1. Waiters A and B both read the entry with inode I and both classify it stale — the normal
 *      shape after a crash, where every waiter sees the same dead holder.
 *   2. B calls `inodeOf()` and sees I. It is about to unlink.
 *   3. A unlinks I first, writes its temp file, and links inode J: A now holds a LIVE lock.
 *   4. B's `rmSync(lockPath)` removes J — A's lock — and returns `true`.
 *   5. B claims the free path as inode K. A and B are both in the critical section.
 *
 * POSIX offers no unlink-if-inode, so no sequence of name operations fixes this. What narrows it
 * to near-nothing is not reaping in lockstep: `acquireFileLock` jitters before it reaps, so N
 * waiters released by one stale lock do not step through 1-5 together. That is a probabilistic
 * mitigation of a rare, crash-only path, not a proof — and it is the one place this package's
 * exclusion is not absolute.
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
