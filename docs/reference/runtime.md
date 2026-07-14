# Runtime

Platform-agnostic runtime primitives (`fetch`, random ID, random bytes), their Expo binding, and a
filesystem-based cross-process mutex.

## Packages

| Package | Purpose |
|---|---|
| `@sozai/runtime` | Platform-agnostic `Runtime` abstraction and `createRuntime` factory |
| `@sozai/runtime-expo` | Expo / React Native binding; independently versioned per `runtime-<env>` pattern |
| `@sozai/lock` | Filesystem-based cross-process mutex (`node:fs`) |

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

> **Filesystem-based.** The only package in sozai that is not environment-agnostic. `lockPath` must
> be on a local filesystem — `link()` atomicity is not guaranteed on NFS.

### Exports

| Export | Kind | Description |
|---|---|---|
| `withFileLock` | function | Run a critical section under an exclusive cross-process lock |
| `acquireFileLock` | function | Acquire the lock, returning a `Disposable` handle |
| `FileLock` | type | The handle: `{ path, release() }`, also a `Disposable` |
| `FileLockOptions` | type | `timeout`, `staleTimeout`, `retryDelay`, `maxRetryDelay`, `signal` |
| `LockRecord` | type | The on-disk record: `pid`, `hostname`, `bootID`, `bootAt`, `startedAt`, `uptimeAt` |
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

**"Same boot" is decided by an OS boot ID, not by the clock**, and that is the load-bearing safety
property: `bootID` is `/proc/sys/kernel/random/boot_id` on linux and `sysctl -n
kern.bootsessionuuid` on darwin (read and cached per process — never throws; a *failed* read is
retried before anybody is answered, and a source that fails an acquisition's whole budget is read
again on the next acquisition, so one unlucky claim cannot downgrade the process for life; an
unsupported platform settles on `null` at once). When both this process and the record have one, they
are compared exactly. So on linux and darwin, **where the boot ID is readable**, **a forward
wall-clock step cannot reap a live holder**: the step cannot suppress the liveness proof (the boot ID
does not move with the clock, so the pid is still probed and still answers), and it cannot inflate the
age either (a same-host holder is aged monotonically from `uptimeAt`). The qualifier is load-bearing —
the read *can* fail on both platforms, and a process it failed for gets none of this.

The **hostname** is checked *after* the boot ID, and only where it is load-bearing — it is a machine
identity, not a boot identity, and a mutable one (macOS renames the host from DHCP when a laptop
joins a network, which is the very sleep/wake event this package is written for). On **darwin** a
matching boot ID proves the same machine *and* the same pid namespace, so it authorizes the pid probe
whatever the host is called now. On **linux** it does not: containers on one host *share*
`/proc/sys/kernel/random/boot_id` but have *separate* pid namespaces, so a boot-ID match can be two
different containers and the recorded pid would probe a stranger — the hostname check stays on that
path, and must not be "simplified" into the darwin one. It discriminates because containers get
distinct hostnames *by default*, which is a default and not a guarantee (`--hostname`, `--uts=host`,
`--net=host`), so sharing a `lockPath` **between containers is unsupported**, exactly as sharing one
between hosts is.

**The fallback path is not safe, and the TTL does not protect a long-held lock there.** Where no boot
ID is readable — any other platform, or a record written by a process whose read *failed*, which is
possible on linux (`EMFILE`) and on darwin (the boot ID comes from an **exec**: a macOS App Sandbox or
hardened runtime that denies the `sysctl` spawn puts that process here permanently) — the check falls
back to comparing wall-clock-derived boot *times* (`bootAt`) within a 30s tolerance, and the hostname
becomes the only machine identity there is. **Two** events then reap a live holder, as soon as its
true monotonic age passes `staleTimeout`:

- a **forward clock step** larger than the tolerance — the minutes-long macOS-keychain-prompt hold
  this package exists for is exactly such a holder, and sleep/wake supplies the step;
- a **hostname change, with no clock event at all**. A DHCP rename alone, on a perfectly steady
  clock, costs a live darwin holder its lock at the TTL — and a laptop on DHCP, whose `sysctl` spawn
  a sandbox denied, is precisely the process that ends up here.

