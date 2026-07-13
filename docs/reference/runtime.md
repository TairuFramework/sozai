# Runtime

Platform-agnostic runtime primitives (`fetch`, random ID, random bytes), their Expo binding, and a
Node-only cross-process file mutex.

## Packages

| Package | Purpose |
|---|---|
| `@sozai/runtime` | Platform-agnostic `Runtime` abstraction and `createRuntime` factory |
| `@sozai/runtime-expo` | Expo / React Native binding; independently versioned per `runtime-<env>` pattern |
| `@sozai/lock` | Cross-process file mutex; Node-only (`node:fs`) |

---

## @sozai/runtime

### Exports

| Export | Kind | Description |
|---|---|---|
| `Fetch` | type | Type alias for `globalThis.fetch` |
| `GetRandomID` | type | `() => string` — synchronous UUID generator |
| `GetRandomValues` | type | `<T extends ArrayBufferView>(array: T) => T` — fills array with random bytes |
| `Runtime` | type | Object with `fetch`, `getRandomID`, `getRandomValues` fields |
| `createRuntime` | function | Returns a `Runtime` with globalThis defaults; accepts partial overrides |

### Runtime shape

```typescript
type Runtime = {
  fetch: Fetch
  getRandomID: GetRandomID
  getRandomValues: GetRandomValues
}
```

Default implementations delegate to `globalThis` at call time (not bind time), so test spies and mocks on `globalThis.fetch`, `globalThis.crypto.*` remain effective.

### Example

```typescript
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

// Create with globalThis defaults
const runtime: Runtime = createRuntime()

// Generate a random UUID
const id = runtime.getRandomID()

// Fill a buffer with cryptographically random bytes
const nonce = runtime.getRandomValues(new Uint8Array(16))

// Fetch a resource using the environment's fetch
const response = await runtime.fetch('https://example.com/api/data')
const data = await response.json()

// Override a single method (e.g. in tests)
const testRuntime = createRuntime({
  getRandomID: () => 'fixed-id-for-tests',
})
```

---

## @sozai/runtime-expo

Provides a pre-built `Runtime` backed by `expo/fetch` and `expo-crypto`, and polyfill helpers to patch `globalThis` for older Expo environments.

> **Independent versioning.** `@sozai/runtime-expo` tracks the Expo SDK. It may increment a major version independently of the frozen `@sozai/runtime` core, following the `runtime-<env>` pattern.

### Exports

| Export | Kind | Description |
|---|---|---|
| `expoRuntime` | const | Pre-built `Runtime` using Expo's `fetch` and `expo-crypto` |
| `createRuntime` | function | Returns a `Runtime` with Expo defaults; accepts partial overrides |
| `polyfillCrypto` | function | Patches `globalThis.crypto` with `expo-crypto` implementations |
| `polyfillFetch` | function | Patches `globalThis.fetch` with Expo's `fetch` |
| `polyfill` | function | Calls both `polyfillCrypto` and `polyfillFetch` |

All three polyfill functions accept an optional `override: boolean` (default `false`). When `false`, existing globals are left untouched; pass `true` to force-replace them.

### Example — polyfill at app entry

```typescript
// app/_layout.tsx (or your root entry point)
import { polyfill } from '@sozai/runtime-expo'

// Patch globalThis once, before any other imports that rely on fetch/crypto
polyfill()
```

### Example — explicit Expo-backed Runtime

```typescript
import type { Runtime } from '@sozai/runtime'
import { createRuntime, expoRuntime } from '@sozai/runtime-expo'

// Use the pre-built singleton directly
const runtime: Runtime = expoRuntime

// Or create one with a custom fetch override
const customRuntime: Runtime = createRuntime({
  fetch: (input, init) =>
    expoRuntime.fetch(input, { ...init, headers: { 'X-App': '1' } }),
})

const id = customRuntime.getRandomID()
const bytes = customRuntime.getRandomValues(new Uint8Array(32))
```

---

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
| `LockRecord` | type | The on-disk record: `pid`, `hostname`, `bootAt`, `startedAt`, `uptimeAt` |
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
attempt, no waiting, no backoff, no queueing behind a same-process caller — live contention throws
`TimeoutInterruption` synchronously.

Acquiring the lock creates `lockPath`'s parent directory tree if missing
(`mkdirSync(..., { recursive: true, mode: 0o700 })`).

A holder that is provably alive (same host, same boot, live pid) is never reaped, however long it
holds; the `staleTimeout` TTL (default 60s) applies only where liveness is unprovable. How the age
is measured then depends on the holder's host: a same-host holder is aged monotonically from
`uptimeAt` (`os.uptime()`), so a forward wall-clock step cannot reap it — a *negative* age means the
host rebooted since the record was written, so it is stale at once. A foreign-host holder (or a
record too corrupt to identify one) is still aged by wall clock against `startedAt`, or the file's
mtime — unavoidable, since another host's uptime can't be read, and the reason cross-host locking
is unsupported. A clock step can still expire a foreign-host record early.

Reaping a stale lock is inode-guarded, not provably atomic: the guard is `statSync` then `rmSync`,
two syscalls, so a residual window remains where two waiters classifying the same stale lock in
lockstep can have one unlink the other's freshly-claimed live lock. POSIX has no unlink-if-inode, so
this can't be closed with name operations; a jitter before reaping (uniform in `[0, retryDelay)`,
skipped by a try-lock) desynchronizes waiters released together so this doesn't happen in practice —
a mitigation, not a proof, and the one place this package's exclusion is probabilistic.

The exit-cleanup hook releases held locks on `process.exit()` and a natural event-loop drain only —
a default-handled `SIGINT`/`SIGTERM` terminates Node without emitting `'exit'`, so it does not run
there. Benign: the process is gone, so the next waiter's liveness probe reports it dead and reaps
immediately, no TTL wait.

Acquisition can reject with a real filesystem error (`EACCES`, `EISDIR`, ...) instead of timing out,
when `lockPath` is misconfigured (a directory at the path, an unreadable file). A caller should not
assume every rejection is `TimeoutInterruption`.

`retryDelay` is a backoff ceiling, not the realized first delay: the first wait is uniform in
`[retryDelay / 2, retryDelay)` (`[5, 10)` at the default).

---

## When to Use

**Use `@sozai/runtime`** when:
- Writing code that must run in any JavaScript environment (Node.js, browsers, workers)
- Accepting a `Runtime` parameter to keep a module environment-agnostic
- Injecting a controlled runtime in tests (pass overrides to `createRuntime`)

**Use `@sozai/runtime-expo`** only in Expo / React Native apps:
- Call `polyfill()` once at app startup to shim missing globals
- Pass `expoRuntime` or `createRuntime()` where a `Runtime` is expected
- Pin the package to your Expo SDK version — it may major independently

**Use `@sozai/lock`** when two processes may touch the same resource and the store underneath has
no compare-and-swap — e.g. a keystore whose write API is an unconditional upsert.

---

## See Also

- `sozai:validation` — schema and codec utilities that work alongside a `Runtime`
- `sozai:dataflow` — stream and event processing that may depend on a `Runtime` for I/O
- `sozai:observability` — structured logging and metrics, environment-agnostic
- `sozai:primitives` — base utilities used across the sozai layer
