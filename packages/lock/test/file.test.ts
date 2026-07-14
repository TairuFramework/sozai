import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { claimLockFile, readLockEntry, reapLockFile, sweepTempRecords } from '../src/file.js'
import { createLockRecord, type LockRecord } from '../src/record.js'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-'))
  lockPath = join(dir, 'nested', 'store.lock')
})

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
  rmSync(dir, { recursive: true, force: true })
})

function foreignRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    pid: 999_999,
    hostname: 'other-host',
    nonce: randomBytes(8).toString('hex'),
    bootID: 'a3e1f0d2-0000-4000-8000-otherhost',
    bootAt: 1_000,
    startedAt: 2_000,
    uptimeAt: 3_000,
    ...overrides,
  }
}

describe('claimLockFile()', () => {
  test('creates the parent directory and writes a fully-formed record', () => {
    const record = createLockRecord()
    const result = claimLockFile(lockPath, record)

    const stats = statSync(lockPath)
    expect(result).toEqual({ held: { record, inode: stats.ino, mtimeMs: stats.mtimeMs } })
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

  // Only reachable when the claimer is suspended past the sweep cutoff between writing its temp
  // file and linking it (laptop sleep, SIGSTOP) — its own temp file is then swept out from under
  // it. Retryable, not fatal: the caller re-reads and claims again.
  test('reports a conflict when its temp file vanished before the link (ENOENT)', async () => {
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        default: actual,
        linkSync: () => {
          const err: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory, link')
          err.code = 'ENOENT'
          throw err
        },
      }
    })
    const { claimLockFile: claimWithVanishedTemp } = await import('../src/file.js')

    const result = claimWithVanishedTemp(lockPath, foreignRecord())

    expect(result).toEqual({ conflict: { record: null, inode: null, mtimeMs: null } })
    // And it still cleaned up after itself.
    expect(readdirSyncSafe(join(dir, 'nested')).filter((name) => name.endsWith('.tmp'))).toEqual([])
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

  // Collapsing EVERY I/O error to an all-null entry made a misconfigured path — a directory, an
  // unreadable file — indistinguishable from a held lock: no inode, so no reap, so the caller
  // waited out its whole timeout and was told "someone else holds the lock". The most misleading
  // diagnosis this package can emit. Only ENOENT means "absent".
  test('throws, rather than reporting an absent lock, when a directory sits at the path', () => {
    mkdirSync(lockPath, { recursive: true })

    expect(() => readLockEntry(lockPath)).toThrow(/EISDIR|EPERM|EACCES/)
  })
})

describe('reapLockFile()', () => {
  test('unlinks the file it was given', () => {
    claimLockFile(lockPath, foreignRecord())
    const entry = readLockEntry(lockPath)

    expect(reapLockFile(lockPath, entry)).toBe(true)
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  // An unguarded reap is an unlink of whatever sits at the path *right now*, which after any
  // await may be a different holder's live lock. This is the test that pins that down.
  test('refuses to unlink when the file has been replaced under it', () => {
    claimLockFile(lockPath, foreignRecord())
    const stale = readLockEntry(lockPath)

    rmSync(lockPath)
    const newHolder = foreignRecord({ pid: 4242 })
    claimLockFile(lockPath, newHolder)

    expect(reapLockFile(lockPath, stale)).toBe(false)
    expect(readLockEntry(lockPath).record).toEqual(newHolder)
  })

  // The test above only bites where the kernel hands the freed inode number back — which linux
  // does and APFS does not. Force the collision so the nonce is what has to catch it.
  test('refuses to unlink a replacement that inherited the reaped file’s inode', () => {
    const stale = foreignRecord()
    const newHolder = foreignRecord({ pid: 4242 })
    claimLockFile(lockPath, newHolder)
    const current = readLockEntry(lockPath)

    expect(reapLockFile(lockPath, { ...current, record: stale })).toBe(false)
    expect(readLockEntry(lockPath).record).toEqual(newHolder)
  })

  // An unparseable holder has no nonce, so its identity is the inode plus the mtime it was read
  // with. Same forced collision, and the mtime is what has to catch it.
  test('refuses to unlink an unparseable file that is not the one it read', () => {
    claimLockFile(lockPath, foreignRecord())
    writeFileSync(lockPath, 'garbage')
    utimesSync(lockPath, new Date(1_000), new Date(1_000))
    const corrupt = readLockEntry(lockPath)

    rmSync(lockPath)
    writeFileSync(lockPath, 'different garbage')
    const current = readLockEntry(lockPath)

    expect(reapLockFile(lockPath, { ...corrupt, inode: current.inode })).toBe(false)
    expect(readFileSync(lockPath, 'utf8')).toBe('different garbage')
  })

  test('returns false for a missing file', () => {
    expect(reapLockFile(lockPath, { record: null, inode: 12_345, mtimeMs: 1 })).toBe(false)
  })
})

describe('sweepTempRecords()', () => {
  test('removes orphaned temp siblings older than the cutoff, and only those', () => {
    claimLockFile(lockPath, createLockRecord())
    const old = `${lockPath}.111.aaaaaabbbbbb.tmp`
    const fresh = `${lockPath}.222.bbbbbbcccccc.tmp`
    const unrelated = join(dir, 'nested', 'other.lock.333.ccccccdddddd.tmp')
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

  // `startsWith(basename + '.') && endsWith('.tmp')` also matched the LOCKFILE of a lock named
  // `<basename>.tmp` — an unlink of a live lock. The sweep matches only the shape the writer
  // produces: `<basename>.<pid>.<12 hex>.tmp`.
  test('never removes a neighbouring lockfile that merely looks like a temp file', () => {
    const neighbour = `${lockPath}.tmp`
    claimLockFile(neighbour, createLockRecord())
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(neighbour, longAgo, longAgo)
    // As is the temp file of THAT lock, which is not ours to sweep either.
    const neighbourTemp = `${neighbour}.444.ddddddeeeeee.tmp`
    writeFileSync(neighbourTemp, '{}')
    utimesSync(neighbourTemp, longAgo, longAgo)

    sweepTempRecords(lockPath)

    expect(existsSyncSafe(neighbour)).toBe(true)
    expect(existsSyncSafe(neighbourTemp)).toBe(true)
  })

  test('ignores names that do not carry a pid and a hex suffix', () => {
    claimLockFile(lockPath, createLockRecord())
    const longAgo = new Date(Date.now() - 60_000)
    const strays = [
      `${lockPath}.tmp.tmp`,
      `${lockPath}.notapid.aaaaaabbbbbb.tmp`,
      `${lockPath}.111.nothex123456.tmp`,
      `${lockPath}.111.aaaaaa.tmp`,
    ]
    for (const path of strays) {
      writeFileSync(path, '{}')
      utimesSync(path, longAgo, longAgo)
    }

    sweepTempRecords(lockPath)

    for (const path of strays) {
      expect(existsSyncSafe(path)).toBe(true)
    }
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
