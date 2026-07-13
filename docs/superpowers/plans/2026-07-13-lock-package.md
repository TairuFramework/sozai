# @sozai/lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@sozai/lock`, a Node-only blocking cross-process file mutex, so `@kokuin/node` and `@kokuin/electron` can stop losing keys to concurrent `provideAsync` races.

**Architecture:** The lock is a file, claimed atomically with `linkSync()` from a pre-written temp file so the name never exists half-written. The record on disk (`pid`, `hostname`, `bootAt`, `startedAt`) lets a waiter *prove* the holder is alive (`process.kill(pid, 0)` on the same host and the same boot) and never reap it while it is; a TTL applies only where liveness is unprovable (foreign host, boot mismatch, corrupt record). Reap and release are inode-guarded so no process can ever unlink a lock that is not the one it classified. Same-process callers are chained FIFO in memory before any filesystem work.

**Tech Stack:** TypeScript (ESM), `node:fs` / `node:os` / `node:crypto`, `@sozai/async` (`defer`, `sleep`, `raceSignal`, `onAbort`, `ScheduledTimeout`), vitest, SWC, Biome, changesets.

**Spec:** `docs/agents/plans/next/lock-package.md` — read it before Task 1. This plan implements it; where they disagree, the spec wins.

## Global Constraints

- **Node-only package.** `node:` builtins are allowed here and nowhere else in the repo. No browser/Expo build.
- **Conventions** (`kigu:conventions`, non-negotiable): `type` never `interface`; `Array<T>` never `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`; ES `#fields`, never `private`/`readonly`. Do not edit generated `lib/`.
- **One dependency:** `"@sozai/async": "workspace:^"`. Nothing else, dev or runtime.
- **Package version starts at `0.1.0`**, `"license": "MIT"`, `"access": "public"`, mirroring `packages/log/package.json` exactly.
- **`fn` never runs unlocked.** Every failure path — timeout, abort, fs error — throws instead of running the critical section.
- **A provably-live holder is never reaped**, no matter how long it has held the lock.
- **`process.kill` is never called with a pid ≤ 0.** Record validation rejects it before any caller can reach the probe.
- **Defaults:** `timeout: 10_000`, `staleTimeout: 60_000`, `retryDelay: 10`, `maxRetryDelay: 250`, boot tolerance `30_000`, temp-file sweep age `10_000`.
- **Commands:** run tools directly (`pnpm exec vitest ...`), not via `pnpm run` — an `rtk` shim on this machine intercepts `pnpm run` and redirects it to the wrong tool.

---

## File Structure

