# lifecycle pass — cancel timers / remove listeners on settle

**Status:** open · freeze-blocker · priority 4
**Source:** [audit 2026-07-02 — execution / async / generator / flow](../completed/2026-07-02-repo-audit.complete.md#execution)
**Scope:** execution, async, generator, flow, **event** (audit's suggested-order step 4 names
`event` in the same sweep though it has no dedicated findings section).

One recurring pattern across the async-primitive packages: timers and abort listeners armed
during work are never released on *normal* settlement — only on abort. Result: leaked
timers keep the process alive and can flip completed work to timed-out/aborted; leaked
listeners keep completed objects reachable from long-lived shared signals (e.g. app
shutdown). Fix the shared pattern (run cleanup when the deferred settles; remove listeners
on resolve) across all four packages, plus the package-specific contract bugs below.

## execution

- **`src/execution.ts:72-78` — timeout timers leak on completion** (runtime-verified).
  `#cleanup` only runs from `abort()`; on normal resolution timers stay armed, keep the
  process alive, then fire and flip a completed execution to `isTimedOut`/`isAborted`. Same
  on the pre-aborted early return (91-97). Fix: run cleanup when the deferred settles.
- **`src/execution.ts:207-229` — a throwing `NextFn` rejects the Execution** instead of
  resolving to an error `Result` (verified), breaking the "always resolves to `Result`"
  contract that `value`/`ifError`/iteration rely on. Fix: wrap the `nextContext`/`toContext`
  path with the same `Result.toError` catch used for `ctx.execute`.
- `src/execution.ts:130-133` — `[Symbol.asyncDispose]` on a never-awaited Execution *starts*
  it (forces the lazy promise, arms the leaking timeouts). Track whether the lazy was forced
  and short-circuit.
- `src/execution.ts:194-198` — `abort()` after successful completion still aborts the
  controller and whole previous chain, so `isAborted`/`isCanceled`/`isDisposed` report true
  for executions that already succeeded. Consider a no-op once settled.
- `src/execution.ts:108-118` — per-execution abort listener on a possibly long-lived
  composite signal never removed after normal resolution.
- Minor: `generate<V, E>()` (249-251) re-declares and force-casts class generics; inherited
  `map`/`mapError` are eager and lose `abort`/`signal` while `next()` is lazy — document or
  override the split.

## async

- **`src/disposer.ts:51` — already-aborted external signal never disposes; `disposed` hangs
  forever** (verified — abort events don't replay for listeners added after the fact). Fix:
  check `params.signal?.aborted` first and dispose synchronously. Existing test only aborts
  after construction.
- `src/defer.ts:6-17` — `Deferred<T, R>`'s `reject: (reason?: R) => void` is false type
  safety: native reject accepts anything, so `defer<X, never>()` claims it never rejects but
  is still callable with any reason.

## generator

- **`src/index.ts:119-127` — `fromEmitter`: concurrent `next()` calls drop the first waiter,
  which hangs forever** (verified — `pending` deferred is overwritten). Fix: FIFO array of
  pending deferreds.
- `src/index.ts:42,106` — abort listeners never removed after normal completion in `consume`
  and `fromEmitter`; every completed consumer leaks a closure on a shared signal.
- Minor: `ended.reject(signal?.reason)` rejects with `undefined` when the signal has no
  reason — wrap in `AbortInterruption` (already a dep). `AsyncGenerator<T>` (140) leaves
  `TReturn`/`TNext` implicit `any`; spell `AsyncGenerator<T, void, void>`.

## flow

- **`src/flow.ts:96` — `getState()` freezes the live state object**, not a copy (verified);
  after one call, in-place mutation anywhere — including inside handlers — throws
  `TypeError`. Fix: freeze a clone, or rely on the `Readonly<State>` type only.
- **`src/flow.ts:131` — `defaultAction` re-applied on every `next()` with no pending
  action**, so `for await` over a flow whose handler returns `{status:'state'}` loops
  forever (verified). Consume it once if it means "initial action"; else document loudly.
- `next()` has no serialization: two concurrent calls run handlers concurrently against
  shared state, last write wins. Same class as generator's `fromEmitter`.
- `src/types.ts:4` — `{ status: 'aborted'; reason: string }` but the impl assigns
  `flowSignal.reason` (an `Error` or `undefined`). Type as `unknown`.
- `src/types.ts:48` — `any` with biome-ignore.

## event

No dedicated audit section, but named in the lifecycle sweep — apply the same settle-cleanup
pattern: cancel timers and remove abort listeners on normal completion. Audit while fixing;
add findings here if the same leak class is present.

## Test-coverage gaps

Timer cancellation on success; throwing `NextFn`; dispose-before-start; Disposer with an
already-aborted signal; concurrent `next()` (generator + flow); listener removal.
