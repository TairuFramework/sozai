# Repo audit — 2026-07-02

**Status:** complete (investigation) · **Date:** 2026-07-02

> Immutable point-in-time record. Actionable findings were extracted on 2026-07-03 into the
> live plans — see [roadmap](../roadmap.md), [next/](../next/), [backlog/](../backlog/). Work
> tracking happens there; this doc is the origin snapshot and verification provenance, kept
> unchanged. The conventions clean-bill and test-coverage summary below live only here.

Full-repo audit: package sources, tests, tooling, docs. Findings verified where noted
(runtime-verified against built `lib/`, or with the repo's `tsc`). Ordered by severity
within each section.

**TLDR:** infrastructure is solid and conventions are clean, but several packages have
correctness bugs that should be fixed before the APIs freeze: `patch` is not RFC 6902
compliant in load-bearing ways (including a prototype-pollution hole), `schema` can wipe
its shared Ajv instance, `execution`/`async`/`generator`/`event` leak timers and abort
listeners, and `runtime-expo`'s `polyfillFetch` cannot work. No LICENSE files despite MIT
manifests.

## Critical — fix before freeze

### patch

- **`src/apply.ts:134` — prototype pollution via patch paths.** Paths are not sanitized:
  a patch with path `/__proto__` (or `/constructor/prototype/x`) writes through to
  `Object.prototype`. Patches are the canonical remote-input format for the stack, so this
  is remotely reachable. Fix: reject `__proto__`/`constructor`/`prototype` segments in
  `parsePath` and use `Object.hasOwn` for existence checks. Note `@sozai/schema`'s
  `src/utils.ts` already blocks exactly these segments — the two packages currently
  disagree. Untested.
- **`src/apply.ts:127` — `add` on an existing array index replaces instead of inserting.**
  RFC 6902 §4.1: add at an array index "inserts before". Compounded in strict mode
  (`src/apply.ts:216`): `assertPathDoesNotExist` makes any mid-array add throw
  `PATH_EXISTS`. Array insertion is impossible in strict mode and silently wrong
  (overwrite) otherwise. Fix: `target.splice(index, 0, value)`; drop or rescope the
  not-exists assertion (spec `add` may replace existing members).
- **`src/apply.ts:255` — `test` op uses `Object.is`.** RFC 6902 §4.6 requires deep JSON
  equality; `test` against any object/array value never matches unless same reference.
  Existing tests only cover primitives. Fix: deep structural comparison.
- **`src/apply.ts:61` — array index parsing far too loose.** `Number()` coercion accepts
  `' '` (→ 0), `'01'` (→ 1, RFC 6901 forbids leading zeros), `'1e2'`, `'0x10'`, `'1.5'`
  (creates a non-index property). Fix: only treat `/^(0|[1-9]\d*)$/` as an index, and only
  when the parent is an array.
- **`src/apply.ts` — no `-` append token.** RFC 6902 §4.1: `add /arr/-` appends. Currently
  `-` stays a string key and `setPath` throws `INVALID_INDEX`. Untested.
- **`src/create.ts:48,90,102,137,143 — emitted paths never escaped.** Keys containing `/`
  or `~` produce pointers like `/a/b` instead of `/a~1b`; apply then targets the wrong
  location. `parsePath` unescapes correctly, so create→apply round-trip breaks exactly for
  these keys. Fix: `key.replace(/~/g, '~0').replace(/\//g, '~1')`.
- **`src/create.ts:66-84,112-126 — object↔array type change emits member-wise ops.**
  `[1,2,3]` → `{foo:'bar'}` emits removes that splice a shrinking array (wrong elements
  removed, then throws), and object → array yields a plain object with numeric keys.
  Existing unit tests enshrine the broken series; the round-trip integration test only
  covers primitive type changes. Fix: emit `replace` whenever
  `Array.isArray(from) !== Array.isArray(to)`.
- **`src/apply.ts:236-253 — `copy`/`move` insert live references.** The same object stays
  reachable from both locations; later patches or caller mutations alias both subtrees.
  Fix: `structuredClone` for `copy`. `move` is also missing the RFC check that `from` must
  not be a proper prefix of `path`.
- **`src/apply.ts:173 — `remove` at `index === length` silently no-ops** (bounds check
  shared with the append case). Similarly non-strict `replace /arr/<length>` appends.
  Fix: op-aware bounds (append allowed only for add/set).
- **`src/apply.ts:208 — `applyPatches` is not atomic.** RFC 6902 requires all-or-nothing;
  a mid-sequence throw leaves data partially mutated. Fix: apply to a clone and assign
  back, or document loudly.
- **`src/apply.ts:56 — root pointer `""` unsupported** (RFC 6901 empty pointer = whole
  document); currently throws `INVALID_PATH`.
- **API design: `createPatches(to, from)` argument order** is reversed from every
  mainstream diff API (`from, to`); swapped args produce plausible wrong patches with no
  error. Reorder before the package ossifies.
- Minor: `NaN` always diffs as changed and serializes to `null`; `undefined` `to` values
  leak into patch `value`s (not JSON-representable).

### schema

- **`src/validation.ts:49` — `removeSchema(schema.$id)` with no `$id` wipes the entire
  shared Ajv instance** (verified: `ajv.removeSchema(undefined)` clears all registered
  schemas, refs, and compile cache). Ajv instances are shared per `(draft, strict)` across
  all `createValidator` callers, so one `$id`-less schema silently breaks later `$ref`
  resolution and defeats caching globally. Fix: `if (schema.$id != null)` guard. Untested.
- **`src/validation.ts:44-56` — no validator memoization.** Every `createValidator` call
  recompiles (Ajv codegen) even for the same schema object. A `WeakMap<Schema, Validator>`
  keyed per options would fix the hot path; RPC validation sits on this.
- `src/errors.ts:16` — `instancePath.split('/')` without JSON Pointer unescaping: keys
  containing `/` or `~` yield wrong `path` arrays in standard-schema issues.
- `src/utils.ts:14` — blocklist rejects legitimate properties (`#/properties/toString`);
  `Object.hasOwn` fixes both the false positive and prototype-chain leakage. Line 10:
  segments not `~0`/`~1`- or percent-decoded, so `#/$defs/a~1b` can't resolve.
- `src/utils.ts:12` — convention violation: `let current: any` (biome-suppressed);
  `unknown` + narrowing works.

### runtime-expo

- **`src/index.ts:30` — `polyfillFetch` is a no-op or a crash.** `globalThis.fetch = fetch`
  with no `fetch` import: when global fetch exists this assigns it to itself; when absent
  (the case the polyfill targets) evaluating `fetch` throws `ReferenceError`. Presumably
  intended `import { fetch } from 'expo/fetch'` — `expo` is not in dependencies. The
  function can never do useful work.
- **`src/index.ts:5` — `expoRuntime.fetch` captured at import time.** `@sozai/runtime`
  deliberately delegates to `globalThis.fetch` at call time (documented and tested); the
  expo variant binds at module load, so later polyfills/mocks are ignored and a detached
  `fetch` can throw "Illegal invocation". Fix: `(...args) => globalThis.fetch(...args)`.
- **No runtime tests at all** (test script is types-only) — which is why the above
  shipped.

### execution

- **`src/execution.ts:72-78` — timeout timers leak on completion** (runtime-verified).
  `#cleanup` only runs from `abort()`; on normal resolution the timers stay armed, keep
  the process alive, then fire and flip a successfully completed execution to
  `isTimedOut === true` / `isAborted === true`. Same leak on the pre-aborted early return
  (lines 91-97). Fix: run cleanup when the deferred settles.
- **`src/execution.ts:207-229` — a throwing `NextFn` rejects the Execution** instead of
  resolving to an error `Result` (verified), breaking the "always resolves to `Result`"
  contract that `value`/`ifError`/iteration rely on. Fix: wrap the `nextContext`/`toContext`
  path with the same `Result.toError` catch used for `ctx.execute`.
- `src/execution.ts:130-133` — `[Symbol.asyncDispose]` on a never-awaited Execution
  *starts* it (forces the lazy promise, runs `execute`, arms the leaking timeouts).
  Track whether the lazy was forced and short-circuit.
- `src/execution.ts:194-198` — `abort()` after successful completion still aborts the
  controller and the whole previous chain, so `isAborted`/`isCanceled`/`isDisposed`
  report true for executions that already succeeded; combined with the timer leak there is
  no way to distinguish "timed out" from "completed then disposed". Consider a no-op once
  settled.
- `src/execution.ts:108-118` — per-execution abort listener on a possibly long-lived
  composite signal is never removed after normal resolution; completed executions stay
  reachable from the external signal.
- Minor: `generate<V, E>()` (lines 249-251) re-declares and force-casts the class
  generics; inherited `map`/`mapError` are eager and lose `abort`/`signal` while `next()`
  is lazy — surprising split, document or override.

### result

- **`src/result.ts:105` — `mapError` turns a thrown non-Error into a success Result**
  (verified: callback throwing `'oops'` yields `isOK() === true`). `Result.from` routes
  non-Errors to `ok`. An exception during error handling must not become success. Fix:
  `Result.toError`.
- **`src/result.ts:90` — `map` stores a thrown non-Error unwrapped as `E`**, violating
  `E extends Error` (verified). Same fix. Related asymmetry: `map` returning an `Error`
  value → `ok(Error)`, `mapError` returning an `Error` → error Result; pick one semantic
  and document it.
- **`src/option.ts:30-36` / `src/result.ts:45-51` — `isSome()`/`isOK()` type predicates
  are broken:** the false branch narrows to `never` (verified with the repo's tsc), so
  `if (!opt.isSome())` code paths type-check as unreachable. Fix: discriminated subtypes,
  or drop `this is` and return plain `boolean`.
- `src/async-result.ts:24` — `AsyncResult.all` casts rejection reasons (`reason as E`);
  non-Error rejections yield Results whose `error` isn't an `Error`, inconsistent with
  `AsyncResult.resolve` which normalizes via `Result.toError`.
- Minor: `Result.toError`'s `createError` factory doesn't receive `cause` and is ignored
  when the cause is an `Error` — callers can't wrap Error causes in domain errors.
  `AsyncResult`'s `static [Symbol.species] = Promise` has no effect (not a Promise
  subclass); dead code.

### async

- **`src/disposer.ts:51` — already-aborted external signal never disposes; `disposed`
  hangs forever** (verified — abort events don't replay for listeners added after the
  fact). Fix: check `params.signal?.aborted` first and dispose synchronously. The existing
  test only aborts after construction.
- `src/defer.ts:6-17` — `Deferred<T, R>`'s `reject: (reason?: R) => void` provides false
  type safety: the native reject accepts anything, so `defer<X, never>()` claims it never
  rejects but is still callable with any reason.

### generator

- **`src/index.ts:119-127` — `fromEmitter`: concurrent `next()` calls drop the first
  waiter, which hangs forever** (verified — `pending` deferred is overwritten). Real
  generators queue `next()` calls. Fix: FIFO array of pending deferreds.
- `src/index.ts:42,106` — abort listeners never removed after normal completion in
  `consume` and `fromEmitter`; every completed consumer leaks a closure on a long-lived
  shared signal (e.g. app shutdown signal).
- Minor: `ended.reject(signal?.reason)` rejects with `undefined` when the signal has no
  reason — wrap in `AbortInterruption` (already a dependency). `AsyncGenerator<T>` at
  line 140 leaves `TReturn`/`TNext` as implicit `any`; spell `AsyncGenerator<T, void, void>`.

### flow

- **`src/flow.ts:96` — `getState()` freezes the live state object**, not a copy
  (verified); after one call, in-place mutation anywhere — including inside handlers —
  throws `TypeError`. Fix: freeze a clone, or rely on the `Readonly<State>` type only.
- **`src/flow.ts:131` — `defaultAction` re-applied on every `next()` with no pending
  action**, so `for await` over a flow whose handler returns `{status:'state'}` loops
  forever (verified). If it means "initial action", consume it once; if looping is
  intended, document prominently.
- `src/types.ts:4` — `{ status: 'aborted'; reason: string }` but the implementation
  assigns `flowSignal.reason` (typically an `Error` or `undefined`). Type as `unknown`.
- `next()` has no serialization: two concurrent calls run handlers concurrently against
  shared state, last write wins. Same class of issue as generator's `fromEmitter`.
- `src/types.ts:48` — `any` with biome-ignore.

### stream

- **`src/connection.ts:13-29` — no abort/cancel propagation, no backpressure.** Aborting
  one side never errors the peer's controller (its reader hangs forever holding the lock);
  cancelling a readable isn't signaled back (next enqueue throws an opaque `TypeError`);
  `write` ignores `desiredSize`, so a slow consumer buffers unboundedly in the transport
  primitive. The only test is a single happy path.
- **`src/pipe.ts:19-25` — same gaps, plus close-after-drain throws:** after `drain()`
  closes the controller, a later `writer.close()` re-closes it → the writable's close
  rejects. Guard the controller close; add abort propagation.
- **`src/json-lines.ts:74` — one stray `]` or `}` line drives `nestingDepth` negative
  permanently;** all subsequent valid messages are silently swallowed/merged. Fix: on
  negative depth, route the line to `onInvalidJSON` and reset framer state. Untested.
- `src/json-lines.ts:121-124` — newline-in-string repair bypasses `processChar`, leaving
  `isEscapingChar` stale when the buffered string ends in a backslash; fabricating `\n`
  content for invalid JSON is questionable anyway — dropping the line as invalid is more
  predictable.
- `src/json-lines.ts:23-25` — custom `decode` is typed `DecodeJSON<unknown>` but its
  result is asserted as `T`; either type it `DecodeJSON<T>` or document that `T` is
  unchecked.

### otel

- **`src/traceparent.ts:19-34` — all-zero trace-id / parent-id accepted.** W3C Trace
  Context requires treating all-zero IDs as invalid; currently they become an invalid
  remote SpanContext that SDKs will parent spans to. Untested.
- **`src/context.ts:43-48` — the tid/sid extraction path hardcodes `TraceFlags.SAMPLED`
  and skips ID validation** (the W3C path does both correctly); `injectTraceContext`
  doesn't send flags at all, so every remote trace is force-sampled and garbage IDs become
  SpanContexts. Inject and echo a flags field; validate 32/16 lowercase hex.
- `src/traceparent.ts:12-14` — `formatTraceparent` can emit invalid headers
  (`traceFlags` ≥ 256 or negative, unchecked ID lengths); mask with `& 0xff` at minimum.
- `src/traceparent.ts:26-28` — future traceparent versions rejected outright; spec says
  SHOULD parse the first four fields of higher versions.
- `src/tracestate.ts:27-41` — `formatTracestate` doesn't dedupe keys (parse does).
- `src/tracers.ts:7` — `OTEL_PACKAGE_VERSION = '0.1.0'` hardcoded; will drift from the
  published version.
- `src/tracers.ts:61,86` — `setStatus(OK)` on every success; OTel guidance is to leave
  status UNSET for instrumentation.
- `src/log-sink.ts:4-11` — local `LogRecord` type duplicates logtape's; import it instead
  (drift risk — it already needs both `warning` and `warn` mappings).

### log

- `src/index.ts:29-31` — `setup()` throws if configuration already happened
  (`configureSync` errors on double configuration); two independent consumers calling
  `setup()` crash. Guard with a flag or expose a reset.
- **No test directory at all.**

### codec

- **`src/index.ts:67-72` — base64url output is padded.** Tests assert the padding, so
  it's intentional — but RFC 7515 (JWS/JWT) requires unpadded base64url, and
  JWT-adjacent consumers sit directly on this layer. Decide before freezing the API.
- `src/index.ts:16-19` — `canonicalStringify` can return `undefined` typed as `string`
  (hidden by `@ts-expect-error`); `fromUTF(undefined)` then yields an empty array, so
  `b64uFromJSON` silently produces `""` instead of throwing.
- `src/index.ts:84-86` — `toUTF` uses a non-fatal `TextDecoder`; corrupted input decodes
  to U+FFFD-mangled strings instead of failing. For a codec under signatures, use
  `{ fatal: true }` or document the lossy contract.
- `src/index.ts:30-34` vs `57-61` — `fromB64U` pre-validates with a regex, `fromB64`
  doesn't; feature-detection style differs between the two paths. Minor consistency.

## Repo / infrastructure

1. **No LICENSE file** — root or per-package — while every manifest declares MIT. npm
   tarballs ship without license text. Add a root LICENSE and per-package copies (or
   include via `files`).
2. **`turbo.json` `clean` task is orphaned:** packages define `build:clean`, not `clean`,
   so `build:js`'s `dependsOn: ["^clean"]` matches nothing. Rename one side. Also
   `build:types` runs via `pnpm run -r` instead of Turbo, losing caching — a
   `build:types` task with `dependsOn: ["^build:types"]` preserves the topological order
   already relied on.
3. **Changesets `fixed: []` contradicts the docs.** AGENTS.md and
   `docs/agents/architecture.md` describe a "fixed group" with `runtime-expo`
   independent, but nothing enforces it and versions already diverge (`otel` 0.2.0 vs
   0.1.0 elsewhere). Either set `"fixed": [["@sozai/*", "!@sozai/runtime-expo"]]` in
   `.changeset/config.json` or reword the docs to "stable" rather than "fixed".
4. **`docs/index.md:9` dead link** — `docs/agents/plans/` doesn't exist. Create it (with
   `.gitkeep`) or drop the line.
5. **`test:types` script drift:** `--skipLibCheck` present in roughly half the packages,
   absent in the rest; `runtime-expo` points at `tsconfig.json` instead of a test config.
   Normalize.
6. **`minimumReleaseAgeExclude` set in `pnpm-workspace.yaml` with no `minimumReleaseAge`**
   — a no-op unless the age is set elsewhere (check `@kigu/dev` / global config).
7. **Package READMEs are install-only stubs** (~70 bytes). One usage example per package
   goes a long way for published packages; `docs/reference/*.md` content could seed them.
8. Empty `keywords: []` in about half the manifests (async, execution, generator, log,
   result, runtime, runtime-expo).

## Conventions

Clean overall: no `interface`, `T[]`, or `private`/`readonly` violations found. Two
biome-suppressed `any`s (`schema/src/utils.ts:12` — fixable, `flow/src/types.ts:48`) and
one implicit `any` via bare `AsyncGenerator<T>` (`generator/src/index.ts:140`).

## Test-coverage gaps (highlights)

- patch: `test` on compound values, `-` token, add-as-insert, create-side escaping,
  malformed indices, `__proto__` paths, applying type-change patches.
- schema: cross-call `$id`/`$ref` interaction on the shared Ajv instance.
- stream: any abort/cancel/backpressure behavior; stray closing bracket in json-lines.
- execution: timer cancellation on success; throwing `NextFn`; dispose-before-start.
- result: non-Error throws in `map`/`mapError`; `AsyncResult.all` with non-Error reasons.
- async: Disposer with an already-aborted signal.
- generator/flow: concurrent `next()`; listener removal.
- otel: all-zero IDs, flag overflow, tracestate duplicate keys.
- log, runtime-expo: no runtime tests at all.

## Suggested order of work

1. patch: path sanitization + RFC 6902 compliance batch (one PR — biggest correctness
   surface, includes the security fix).
2. schema `removeSchema` guard (one line, global blast radius).
3. runtime-expo fetch fixes + real tests.
4. Lifecycle pass across execution/async/generator/event/flow: cancel timers and remove
   abort listeners on settle (same pattern everywhere).
5. result: `Result.toError` in `map`/`mapError`; decide the predicate-narrowing design.
6. codec: base64url padding decision — API-breaking, so decide before freeze.
7. stream: abort/cancel propagation + json-lines depth reset.
8. otel: W3C compliance batch (zero IDs, flags, validation).
9. Infra batch: LICENSE, turbo `clean`, changesets fixed group, dead link, test-script
   normalization, READMEs.
