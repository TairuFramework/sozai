# @sozai/lock

Sibling reference: `reference/lock-semantics.md` — the boot-ID safety property, and three failure
modes: the unsafe fallback path, TTL-bounded reboot recovery, and same-boot pid recycling.

> **Filesystem-based.** The only package in sozai that is not environment-agnostic. `lockPath` must
> be on a local filesystem — `link()` atomicity is not guaranteed on NFS.

> Read `reference/lock-semantics.md` before depending on this lock. The fallback path is not
> safe, the TTL does not protect a long-held lock there, and reboot recovery is TTL-bounded
> rather than instant.

### Exports

| Export | Kind | Description |
|---|---|---|
| `withFileLock` | function | Run a critical section under an exclusive cross-process lock |
| `acquireFileLock` | function | Acquire the lock, returning a `Disposable` handle |
| `FileLock` | type | The handle: `{ path, release() }`, also a `Disposable` |
| `FileLockOptions` | type | `timeout`, `staleTimeout`, `retryDelay`, `maxRetryDelay`, `signal` |
| `LockRecord` | type | The on-disk record: `pid`, `hostname`, `nonce`, `bootID`, `bootAt`, `startedAt`, `uptimeAt` |
| `TimeoutInterruption` | class | Re-exported from `@sozai/async`; what acquisition throws on timeout |

`LockEntry` (a `LockRecord` plus the inode and mtime it was read from) is internal — not exported.

### Usage

```ts
import { withFileLock } from '@sozai/lock'

await withFileLock(lockPath, async () => {
  // Exactly one process runs this at a time.
})
```

Acquisition is blocking with jittered backoff, and **throws** `TimeoutInterruption` when `timeout`
(default 10s) expires — it never falls through and runs the section unlocked. `timeout` bounds
acquisition only, however: once the lock is held, the critical section runs to completion
regardless of `timeout`, so a caller that needs to bound the section itself must do so.
`TimeoutInterruption` is re-exported from `@sozai/lock` itself, so a caller can catch it without
depending on `@sozai/async` directly. `timeout: 0` is a deterministic try-lock instead: one
attempt, no waiting, no backoff, no queueing behind a same-process caller — live contention rejects
with `TimeoutInterruption` in the same tick, before any timer can fire. (`acquireFileLock` is
`async`, so it rejects after microtasks rather than throwing synchronously; the guarantee is that it
never sleeps and never waits on a timer.)

Acquiring the lock creates `lockPath`'s parent directory tree if missing
(`mkdirSync(..., { recursive: true, mode: 0o700 })`).

A holder that is provably alive (same host, same boot, live pid) is never reaped, however long it
holds; the `staleTimeout` TTL (default 60s) applies only where liveness is unprovable.