**Created** (all under `packages/lock/`):

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.test.json`, `LICENSE`, `README.md` | Package scaffolding, copied from `packages/log` |
| `src/record.ts` | The `LockRecord` type, its construction, its validation, its parsing. Knows nothing about files. |
| `src/file.ts` | Filesystem primitives: read entry (record + inode + mtime through one descriptor), atomic claim via `link()`, inode-guarded reap, temp-file sweep. Knows nothing about waiting. |
| `src/liveness.ts` | Is the holder alive (`alive` / `dead` / `unknown`), and is the entry stale. Pure classification. |
| `src/queue.ts` | In-process FIFO chain per resolved path. Knows nothing about locks. |
| `src/lock.ts` | The public `acquireFileLock` / `withFileLock`: queue → claim → classify → backoff → deadline, plus release and the process-exit sweep. |
| `src/index.ts` | Public exports. |
| `test/record.test.ts`, `test/file.test.ts`, `test/liveness.test.ts`, `test/queue.test.ts`, `test/lock.test.ts`, `test/cross-process.test.ts`, `test/fixtures/lock-child.ts` | One test file per source module, plus the forked-children proof. |

**Modified:** `.changeset/lock-package.md` (new), `docs/reference/runtime.md`, `docs/skills/runtime.skill.md`, `docs/skills/discover.skill.md`, `docs/agents/architecture.md`.

**Dependency direction:** `record.ts` ← `file.ts`, `liveness.ts` ← `lock.ts` → `queue.ts`. No cycles; `queue.ts` and `record.ts` are leaves.

---

## Task 1: Package scaffolding + the lock record

**Files:**
- Create: `packages/lock/package.json`, `packages/lock/tsconfig.json`, `packages/lock/tsconfig.test.json`, `packages/lock/LICENSE`, `packages/lock/src/record.ts`, `packages/lock/src/index.ts`
- Test: `packages/lock/test/record.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type LockRecord = { pid: number; hostname: string; bootAt: number; startedAt: number }`, `getBootAt(): number`, `createLockRecord(): LockRecord`, `isLockRecord(value: unknown): value is LockRecord`, `parseLockRecord(raw: string): LockRecord | null`.

- [ ] **Step 1: Create the package scaffolding**

`packages/lock/package.json` (identical in shape to `packages/log/package.json`; only `name`, `version`, `description`, `directory`, `dependencies` differ):

```json
{
  "name": "@sozai/lock",
  "version": "0.1.0",
  "license": "MIT",
  "description": "Cross-process file mutex (Node.js only)",
  "keywords": [],
  "repository": {
    "type": "git",
    "url": "https://github.com/TairuFramework/sozai",
    "directory": "packages/lock"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": "./lib/index.js"
  },
  "files": [
    "lib/*"
  ],
  "sideEffects": false,
  "scripts": {
    "build:clean": "del lib",
    "build:js": "swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths",
    "build:types": "tsc --emitDeclarationOnly --skipLibCheck",
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "test:types": "tsc --noEmit --skipLibCheck -p tsconfig.test.json",
    "test:unit": "vitest run",
    "test": "pnpm run test:types && pnpm run test:unit",
    "prepublishOnly": "pnpm run build"
  },
  "dependencies": {
    "@sozai/async": "workspace:^"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

`packages/lock/tsconfig.json` — the package's own source uses `node:` builtins, so unlike `packages/log` it needs `"types": ["node"]` in the **build** config too:

```json
{
  "extends": "@kigu/dev/tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib",
    "types": ["node"]
  },
  "include": ["./src/**/*"]
}
```

`packages/lock/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["./src/**/*", "./test/**/*"]
}
```

Copy the license file verbatim: `cp packages/log/LICENSE packages/lock/LICENSE`

- [ ] **Step 2: Link the workspace**

Run: `pnpm install`
Expected: pnpm reports the new `@sozai/lock` project (15 workspace projects) and links `@sozai/async` into `packages/lock/node_modules`.

- [ ] **Step 3: Write the failing test**

`packages/lock/test/record.test.ts`:

```ts
import { hostname } from 'node:os'
import { describe, expect, test } from 'vitest'

import { createLockRecord, getBootAt, isLockRecord, parseLockRecord } from '../src/record.js'

function validRecord() {
  return { pid: 123, hostname: 'host-a', bootAt: 1_000, startedAt: 2_000 }
}

describe('getBootAt()', () => {
  test('is in the past and within a plausible uptime window', () => {
    const bootAt = getBootAt()
    expect(bootAt).toBeLessThanOrEqual(Date.now())
    expect(Number.isFinite(bootAt)).toBe(true)
  })

  test('is stable across calls, within a second', () => {
    expect(Math.abs(getBootAt() - getBootAt())).toBeLessThan(1_000)
  })
})

describe('createLockRecord()', () => {
  test('describes this process on this host and this boot', () => {
    const record = createLockRecord()
    expect(record.pid).toBe(process.pid)
    expect(record.hostname).toBe(hostname())
    expect(Math.abs(record.bootAt - getBootAt())).toBeLessThan(1_000)
    expect(Math.abs(record.startedAt - Date.now())).toBeLessThan(1_000)
    expect(isLockRecord(record)).toBe(true)
  })
})

describe('isLockRecord()', () => {
  test('accepts a conforming record', () => {
    expect(isLockRecord(validRecord())).toBe(true)
  })

  test.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(isLockRecord(value)).toBe(false)
  })

  // A non-positive pid is not a holder, it is a weapon: process.kill(0, sig) signals the
  // whole process group — the reader included — and kill(-1, sig) everything the user may
  // signal. Refuse it here, where every reader passes.
  test.each([0, -1, -123, 1.5, Number.NaN])('rejects pid %p', (pid) => {
    expect(isLockRecord({ ...validRecord(), pid })).toBe(false)
  })

  test.each([
    ['missing hostname', { pid: 1, bootAt: 1, startedAt: 1 }],
    ['empty hostname', { ...validRecord(), hostname: '' }],
    ['non-string hostname', { ...validRecord(), hostname: 42 }],
    ['non-finite bootAt', { ...validRecord(), bootAt: Number.POSITIVE_INFINITY }],
    ['missing startedAt', { pid: 1, hostname: 'h', bootAt: 1 }],
    ['non-finite startedAt', { ...validRecord(), startedAt: Number.NaN }],
  ])('rejects %s', (_label, value) => {
    expect(isLockRecord(value)).toBe(false)
  })
})

describe('parseLockRecord()', () => {
  test('parses a conforming record', () => {
    expect(parseLockRecord(JSON.stringify(validRecord()))).toEqual(validRecord())
  })

  test.each([
    ['invalid JSON', '{ not json'],
    ['an empty file', ''],
    ['a non-conforming record', JSON.stringify({ pid: 0, hostname: 'h' })],
  ])('returns null for %s', (_label, raw) => {
    expect(parseLockRecord(raw)).toBeNull()
  })
})
```

- [ ] **Step 4: Run the test and watch it fail**

Run: `cd packages/lock && pnpm exec vitest run test/record.test.ts`
Expected: FAIL — `Failed to resolve import "../src/record.js"`.

- [ ] **Step 5: Write the implementation**

`packages/lock/src/record.ts`:

```ts
import { hostname, uptime } from 'node:os'

/**
 * The on-disk lock. It carries what a waiter needs to *prove* the holder is alive, and
 * nothing else — never key material, never caller payload. Whatever the lock guards stays
 * in the store the lock guards.
 */
export type LockRecord = {
  pid: number
  hostname: string
  /** Host boot time in ms since epoch. See `getBootAt`. */
  bootAt: number
  startedAt: number
}

/**
 * When this host booted. Pid-probing across a reboot is a lie: pids are recycled from a small
 * space, so after a reboot the pid in a stale lockfile is very likely alive again as an
 * unrelated process — and a lock on a persistent path would wedge forever. Comparing boot
 * times tells the two apart.
 */
export function getBootAt(): number {
  return Date.now() - uptime() * 1000
}

export function createLockRecord(): LockRecord {
  return { pid: process.pid, hostname: hostname(), bootAt: getBootAt(), startedAt: Date.now() }
}

export function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    // A non-positive pid is not a holder, it is a weapon: `process.kill(0, sig)` signals the
    // WHOLE process group — the process reading this lockfile included — and `kill(-1, sig)`
    // every process the user may signal. Worse, `kill(0, 0)` succeeds, so such a record would
    // classify as a live holder. Refuse it here, where every reader passes.
    record.pid > 0 &&
    typeof record.hostname === 'string' &&
    record.hostname !== '' &&
    typeof record.bootAt === 'number' &&
    Number.isFinite(record.bootAt) &&
    typeof record.startedAt === 'number' &&
    Number.isFinite(record.startedAt)
  )
}

/**
 * Parse a record, or return null when the content is not a conforming one. Callers treat a
 * corrupt record exactly as they treat a missing file: the holder's liveness is unprovable.
 */
export function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLockRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
```

`packages/lock/src/index.ts` (grows in later tasks):

```ts
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

export type { LockRecord } from './record.js'
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd packages/lock && pnpm exec vitest run test/record.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 7: Typecheck and lint**

Run: `cd packages/lock && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd ../.. && pnpm exec biome check --write ./packages/lock`
Expected: no type errors; Biome reports files checked, fixes applied silently if any.

- [ ] **Step 8: Commit**

```bash
git add packages/lock pnpm-lock.yaml
git commit -m "feat(lock): package scaffolding and the on-disk lock record"
```

---

## Task 2: Filesystem primitives — atomic claim, guarded reap

**Files:**
- Create: `packages/lock/src/file.ts`
- Test: `packages/lock/test/file.test.ts`

**Interfaces:**
- Consumes: `LockRecord`, `parseLockRecord`, `createLockRecord` from `./record.js`.
- Produces:
  - `type LockEntry = { record: LockRecord | null; inode: number | null; mtimeMs: number | null }`
  - `type ClaimResult = { inode: number } | { conflict: LockEntry }`
  - `readLockEntry(lockPath: string): LockEntry`
  - `claimLockFile(lockPath: string, record: LockRecord): ClaimResult`
  - `reapLockFile(lockPath: string, expectedInode: number): boolean`
  - `sweepTempRecords(lockPath: string): void`

- [ ] **Step 1: Write the failing test**

`packages/lock/test/file.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
```

Add `readdirSync` to the `node:fs` import at the top of the test file.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/lock && pnpm exec vitest run test/file.test.ts`
Expected: FAIL — `Failed to resolve import "../src/file.js"`.

- [ ] **Step 3: Write the implementation**

`packages/lock/src/file.ts`:

```ts
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
 */
export function readLockEntry(lockPath: string): LockEntry {
  let fd: number
  try {
    fd = openSync(lockPath, 'r')
  } catch {
    return { record: null, inode: null, mtimeMs: null }
  }
  try {
    const stats = fstatSync(fd)
    return {
      record: parseLockRecord(readFileSync(fd, 'utf8')),
      inode: stats.ino,
      mtimeMs: stats.mtimeMs,
    }
  } catch {
    return { record: null, inode: null, mtimeMs: null }
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
 * Remove orphaned `.tmp` siblings. The claim is only atomic because the content exists under a
 * throwaway name first — but a SIGKILL landing in that window leaves the throwaway behind
 * forever, and a crash-looping process quietly accumulates them. Only files old enough that no
 * live claim could still be linking one are touched, so a concurrent claimer's fresh temp file
 * is never pulled out from under it. Best-effort throughout: a claim must never fail because
 * tidying up did.
 */
export function sweepTempRecords(lockPath: string): void {
  const prefix = `${basename(lockPath)}.`
  const cutoff = Date.now() - TEMP_RECORD_MAX_AGE_MS
  try {
    for (const name of readdirSync(dirname(lockPath))) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
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
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd packages/lock && pnpm exec vitest run test/file.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/lock && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd ../.. && pnpm exec biome check --write ./packages/lock`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/lock
git commit -m "feat(lock): atomic link() claim, inode-guarded reap, temp sweep"
```

---

## Task 3: Liveness and staleness classification

**Files:**
- Create: `packages/lock/src/liveness.ts`
- Test: `packages/lock/test/liveness.test.ts`

**Interfaces:**
- Consumes: `LockRecord`, `getBootAt` from `./record.js`; `LockEntry` from `./file.js`.
- Produces:
  - `type Liveness = 'alive' | 'dead' | 'unknown'`
  - `checkLiveness(record: LockRecord): Liveness`
  - `isStale(entry: LockEntry, staleTimeout: number, now?: number): boolean`
  - `const BOOT_TOLERANCE_MS = 30_000`

- [ ] **Step 1: Write the failing test**

`packages/lock/test/liveness.test.ts`:

```ts
import { hostname } from 'node:os'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { LockEntry } from '../src/file.js'
import { BOOT_TOLERANCE_MS, checkLiveness, isStale } from '../src/liveness.js'
import { getBootAt, type LockRecord } from '../src/record.js'

function localRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    pid: process.pid,
    hostname: hostname(),
    bootAt: getBootAt(),
    startedAt: Date.now(),
    ...overrides,
  }
}

