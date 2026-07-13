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

`lockPath`'s parent directory is created if it does not exist (`mkdirSync(..., { recursive: true,
mode: 0o700 })`) — no need to pre-create the directory the lockfile lives in.

### Try-lock

`timeout: 0` is a deterministic try-lock: one attempt, no waiting. It may still reap a stale holder
and re-claim immediately (reaping is not waiting), but it never backs off and never queues behind a
same-process caller — any live contention rejects with `TimeoutInterruption` in the same tick,
before any timer can fire. (`acquireFileLock` is `async`: it *rejects*, after microtasks and after
the synchronous filesystem calls a claim or a reap makes. It never sleeps and never waits on a
timer.)

```ts
import { acquireFileLock, TimeoutInterruption } from '@sozai/lock'

try {
  using lock = await acquireFileLock(lockPath, { timeout: 0 })
  // got it immediately
} catch (err) {
  if (err instanceof TimeoutInterruption) {
    // someone else holds it right now
  }
}
```

## Constraints

- `lockPath` must be on a **local filesystem**. `link()` atomicity is not guaranteed on NFS.
- Acquisition is bounded by `timeout` (default 10s) and **throws** when it expires — the critical
  section never runs unlocked.
- `timeout` bounds acquisition only: once the lock is held, `fn` runs to completion however long it
  takes. A caller that needs to bound the critical section itself must do so.
- Not reentrant: acquiring the same path twice in one process, without releasing, deadlocks until
  the timeout fires.
- `retryDelay` is a backoff **ceiling**, not the realized first delay: the backoff is halved and
  jittered, so the first wait is uniform in `[retryDelay / 2, retryDelay)` at the default (`[5,
  10)`).
- Acquisition can reject with a real filesystem error (e.g. `EACCES`, `EISDIR`) instead of timing
  out and misreporting it as a held lock. That covers a misconfigured `lockPath` — a directory
  sitting at the path — but also an *unreadable* one: a `0600` lockfile owned by another user, on a
  path two users share, is no longer waited out; the first read throws `EACCES`. Correct for a
  per-user keystore, which is what this guards, but a shared-path caller must expect it. A caller's
  `catch` should not assume every rejection is `TimeoutInterruption`.
- **A wall-clock step cannot reap a live holder on linux or darwin, *where the boot ID is
  readable*.** A holder is proven alive by its pid, and the pid is only probed when the record comes
  from the boot we are running in — which is decided by an OS boot ID
  (`/proc/sys/kernel/random/boot_id` on linux, `sysctl -n kern.bootsessionuuid` on darwin). Neither
  moves when the clock does. The holder's age is measured monotonically from `os.uptime()`, so a step
  cannot inflate it either. The qualifier is not decoration: that read can *fail* on linux and darwin
  too (see the fallback below), and a process it failed for gets none of this.
- On **darwin** a matching boot ID authorizes the pid probe *regardless of the hostname*: it proves
  the same machine and the same pid namespace, so a host renamed mid-hold (macOS renames from DHCP
  when a laptop joins a network) does not cost a live holder its lock. On **linux** the hostname
  check stays: containers on one host *share* `/proc/sys/kernel/random/boot_id` but have separate
  pid namespaces, so a boot-ID match there can be two different containers and the recorded pid
  would probe a stranger's process.
- **Do not share a `lockPath` between containers**, for the same reason you must not share one
  between hosts. The hostname is all that tells two containers apart above, and that is a *default*,
  not a guarantee: `--hostname`, `--uts=host` or `--net=host` gives two containers the same hostname,
  the same `boot_id` and separate pid namespaces at once, and the recorded pid is then probed across
  namespaces — a live holder in one container can read as dead in the other and be reaped, and a dead
  holder's pid 1 can match the other's init and wedge the lock. Nothing in this package detects that.
- **Where no boot ID is readable the fallback is not safe, and the TTL does not protect a long-held
  lock.** `bootID` is `null` on any other platform — and equally for a record written by a process
  whose read *failed*, which can happen on linux (an `EMFILE` under fd pressure) and on darwin (the
  boot ID comes from an **exec**, so a macOS App Sandbox or hardened runtime that denies the `sysctl`
  spawn puts that process on this path *permanently*). The same-boot check then falls back to
  comparing wall-clock-derived boot *times* within a 30s tolerance, and the hostname becomes the only
  machine identity there is — so **two** different events reap a live holder there, once its true
  monotonic age passes `staleTimeout`:
  - a **forward clock step** larger than the tolerance (NTP, VM resume, laptop wake) — which is
    precisely the case this package exists for: a macOS keychain prompt can hold the critical section
    for minutes, and sleep/wake supplies the step;
  - a **hostname change**, *with no clock event at all*. A DHCP rename alone, on a perfectly steady
    clock, costs a live holder its lock at the TTL. And the population most exposed to it — macOS,
    laptop, DHCP-renamed — is exactly the one a denied `sysctl` spawn leaves here.

  What the monotonic age buys on this path is narrower: it removes the *inflated* age, so a holder
  *younger* than the TTL is no longer reaped by the clock step alone. A consumer shipping where the
  boot ID may not be readable must know this: the guarantee above is a linux/darwin *readable-boot-ID*
  guarantee, not a universal one.
- A holder on **another host** is still aged by wall clock — there is no way to read another host's
  uptime — so a clock step there (or here, while comparing to it) can still expire its record
  early. A *future-dated* foreign record has the mirror-image effect: it is respected until our own
  clock catches up to its `startedAt`, so the wait is bounded by the peer's skew rather than by the
  TTL. (Deliberate: two hosts' clocks legitimately disagree, and there is no reboot signal on a
  foreign record to corroborate the alternative.) Cross-host locking is unsupported for this reason
  among others.
- **A pid recycled within the same boot still wedges the lock.** A `SIGKILL`ed holder whose lockfile
  outlives the pid space wrapping around to that number again probes as `'alive'`, is never stale,
  and is not recoverable without a reboot or a manual `rm`. The boot ID removes the *cross-reboot*
  recycle, not this one. It is an availability failure, not an exclusion failure — it fails in the
  safe direction, never letting two processes into the critical section — and it is the deliberate
  price of refusing a `maxHoldTime` outer bound, which would re-open the reap-a-live-holder hole
  the rest of the design closes.
- **Reboot recovery is bounded by the TTL in every case, never instant.** A reboot changes the boot
  ID, so a recycled pid is correctly treated as meaningless and the record is never mistaken for a
  live holder — but *how fast* the record is then reaped is the TTL's business, and two cases wait
  it out in full: a holder that claimed the lock a few seconds into a boot (its recorded uptime sits
  *below* the new boot's, so its monotonic age is small and positive), and a fast reboot — a
  container restart or a kexec, seconds of downtime — where hold + downtime + the new uptime is
  still under `staleTimeout`. Reap latency, bounded, never an exclusion hole and never a wedge.
- Reaping a stale lock is inode-guarded but not provably atomic: `statSync` then `rmSync` is two
  syscalls, and two waiters that classify the same stale lock in the same instant can — in a rare,
  crash-only interleaving — have one waiter unlink the other's freshly-claimed live lock. A jitter
  before reaping desynchronizes waiters released together and makes this vanishingly unlikely, but
  POSIX has no unlink-if-inode primitive, so it is not eliminated. This is the one place this
  package's exclusion is probabilistic rather than absolute.
- The process-exit cleanup hook only runs on `process.exit()` or a natural event-loop drain — a
  default-handled `SIGINT`/`SIGTERM` terminates Node without emitting `'exit'`, so a lock held
  across one of those is not released by this hook. This is benign: the process is gone, so the
  next waiter's liveness probe reports it dead and reaps the lockfile immediately, with no TTL wait.