What `uptimeAt` buys on that path is narrower: it removes the *inflated* age, so a holder *younger*
than the TTL is no longer reaped by the clock step alone. A consumer that may not have a readable boot
ID must know that its long-held lock is not TTL-protected. `bootAt` remains on the record for exactly
this fallback, and the guarantee above is a linux/darwin *readable-boot-ID* one, not a universal one.

A *negative* monotonic age (this host has been up for less time than the record claims to have been
held) signals a reboot, and is corroborated by the wall clock before anything is reaped — either a
claim older than the TTL (`now - startedAt > staleTimeout`) or a claim dated in the *future*
(`now < startedAt`). Corroboration is required because `os.uptime()` is not portably monotonic
(darwin adjusts `kern.boottime` on clock and sleep events, so it can run backwards under a live
holder); the future-dated case is required because a host whose clock runs *backwards* past the
record — a bad RTC, a container booted to 1970 before NTP lands — makes `now - startedAt`
permanently negative, so without it a dead post-reboot holder would never be reaped and the lock
would wedge forever.

**Reboot recovery is TTL-bounded in every case, never instant.** A reboot always changes the boot
ID, so a recycled pid is never mistaken for a live holder — but two cases wait the TTL out in full:
a holder that claimed the lock seconds into a boot (its `uptimeAt` sits *below* the new boot's
uptime, so its age is small and positive, with no reboot signal at all), and a *fast* reboot — a
container restart, a kexec, seconds of downtime — where hold + downtime + the new uptime is still
under the TTL, so the negative age cannot be corroborated yet. Reap latency, bounded by the TTL,
never an exclusion hole and never a wedge.

A foreign-host holder (or a record too corrupt to identify one) is still aged by wall clock against
`startedAt`, or the file's mtime — unavoidable, since another host's uptime can't be read, and the
reason cross-host locking is unsupported. A clock step can still expire a foreign-host record early;
and in the other direction, a *future-dated* foreign record is respected until our own clock catches
up to its `startedAt`, so the wait is bounded by the peer's skew, not by the TTL. (Deliberate: two
hosts' clocks legitimately disagree, and a foreign record carries no reboot signal to corroborate
reaping it early — only the claim itself, which is what a live remote holder writes.)

**A pid recycled within the same boot still wedges the lock.** A `SIGKILL`ed holder whose lockfile
outlives the pid space wrapping around to that number probes as `'alive'`, is therefore never stale,
and is unrecoverable without a reboot or a manual `rm`. The boot ID removes the *cross-reboot*
recycle — the common case, where a persistent `lockPath` survives a reboot — and not this one. This
is an availability failure, not an exclusion failure: it fails in the safe direction and never lets
two processes into the critical section. It is the deliberate price of rejecting a `maxHoldTime`
outer bound, which would re-open the reap-a-live-holder hole the rest of the design exists to close.

Reaping a stale lock is guarded, not provably atomic: the reaper unlinks the lockfile only while it
still carries the record it classified stale — identified by a per-claim **nonce**, never by the
inode, because an inode number is recycled the moment the file is unlinked (routinely on linux) and
so names a slot, not a file. Reading and unlinking are still two syscalls, so a residual window
remains where two waiters classifying the same stale lock in lockstep can have one unlink the
other's freshly-claimed live lock. POSIX has no unlink-if-identity, so this can't be closed with name
operations; a jitter before reaping (uniform in `[0, retryDelay)`, skipped by a try-lock)
desynchronizes waiters released together so this doesn't happen in practice — a mitigation, not a
proof, and the one place this package's exclusion is probabilistic.

The exit-cleanup hook releases held locks on `process.exit()` and a natural event-loop drain only —
a default-handled `SIGINT`/`SIGTERM` terminates Node without emitting `'exit'`, so it does not run
there. Benign: the process is gone, so the next waiter's liveness probe reports it dead and reaps
immediately, no TTL wait.

Acquisition can reject with a real filesystem error (`EACCES`, `EISDIR`, ...) instead of timing out,
when `lockPath` is unusable: a directory sitting at the path, or a lockfile unreadable to us — a
`0600` lockfile owned by another user, on a shared path, throws `EACCES` on the first read rather
than being waited out. A caller should not assume every rejection is `TimeoutInterruption`.

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