function entry(record: LockRecord | null, mtimeMs: number | null = Date.now()): LockEntry {
  return { record, inode: 42, mtimeMs }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkLiveness()', () => {
  test('alive: our own live pid, same host, same boot', () => {
    expect(checkLiveness(localRecord())).toBe('alive')
  })

  test('dead: a pid that no longer exists', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process')
      err.code = 'ESRCH'
      throw err
    })
    expect(checkLiveness(localRecord({ pid: 999_999 }))).toBe('dead')
  })

  // The process exists, it simply belongs to another user. That is a live holder.
  test('alive: EPERM from the probe', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    })
    expect(checkLiveness(localRecord({ pid: 1 }))).toBe('alive')
  })

  test('unknown: a foreign hostname, without probing the pid', () => {
    const kill = vi.spyOn(process, 'kill')
    expect(checkLiveness(localRecord({ hostname: 'some-other-host' }))).toBe('unknown')
    expect(kill).not.toHaveBeenCalled()
  })

  // After a reboot the recorded pid is very likely alive again as an unrelated process. Probing
  // it would report a live holder and wedge a persistent lockPath forever.
  test('unknown: a boot time outside the tolerance, without probing the pid', () => {
    const kill = vi.spyOn(process, 'kill')
    const record = localRecord({ bootAt: getBootAt() - BOOT_TOLERANCE_MS - 1_000 })
    expect(checkLiveness(record)).toBe('unknown')
    expect(kill).not.toHaveBeenCalled()
  })

  test('alive: a boot time inside the tolerance (clock drift is not a reboot)', () => {
    const record = localRecord({ bootAt: getBootAt() - (BOOT_TOLERANCE_MS - 5_000) })
    expect(checkLiveness(record)).toBe('alive')
  })
})

