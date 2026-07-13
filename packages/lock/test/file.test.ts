import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { claimLockFile, readLockEntry, reapLockFile, sweepTempRecords } from '../src/file.js'
import { createLockRecord, type LockRecord } from '../src/record.js'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-'))
  lockPath = join(dir, 'nested', 'store.lock')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function foreignRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return { pid: 999_999, hostname: 'other-host', bootAt: 1_000, startedAt: 2_000, ...overrides }
}

describe('claimLockFile()', () => {
  test('creates the parent directory and writes a fully-formed record', () => {
    const record = createLockRecord()
    const result = claimLockFile(lockPath, record)

    expect(result).toEqual({ inode: statSync(lockPath).ino })
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(record)
  })

  test('reports a conflict with the holder record and inode when the path is taken', () => {
    const holder = foreignRecord()
    claimLockFile(lockPath, holder)
    const inode = statSync(lockPath).ino

    const result = claimLockFile(lockPath, createLockRecord())

    expect(result).toEqual({ conflict: { record: holder, inode, mtimeMs: expect.any(Number) } })
    // The loser must not have touched the winner's file.
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(holder)
  })

  test('leaves no temp file behind on a win or on a conflict', () => {
    claimLockFile(lockPath, foreignRecord())
    claimLockFile(lockPath, createLockRecord())

    const leftovers = readdirSyncSafe(join(dir, 'nested')).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('reports a conflict, not a crash, when the holder record is corrupt', () => {
    claimLockFile(lockPath, foreignRecord())
    writeFileSync(lockPath, '{ not json')

    const result = claimLockFile(lockPath, createLockRecord())

    expect(result).toEqual({
      conflict: { record: null, inode: expect.any(Number), mtimeMs: expect.any(Number) },
    })
  })
})

describe('readLockEntry()', () => {
  test('returns all-null for a missing file', () => {
    expect(readLockEntry(lockPath)).toEqual({ record: null, inode: null, mtimeMs: null })
  })

  test('returns the record with the inode and mtime it was read from', () => {
    const holder = foreignRecord()
    claimLockFile(lockPath, holder)
    const stats = statSync(lockPath)

    expect(readLockEntry(lockPath)).toEqual({
      record: holder,
      inode: stats.ino,
      mtimeMs: stats.mtimeMs,
    })
  })

  test('returns a null record but a real inode for an unparseable file', () => {
    claimLockFile(lockPath, foreignRecord())
    writeFileSync(lockPath, 'garbage')

    const entry = readLockEntry(lockPath)
    expect(entry.record).toBeNull()
    expect(entry.inode).toBe(statSync(lockPath).ino)
  })
})

describe('reapLockFile()', () => {
  test('unlinks the file when the inode still matches', () => {
    claimLockFile(lockPath, foreignRecord())
    const { inode } = readLockEntry(lockPath)

    expect(reapLockFile(lockPath, inode as number)).toBe(true)
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  // An unguarded reap is an unlink of whatever sits at the path *right now*, which after any
  // await may be a different holder's live lock. This is the test that pins that down.
  test('refuses to unlink when the file has been replaced under it', () => {
    claimLockFile(lockPath, foreignRecord())
    const staleInode = readLockEntry(lockPath).inode as number

    rmSync(lockPath)
    const newHolder = foreignRecord({ pid: 4242 })
    claimLockFile(lockPath, newHolder)

    expect(reapLockFile(lockPath, staleInode)).toBe(false)
    expect(readLockEntry(lockPath).record).toEqual(newHolder)
  })

  test('returns false for a missing file', () => {
    expect(reapLockFile(lockPath, 12_345)).toBe(false)
  })
})

describe('sweepTempRecords()', () => {
  test('removes orphaned temp siblings older than the cutoff, and only those', () => {
    claimLockFile(lockPath, createLockRecord())
    const old = `${lockPath}.111.aaaaaa.tmp`
    const fresh = `${lockPath}.222.bbbbbb.tmp`
    const unrelated = join(dir, 'nested', 'other.lock.333.cccccc.tmp')
    for (const path of [old, fresh, unrelated]) {
      writeFileSync(path, '{}')
    }
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(old, longAgo, longAgo)
    utimesSync(unrelated, longAgo, longAgo)

    sweepTempRecords(lockPath)

    expect(existsSyncSafe(old)).toBe(false)
    // A concurrent claimer's fresh temp file must never be pulled out from under it.
    expect(existsSyncSafe(fresh)).toBe(true)
    // Not ours to remove: a different lock path in the same directory.
    expect(existsSyncSafe(unrelated)).toBe(true)
  })
})

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function readdirSyncSafe(path: string): Array<string> {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}