describe('isStale()', () => {
  const now = 1_000_000
  const staleTimeout = 60_000

  test('a provably-live holder is never stale, however long it has held', () => {
    const record = localRecord({ startedAt: now - 24 * 60 * 60 * 1000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(false)
  })

  test('a provably-dead holder is stale immediately, whatever the TTL', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process')
      err.code = 'ESRCH'
      throw err
    })
    const record = localRecord({ pid: 999_999, startedAt: now })
    expect(isStale(entry(record), staleTimeout, now)).toBe(true)
  })

  test('an unprovable holder is respected until the TTL expires', () => {
    const record = localRecord({ hostname: 'other-host', startedAt: now - 59_000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(false)
  })

  test('an unprovable holder is stale once the TTL expires', () => {
    const record = localRecord({ hostname: 'other-host', startedAt: now - 61_000 })
    expect(isStale(entry(record), staleTimeout, now)).toBe(true)
  })

  test('a corrupt record is dated by the file mtime, and respected until the TTL expires', () => {
    expect(isStale(entry(null, now - 59_000), staleTimeout, now)).toBe(false)
    expect(isStale(entry(null, now - 61_000), staleTimeout, now)).toBe(true)
  })

  test('a vanished file is stale: there is nothing left to respect', () => {
    expect(isStale({ record: null, inode: null, mtimeMs: null }, staleTimeout, now)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/lock && pnpm exec vitest run test/liveness.test.ts`
Expected: FAIL — `Failed to resolve import "../src/liveness.js"`.

- [ ] **Step 3: Write the implementation**

`packages/lock/src/liveness.ts`:

```ts
import { hostname } from 'node:os'

import type { LockEntry } from './file.js'
import { getBootAt, type LockRecord } from './record.js'

/**
 * How far the recorded boot time may drift from ours and still describe the same boot.
 * `os.uptime()` and `Date.now()` diverge under NTP correction, so the comparison needs slack —
 * and a mismatch only downgrades a holder to `unknown` (TTL decides), never reaps it. Clock skew
 * therefore costs latency, never mutual exclusion.
 */
export const BOOT_TOLERANCE_MS = 30_000

export type Liveness = 'alive' | 'dead' | 'unknown'

/**
 * Liveness is proven, never assumed. A pid is only meaningful on the host that recorded it and
 * within the boot that recorded it: across hosts, and across a reboot, the same number belongs
 * to somebody else.
 */
export function checkLiveness(record: LockRecord): Liveness {
  if (record.hostname !== hostname()) {
    return 'unknown'
  }
  if (Math.abs(record.bootAt - getBootAt()) > BOOT_TOLERANCE_MS) {
    return 'unknown'
  }
  try {
    // Signal 0 performs the permission and existence check without delivering a signal. The
    // record was validated with `pid > 0`, so this can never signal a process group.
    process.kill(record.pid, 0)
    return 'alive'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      return 'dead'
    }
    // EPERM: the process exists, it just belongs to another user. That is a live holder.
    return code === 'EPERM' ? 'alive' : 'unknown'
  }
}

/**
 * May a waiter take this lock away from its holder?
 *
 * A provably-live holder is NEVER stale, no matter how long it has held the lock. This is the
 * requirement that rules out a heartbeat design: a critical section can block the event loop for
 * minutes (a synchronous keyring call, an OS keychain prompt), so any liveness signal the holder
 * has to emit on a timer would starve — and a TTL-based reaper would then hand a second process
 * the same critical section. Exactly the bug this package exists to prevent.
 *
 * The TTL applies only where the pid means nothing: a foreign host, a different boot, or a record
 * too corrupt to identify a holder at all (dated, then, by the file's own mtime).
 */
export function isStale(entry: LockEntry, staleTimeout: number, now: number = Date.now()): boolean {
  const { record, mtimeMs } = entry
  if (record == null) {
    // No holder can be identified. Only the filesystem can date the file, and a file that has
    // vanished under us is not a lock anyone still holds.
    return mtimeMs == null || now - mtimeMs > staleTimeout
  }
  switch (checkLiveness(record)) {
    case 'alive':
      return false
    case 'dead':
      return true
    case 'unknown':
      return now - record.startedAt > staleTimeout
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd packages/lock && pnpm exec vitest run test/liveness.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/lock && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd ../.. && pnpm exec biome check --write ./packages/lock`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/lock
git commit -m "feat(lock): pid-probe liveness with bootAt guard, TTL only where unprovable"
```

---

## Task 4: In-process FIFO queue

**Files:**
- Create: `packages/lock/src/queue.ts`
- Test: `packages/lock/test/queue.test.ts`

**Interfaces:**
- Consumes: `defer` from `@sozai/async`.
- Produces:
  - `type QueueSlot = { turn: Promise<void>; release: () => void }`
  - `enterQueue(lockPath: string): QueueSlot`
  - `getQueueSize(): number` — test-only introspection, exported from the module but **not** from `src/index.ts`.

- [ ] **Step 1: Write the failing test**

`packages/lock/test/queue.test.ts`:

```ts
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { enterQueue, getQueueSize } from '../src/queue.js'

describe('enterQueue()', () => {
  test('the first caller takes its turn immediately', async () => {
    const slot = enterQueue('/tmp/sozai-queue-a.lock')
    await expect(slot.turn).resolves.toBeUndefined()
    slot.release()
  })

  test('serializes callers on the same path in FIFO order', async () => {
    const path = '/tmp/sozai-queue-b.lock'
    const order: Array<number> = []

    const run = async (id: number) => {
      const slot = enterQueue(path)
      await slot.turn
      order.push(id)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(-id)
      slot.release()
    }

    await Promise.all([run(1), run(2), run(3)])

    // Never interleaved: each entry is immediately followed by its own exit.
    expect(order).toEqual([1, -1, 2, -2, 3, -3])
  })

  test('does not serialize callers on different paths', async () => {
    const first = enterQueue('/tmp/sozai-queue-c.lock')
    const second = enterQueue('/tmp/sozai-queue-d.lock')
    await first.turn
    await expect(second.turn).resolves.toBeUndefined()
    first.release()
    second.release()
  })

  test('keys on the resolved path, so relative and absolute forms are one queue', async () => {
    const absolute = join(process.cwd(), 'sozai-queue-e.lock')
    const held = enterQueue(absolute)
    await held.turn

    const waiter = enterQueue('./sozai-queue-e.lock')
    let tookTurn = false
    void waiter.turn.then(() => {
      tookTurn = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tookTurn).toBe(false)

    held.release()
    await waiter.turn
    expect(tookTurn).toBe(true)
    waiter.release()
  })

  // A caller that gives up while queued must not strand everyone behind it.
  test('releasing a slot whose turn never came lets the successor through', async () => {
    const path = '/tmp/sozai-queue-f.lock'
    const held = enterQueue(path)
    await held.turn

    const abandoned = enterQueue(path)
    const successor = enterQueue(path)

    abandoned.release()
    held.release()

    await expect(successor.turn).resolves.toBeUndefined()
    successor.release()
  })

  test('release is idempotent', async () => {
    const path = '/tmp/sozai-queue-g.lock'
    const slot = enterQueue(path)
    await slot.turn
    slot.release()
    slot.release()

    const next = enterQueue(path)
    await expect(next.turn).resolves.toBeUndefined()
    next.release()
  })

  test('drops its map entry once the last caller releases', async () => {
    const before = getQueueSize()
    const slot = enterQueue('/tmp/sozai-queue-h.lock')
    await slot.turn
    expect(getQueueSize()).toBe(before + 1)

    slot.release()
    // The entry is dropped asynchronously, once the tail settles.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getQueueSize()).toBe(before)
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/lock && pnpm exec vitest run test/queue.test.ts`
Expected: FAIL — `Failed to resolve import "../src/queue.js"`.

- [ ] **Step 3: Write the implementation**

`packages/lock/src/queue.ts`:

```ts
import { defer } from '@sozai/async'
import { resolve } from 'node:path'

export type QueueSlot = {
  /** Resolves when every earlier caller on this path has released. */
  turn: Promise<void>
  /** Hand the path to the next caller. Idempotent, and safe to call before the turn arrives. */
  release: () => void
}

/**
 * FIFO chain of same-process callers, one per resolved path.
 *
 * Without it, two callers in one process fight through the filesystem — and the second reads a
 * lockfile whose pid is its OWN live pid, so it can never reap it and simply polls until the
 * first releases. Correct, but it pays backoff latency for the most common case in an app.
 *
 * The map is per-realm, like any module state: it does not span worker threads or `vm` contexts,
 * and it does not need to. The file is the lock; this is only a fast path in front of it.
 *
 * Keyed on `resolve`, not `realpath`, because the lockfile need not exist yet. Two aliased paths
 * (through a symlinked directory) therefore fall back to filesystem contention — correct, merely
 * slower.
 */
const queues = new Map<string, Promise<void>>()

export function enterQueue(lockPath: string): QueueSlot {
  const key = resolve(lockPath)
  const previous = queues.get(key) ?? Promise.resolve()
  const ticket = defer<void>()
  // The chain is built from tickets that only ever resolve, so it can never reject and no
  // caller can poison the queue for the ones behind it.
  const current = previous.then(() => ticket.promise)
  queues.set(key, current)

  let released = false
  return {
    turn: previous,
    release(): void {
      if (released) {
        return
      }
      released = true
      ticket.resolve()
      void current.then(() => {
        // Only the tail may drop the entry: a later caller may already have chained onto it.
        if (queues.get(key) === current) {
          queues.delete(key)
        }
      })
    },
  }
}

/** Test-only introspection: the number of paths currently queued. Not part of the public API. */
export function getQueueSize(): number {
  return queues.size
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd packages/lock && pnpm exec vitest run test/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/lock && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd ../.. && pnpm exec biome check --write ./packages/lock`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/lock
git commit -m "feat(lock): in-process FIFO queue per resolved lock path"
```

---

## Task 5: The public lock — acquire, backoff, deadline, release

**Files:**
- Create: `packages/lock/src/lock.ts`
- Modify: `packages/lock/src/index.ts`
- Test: `packages/lock/test/lock.test.ts`

**Interfaces:**
- Consumes: `claimLockFile`, `reapLockFile`, `readLockEntry`, `LockEntry` from `./file.js`; `isStale` from `./liveness.js`; `createLockRecord` from `./record.js`; `enterQueue` from `./queue.js`; `sleep`, `raceSignal`, `onAbort`, `ScheduledTimeout` from `@sozai/async`.
- Produces:
  - `type FileLockOptions = { timeout?: number; staleTimeout?: number; retryDelay?: number; maxRetryDelay?: number; signal?: AbortSignal }`
  - `type FileLock = Disposable & { readonly path: string; release(): void }`
  - `acquireFileLock(lockPath: string, options?: FileLockOptions): Promise<FileLock>`
  - `withFileLock<T>(lockPath: string, fn: () => Promise<T>, options?: FileLockOptions): Promise<T>`

- [ ] **Step 1: Write the failing test**

`packages/lock/test/lock.test.ts`:

```ts
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { TimeoutInterruption } from '@sozai/async'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { claimLockFile, readLockEntry } from '../src/file.js'
import { acquireFileLock, withFileLock } from '../src/lock.js'
import { getBootAt, type LockRecord } from '../src/record.js'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-'))
  lockPath = join(dir, 'store.lock')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** A holder this process cannot probe: same host, but a boot that is not ours. */
function unprovableHolder(startedAt: number): LockRecord {
  return {
    pid: 999_999,
    hostname: hostname(),
    bootAt: getBootAt() - 10 * 60 * 60 * 1000,
    startedAt,
  }
}

describe('acquireFileLock()', () => {
  test('acquires a free lock and writes a record', async () => {
    const lock = await acquireFileLock(lockPath)

    expect(lock.path).toBe(lockPath)
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)

    lock.release()
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  test('release is idempotent and never removes a lock that is not ours', async () => {
    const lock = await acquireFileLock(lockPath)
    lock.release()

    // Someone else takes the path.
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const holder = readLockEntry(lockPath).record

    lock.release()

    expect(readLockEntry(lockPath).record).toEqual(holder)
  })

  test('works as a Disposable', async () => {
    {
      using lock = await acquireFileLock(lockPath)
      expect(lock.path).toBe(lockPath)
      expect(readLockEntry(lockPath).record).not.toBeNull()
    }
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  test('reaps a dead holder and takes the lock', async () => {
    // A record with our host and boot, but a pid that no longer exists.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process')
      err.code = 'ESRCH'
      throw err
    })
    claimLockFile(lockPath, {
      pid: 999_999,
      hostname: hostname(),
      bootAt: getBootAt(),
      startedAt: Date.now(),
    })

    const lock = await acquireFileLock(lockPath, { timeout: 1_000 })
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    lock.release()
  })

  test('reaps an unprovable holder once its TTL has expired', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now() - 61_000))

    const lock = await acquireFileLock(lockPath, { timeout: 1_000, staleTimeout: 60_000 })
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    lock.release()
  })

  test('reaps a corrupt record once its TTL has expired', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    writeFileSync(lockPath, '{ not json')
    // A corrupt record cannot date itself, so the file's mtime dates it. Backdate the file rather
    // than passing `staleTimeout: 0`, which would race the millisecond the file was written.
    const longAgo = new Date(Date.now() - 61_000)
    utimesSync(lockPath, longAgo, longAgo)

    const lock = await acquireFileLock(lockPath, { timeout: 1_000, staleTimeout: 60_000 })
    expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
    lock.release()
  })

  test('times out rather than taking a lock from a holder within its TTL', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const holder = readLockEntry(lockPath).record

    await expect(
      acquireFileLock(lockPath, { timeout: 100, staleTimeout: 60_000 }),
    ).rejects.toBeInstanceOf(TimeoutInterruption)

    // The holder's lock is untouched.
    expect(readLockEntry(lockPath).record).toEqual(holder)
  })

  test('rejects with the caller reason when the signal aborts mid-wait', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const controller = new AbortController()
    const reason = new Error('caller gave up')

    const acquiring = acquireFileLock(lockPath, { timeout: 5_000, signal: controller.signal })
    setTimeout(() => controller.abort(reason), 20)

    await expect(acquiring).rejects.toBe(reason)
  })

  test('an abandoned waiter does not strand the next caller in this process', async () => {
    const held = await acquireFileLock(lockPath)
    const controller = new AbortController()

    const abandoned = acquireFileLock(lockPath, { timeout: 5_000, signal: controller.signal })
    const successor = acquireFileLock(lockPath, { timeout: 5_000 })

    controller.abort(new Error('gave up'))
    await expect(abandoned).rejects.toThrow('gave up')

    held.release()
    const lock = await successor
    expect(lock.path).toBe(lockPath)
    lock.release()
  })
})

describe('withFileLock()', () => {
  test('runs the critical section under the lock and releases after it', async () => {
    const result = await withFileLock(lockPath, async () => {
      expect(readLockEntry(lockPath).record?.pid).toBe(process.pid)
      return 'done'
    })

    expect(result).toBe('done')
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  test('releases the lock when the critical section throws, and rethrows', async () => {
    const failure = new Error('boom')

    await expect(withFileLock(lockPath, () => Promise.reject(failure))).rejects.toBe(failure)
    expect(readLockEntry(lockPath).record).toBeNull()
  })

  // The whole point of the package: a contended lock must never fall through to the section.
  test('does NOT run the critical section when acquisition times out', async () => {
    claimLockFile(lockPath, unprovableHolder(Date.now()))
    const fn = vi.fn(() => Promise.resolve('ran'))

    await expect(
      withFileLock(lockPath, fn, { timeout: 100, staleTimeout: 60_000 }),
    ).rejects.toBeInstanceOf(TimeoutInterruption)

    expect(fn).not.toHaveBeenCalled()
  })

  test('serializes concurrent callers in this process without interleaving', async () => {
    const events: Array<string> = []
    const section = (id: string) =>
      withFileLock(lockPath, async () => {
        events.push(`enter ${id}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        events.push(`exit ${id}`)
      })

    await Promise.all([section('a'), section('b'), section('c')])

    expect(events).toEqual([
      'enter a',
      'exit a',
      'enter b',
      'exit b',
      'enter c',
      'exit c',
    ])
  })

  test('the timeout bounds acquisition only, never the critical section', async () => {
    const result = await withFileLock(
      lockPath,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return 'finished'
      },
      { timeout: 20 },
    )

    expect(result).toBe('finished')
  })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/lock && pnpm exec vitest run test/lock.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lock.js"`.

- [ ] **Step 3: Write the implementation**

`packages/lock/src/lock.ts`:

```ts
import { onAbort, raceSignal, ScheduledTimeout, sleep } from '@sozai/async'

import { claimLockFile, reapLockFile } from './file.js'
import { isStale } from './liveness.js'
import { enterQueue } from './queue.js'
import { createLockRecord } from './record.js'

export type FileLockOptions = {
  /**
   * Milliseconds to wait for the lock before throwing. Bounds ACQUISITION ONLY — once the lock
   * is held, the critical section runs to completion. Default 10_000.
   */
  timeout?: number
  /**
   * Milliseconds after which a holder whose liveness cannot be proven (a foreign host, a
   * different boot, a corrupt record) is treated as stale. A holder that IS provably alive is
   * never stale, whatever this is set to. Default 60_000.
   */
  staleTimeout?: number
  /** Initial retry delay in milliseconds. Default 10. */
  retryDelay?: number
  /** Retry delay ceiling in milliseconds. Default 250. */
  maxRetryDelay?: number
  /** Aborts a pending acquisition. Has no effect once the lock is held. */
  signal?: AbortSignal
}

export type FileLock = Disposable & {
  readonly path: string
  /** Unlink the lockfile, but only while it still holds the inode we linked. Idempotent. */
  release(): void
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_STALE_TIMEOUT = 60_000
const DEFAULT_RETRY_DELAY = 10
const DEFAULT_MAX_RETRY_DELAY = 250

/**
 * Every lock this process currently holds, so a clean exit does not leave one behind for the next
 * run to wait out. SIGKILL and hard crashes are what the staleness rules are for; this only
 * covers `process.exit()` and a default-handled SIGINT.
 */
const heldLocks = new Set<{ path: string; inode: number }>()
let exitHookInstalled = false

function trackHeldLock(entry: { path: string; inode: number }): void {
  heldLocks.add(entry)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const held of heldLocks) {
        // Inode-guarded, like every other unlink here: never remove a lock that is no longer ours.
        reapLockFile(held.path, held.inode)
      }
    })
  }
}

/** Exponential backoff, halved and jittered so processes released together do not re-collide. */
function backoffDelay(attempt: number, retryDelay: number, maxRetryDelay: number): number {
  const ceiling = Math.min(retryDelay * 2 ** attempt, maxRetryDelay)
  return ceiling / 2 + Math.random() * (ceiling / 2)
}

/**
 * Acquire an exclusive cross-process lock on `lockPath`, waiting for the current holder to
 * release it. Throws `TimeoutInterruption` when the lock cannot be taken within `timeout`, and
 * rejects with `signal.reason` when the caller aborts. It never resolves without the lock.
 *
 * `lockPath` MUST be on a local filesystem: the atomicity of `link()` is not guaranteed on NFS.
 *
 * Not reentrant: acquiring the same path twice in one process, without releasing, deadlocks until
 * the timeout fires.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLock> {
  const {
    timeout = DEFAULT_TIMEOUT,
    staleTimeout = DEFAULT_STALE_TIMEOUT,
    retryDelay = DEFAULT_RETRY_DELAY,
    maxRetryDelay = DEFAULT_MAX_RETRY_DELAY,
    signal,
  } = options

  using deadline = ScheduledTimeout.in(timeout, {
    message: `Timeout acquiring lock ${lockPath} after ${timeout}ms`,
  })
  const controller = new AbortController()
  const unsubscribeDeadline = onAbort(deadline.signal, () => {
    controller.abort(deadline.signal.reason)
  })
  const unsubscribeCaller = onAbort(signal, () => {
    controller.abort(signal?.reason)
  })

  // The queue slot must be released on EVERY exit path, or the callers behind us wait forever.
  const slot = enterQueue(lockPath)
  try {
    await raceSignal(slot.turn, controller.signal)

    const record = createLockRecord()
    let attempt = 0

    for (;;) {
      controller.signal.throwIfAborted()

      const result = claimLockFile(lockPath, record)
      if ('inode' in result) {
        const held = { path: lockPath, inode: result.inode }
        trackHeldLock(held)

        let released = false
        const release = (): void => {
          if (released) {
            return
          }
          released = true
          heldLocks.delete(held)
          reapLockFile(lockPath, held.inode)
          slot.release()
        }
        return { path: lockPath, release, [Symbol.dispose]: release }
      }

      const entry = result.conflict
      if (entry.inode != null && isStale(entry, staleTimeout) && reapLockFile(lockPath, entry.inode)) {
        // The holder is gone and its file with it. Claim again immediately.
        continue
      }
      // Either the holder is alive, or we lost the reap race to another waiter. Both mean: back
      // off and look again.
      await raceSignal(sleep(backoffDelay(attempt++, retryDelay, maxRetryDelay)), controller.signal)
    }
  } catch (err) {
    slot.release()
    throw err
  } finally {
    unsubscribeDeadline()
    unsubscribeCaller()
  }
}

/**
 * Run `fn` under an exclusive cross-process lock on `lockPath`, releasing it however `fn`
 * settles. If the lock cannot be acquired within `timeout`, this THROWS and `fn` is never called:
 * running the critical section unlocked would drop the guard at exactly the moment contention is
 * real.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lock = await acquireFileLock(lockPath, options)
  try {
    return await fn()
  } finally {
    lock.release()
  }
}
```

`packages/lock/src/index.ts` (full replacement):

```ts
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

export type { LockEntry } from './file.js'
export type { FileLock, FileLockOptions } from './lock.js'
export { acquireFileLock, withFileLock } from './lock.js'
export type { LockRecord } from './record.js'
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd packages/lock && pnpm exec vitest run test/lock.test.ts`
Expected: PASS. If `ScheduledTimeout.in(timeout, { message })` does not accept a message option, check `packages/async/src/timeout.ts` and `interruptions.ts` for the actual `InterruptionOptions` shape and adjust the call — the requirement is only that a timeout rejects with `TimeoutInterruption`.

- [ ] **Step 5: Run the whole suite, typecheck, lint**

Run: `cd packages/lock && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd ../.. && pnpm exec biome check --write ./packages/lock`
Expected: all tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/lock
git commit -m "feat(lock): acquireFileLock/withFileLock with backoff, deadline, exit sweep"
```

---

## Task 6: Cross-process proof

**Files:**
- Create: `packages/lock/test/fixtures/lock-child.ts`, `packages/lock/test/cross-process.test.ts`

**Interfaces:**
- Consumes: `withFileLock` from `../../src/index.js`.
- Produces: nothing importable — this task produces the evidence that the package works at all.

Nothing in-process can prove the claim is atomic: every in-process test shares one pid, one module instance, and one filesystem cache. This test forks real children.

- [ ] **Step 1: Write the child fixture**

`packages/lock/test/fixtures/lock-child.ts`:

```ts
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
```

- [ ] **Step 2: Verify a child can run at all, by hand**

The children are TypeScript, so they need a loader. `tsx` is hoisted at the workspace root.

Run, from the repo root:
```bash
node --import tsx packages/lock/test/fixtures/lock-child.ts /tmp/sozai-manual.lock /tmp/sozai-manual.witness solo 10 && cat /tmp/sozai-manual.witness && rm -f /tmp/sozai-manual.lock /tmp/sozai-manual.witness
```
Expected: exit code 0, and the witness file contains exactly:
```
enter solo
exit solo
```
If `--import tsx` fails to resolve, try `node --import tsx/esm ...`; if that also fails, use `node --experimental-strip-types ...`. Whichever form works here is the one the test in Step 3 must spawn — do not guess, and do not leave both in.

- [ ] **Step 3: Write the failing test**

`packages/lock/test/cross-process.test.ts`:

```ts
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'

const run = promisify(execFile)

const CHILD = fileURLToPath(new URL('./fixtures/lock-child.ts', import.meta.url))
const CHILDREN = 6

let dir: string
let lockPath: string
let witnessPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sozai-lock-xp-'))
  lockPath = join(dir, 'store.lock')
  witnessPath = join(dir, 'witness.log')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test(
  'concurrent processes never hold the lock at the same time',
  async () => {
    await Promise.all(
      Array.from({ length: CHILDREN }, (_unused, index) =>
        run(process.execPath, [
          '--import',
          'tsx',
          CHILD,
          lockPath,
          witnessPath,
          `child-${index}`,
          // Varied hold times, so a broken lock interleaves visibly rather than by luck.
          String(20 + index * 15),
        ]),
      ),
    )

    const lines = readFileSync(witnessPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(CHILDREN * 2)

    // Every `enter` is immediately followed by its OWN `exit`. Any interleaving means two
    // processes were inside the critical section at once — the bug this package exists to stop.
    for (let index = 0; index < lines.length; index += 2) {
      const [enterWord, enterID] = lines[index].split(' ')
      const [exitWord, exitID] = lines[index + 1].split(' ')
      expect(enterWord).toBe('enter')
      expect(exitWord).toBe('exit')
      expect(exitID).toBe(enterID)
    }

    // Every child got its turn.
    const ids = new Set(lines.map((line) => line.split(' ')[1]))
    expect(ids.size).toBe(CHILDREN)

    // The last holder released: no lockfile is left behind.
    expect(() => readFileSync(lockPath, 'utf8')).toThrow()
  },
  30_000,
)
```

- [ ] **Step 4: Run it**

Run: `cd packages/lock && pnpm exec vitest run test/cross-process.test.ts`
Expected: PASS. A failure here is not a flaky test — it means the claim is not atomic. Debug it, do not retry it.

- [ ] **Step 5: Sanity-check that the test can actually fail**

Temporarily replace the body of `withFileLock` in `src/lock.ts` with a direct call — `return await fn()` — and rerun the cross-process test.
Expected: FAIL, with interleaved witness lines. **Revert the change immediately** and rerun to confirm PASS. A green test that cannot go red proves nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/lock
git commit -m "test(lock): prove mutual exclusion across forked processes"
```

---

## Task 7: Docs, registration, changeset

**Files:**
- Create: `packages/lock/README.md`, `.changeset/lock-package.md`
- Modify: `docs/reference/runtime.md`, `docs/skills/runtime.skill.md`, `docs/skills/discover.skill.md`, `docs/agents/architecture.md`

- [ ] **Step 1: Write the package README**

`packages/lock/README.md` (the sibling READMEs are minimal — `# @sozai/stream` plus an install snippet — so match that, with the two constraints a consumer must not miss):

```markdown
# @sozai/lock

Cross-process file mutex. **Node.js only.**

## Installation

```sh
npm install @sozai/lock
```

## Usage

```ts
import { withFileLock } from '@sozai/lock'

const key = await withFileLock(`${dataDir}/keystore.lock`, async () => {
  const existing = await store.get(keyID)
  return existing ?? (await store.set(keyID, await generateKey()))
})
```

## Constraints

- `lockPath` must be on a **local filesystem**. `link()` atomicity is not guaranteed on NFS.
- Acquisition is bounded by `timeout` (default 10s) and **throws** when it expires — the critical
  section never runs unlocked.
- Not reentrant: acquiring the same path twice in one process, without releasing, deadlocks until
  the timeout fires.
```

- [ ] **Step 2: Register the package in the reference docs**

In `docs/reference/runtime.md`, add `@sozai/lock` to the Packages table:

```markdown
| `@sozai/lock` | Cross-process file mutex; Node-only (`node:fs`) |
```

Then add a `## @sozai/lock` section after the `@sozai/runtime-expo` section, following the shape of the sections already there (an Exports table, then a usage snippet):

```markdown
## @sozai/lock

> **Node-only.** The only package in sozai that is not environment-agnostic. `lockPath` must be on
> a local filesystem — `link()` atomicity is not guaranteed on NFS.

### Exports

| Export | Kind | Description |
|---|---|---|
| `withFileLock` | function | Run a critical section under an exclusive cross-process lock |
| `acquireFileLock` | function | Acquire the lock, returning a `Disposable` handle |
| `FileLock` | type | The handle: `{ path, release() }`, also a `Disposable` |
| `FileLockOptions` | type | `timeout`, `staleTimeout`, `retryDelay`, `maxRetryDelay`, `signal` |
| `LockRecord` | type | The on-disk record: `pid`, `hostname`, `bootAt`, `startedAt` |
| `LockEntry` | type | A record with the inode and mtime it was read from |

### Usage

```ts
import { withFileLock } from '@sozai/lock'

await withFileLock(lockPath, async () => {
  // Exactly one process runs this at a time.
})
```

Acquisition is blocking with jittered backoff, and **throws** `TimeoutInterruption` when `timeout`
(default 10s) expires — it never falls through and runs the section unlocked. A holder that is
provably alive (same host, same boot, live pid) is never reaped, however long it holds; the
`staleTimeout` TTL (default 60s) applies only where liveness is unprovable.
```

- [ ] **Step 3: Register the package in the skills**

In `docs/skills/runtime.skill.md`, under `## Packages in This Domain`, add:

```markdown
**Cross-process file mutex (Node-only)**: `@sozai/lock`
```

In `docs/skills/discover.skill.md`:
- Change `14 packages` to `15 packages` in the intro paragraph.
- Change the intro's `environment-agnostic packages` to `environment-agnostic packages (with one Node-only exception, `@sozai/lock`)`.
- In the `### Runtime` domain paragraph, append: `Plus a Node-only cross-process file mutex.`
- In `## Package Overview`, add: `- **@sozai/lock** — Cross-process file mutex; Node-only.`

- [ ] **Step 4: Register the package in the architecture doc**

In `docs/agents/architecture.md`, extend the `## Packages` paragraph's package list with `lock`, and add a sentence:

```markdown
`lock` is Node-only (`node:fs`) — the one package here that is not environment-agnostic; it exists
because kokuin's keystores need a cross-process mutex and may only depend downward.
```

- [ ] **Step 5: Write the changeset**

`.changeset/lock-package.md`:

```markdown
---
"@sozai/lock": minor
---

First release of `@sozai/lock`: a blocking cross-process file mutex for Node.js.

`withFileLock(lockPath, fn)` runs a critical section under an exclusive lock, and
`acquireFileLock(lockPath)` returns a `Disposable` handle for callers whose critical section is not
a single function. Acquisition blocks with jittered backoff and **throws** `TimeoutInterruption`
when it cannot be taken within `timeout` (default 10s) — it never falls through and runs the
section unlocked.

The lock is claimed by `link()`-ing a fully-written temp file into place, so no racer can ever read
a half-written lockfile and conclude nobody holds it. Reap and release are inode-guarded: no
process can unlink a lockfile other than the one it classified.

Stale-lock recovery proves liveness rather than assuming it. A holder on this host, from this boot,
whose pid still answers `kill(pid, 0)` is never reaped — no matter how long it holds the lock,
because a critical section can legitimately block the event loop for minutes (a synchronous keyring
call, an OS keychain prompt). The `staleTimeout` TTL (default 60s) applies only where the pid means
nothing: a foreign host, a different boot, or a corrupt record.

Node-only, and `lockPath` must be on a local filesystem — `link()` atomicity is not guaranteed on
NFS.
```

- [ ] **Step 6: Verify the whole repo**

Run, from the repo root:
```bash
pnpm exec turbo run test:types test:unit && pnpm exec biome check ./packages && pnpm exec tsc --noEmit --skipLibCheck -p packages/lock/tsconfig.json
```
Expected: every package's tests pass (including the new `@sozai/lock` suite), Biome is clean, and the package's build config typechecks.

- [ ] **Step 7: Verify the package builds and publishes the right files**

Run: `cd packages/lock && pnpm exec swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths && pnpm exec tsc --emitDeclarationOnly --skipLibCheck && ls lib`
Expected: `lib/` contains `index.js` + `index.d.ts` and one `.js`/`.d.ts` pair per source module.
Then: `rm -rf lib` — `lib/` is generated and must not be committed.

- [ ] **Step 8: Commit**

```bash
git add packages/lock/README.md .changeset/lock-package.md docs
git commit -m "docs(lock): README, reference, skills, architecture, changeset"
```

---

## Task 8: Close out the plan

**Files:**
- Modify: `docs/agents/plans/roadmap.md`
- Create: `docs/agents/plans/completed/2026-07-13-lock-package.complete.md`
- Delete: `docs/agents/plans/next/lock-package.md`, `docs/superpowers/plans/2026-07-13-lock-package.md`

Follow the repo's plan lifecycle, exactly as `2026-07-13-log-setup-guard` did it: the `next/` doc and this plan are replaced by one `completed/` document.

- [ ] **Step 1: Write the completion doc**

`docs/agents/plans/completed/2026-07-13-lock-package.complete.md` — mirror the structure of
`docs/agents/plans/completed/2026-07-13-log-setup-guard.complete.md`: Status / Package / Source
header, `## Goal`, `## What was built` (the final public surface, as a code block), `## Design
decisions` (pid-probe liveness over heartbeat, `bootAt` against reboot pid reuse, inode-guarded
reap and release, in-process queue, timeout throws), `## Rejected` (heartbeat refresh; TTL-only
staleness; `maxHoldTime`; a general `Mutex` interface), and `## Follow-ups` (rebase
`@tejika/process` onto this primitive; kokuin consumes it in `NodeKeyStore.open(service, { lockPath })`
and `@kokuin/electron`, dropping its in-process `#provideLock` chain).

- [ ] **Step 2: Update the roadmap**

In `docs/agents/plans/roadmap.md`, replace the `## New packages (not audit-derived)` bullet with a
done marker pointing at the completion doc:

```markdown
- ✅ **Done** — [lock — cross-process file mutex](completed/2026-07-13-lock-package.complete.md).
  New Node-only `@sozai/lock`, requested by kokuin. Follow-up: rebase `@tejika/process` onto it.
```

- [ ] **Step 3: Remove the superseded plan docs**

```bash
git rm docs/agents/plans/next/lock-package.md docs/superpowers/plans/2026-07-13-lock-package.md
```

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(lock): complete plan for the cross-process file mutex"
```

---

## Verification checklist

Before opening the PR, all of these must be true:

- [ ] `pnpm exec turbo run test:types test:unit` passes across all 15 packages.
- [ ] The cross-process test passes, **and** was seen to fail when the lock was stubbed out (Task 6 Step 5).
- [ ] `pnpm exec biome check ./packages` is clean.
- [ ] `packages/lock/lib/` is not committed.
- [ ] `packages/lock/package.json` has exactly one dependency: `@sozai/async`.
- [ ] `grep -rn "process.kill" packages/lock/src` shows the probe in `liveness.ts` and nowhere else, reachable only through a record validated with `pid > 0`.
- [ ] `.changeset/lock-package.md` exists and names `@sozai/lock` at `minor`.
