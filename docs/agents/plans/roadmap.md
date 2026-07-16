# sozai roadmap

## Where things stand

The API freeze is done. Every correctness fix the [2026-07-02 repo audit](completed/2026-07-02-repo-audit.complete.md)
found has landed, both API-shape decision gates are resolved, and packages are published with
versions diverging per-package as designed (0.1.0–0.3.0). Consumers (`@kokuin`, `@enkaku`,
`@kumiai`) can pin `^` ranges against a surface that is not going to move.

One correctness fix landed late: the [2026-07-16 review](project-loop-state.md) found the audit's
`runtime-expo` findings had never been picked up by any plan — `expoRuntime.fetch` was still
captured at import time. Fixed in that review; the package still has no runtime tests, which is
why it was missed.

Nothing left is urgent. What remains is a backlog of known, documented, non-blocking items —
each already carries its own `file:line` references and reasoning, so any of them can go
straight into `/dev-loop`.

## Sequence

Ordered by cost against value, not severity. Nothing here blocks anything else.

### 1. Quick wins — one small PR each, or one batched PR

- [otel — span ID validation gap](backlog/2026-07-14-otel-span-id-validation-gap.md). One line at each of
  two call sites plus a test; `isValidSpanID` already exists and is exported. Unreachable with a
  real OTel SDK — worth it for symmetry.
- [disposer — macrotask fallback reason latch](backlog/2026-07-14-disposer-macrotask-fallback-reason-latch.md).
  Decide whether the two platforms should agree, pin it with a test that stubs `queueMicrotask`,
  say what the guarantee is in the JSDoc. No in-repo consumer affected.
- [patch — deferred follow-ups](backlog/2026-07-03-patch-followups.md). Mostly docs and coverage. The
  prototype-hardening item is theoretical and touches the well-tested atomic swap — take the
  docs/coverage half, leave that one unless there's a reason.

### 2. Coverage and release plumbing

- [runtime-expo — no runtime tests](backlog/2026-07-16-runtime-expo-tests.md). The only package with no
  `test/` at all, which is exactly why its `fetch` bug survived the sweep. The 2026-07-16 fix is
  still unverified by any test. Cost is mostly mocking `expo-crypto`.
- [infra — no release workflow](backlog/2026-07-11-release-workflow.md). Fifteen independently versioned
  packages published by hand from a developer machine. Check whether kigu has a reusable release
  workflow to call before writing one here.

### 3. Infra hygiene — mechanical, batchable

- [turbo, test scripts, READMEs, keywords](backlog/2026-07-02-infra-hygiene.md). The orphaned `clean` task
  and the root `build:types` script bypassing Turbo are real caching losses; the READMEs are the
  highest-value part for published packages, and `docs/reference/*.md` already has the content to
  seed them.

### 4. Needs a cross-repo audit first

- [codec — base64 accepts non-canonical encodings](backlog/2026-07-11-codec-non-canonical-base64.md).
  Signature malleability at the string level. Only bites if something downstream treats a token
  string as an identity. Audit `@kokuin` / `@kubun` / `@enkaku` for dedup sets, cache keys,
  idempotency keys, unique columns, replay sets. If none — and none is known today — this closes
  as a documented quirk. If one exists, fix it there, not in the codec.

### 5. Blocked upstream — watch, don't work

- [codec — canonicalize emits invalid JSON for nested non-serializable values](backlog/2026-07-11-codec-canonicalize-nested-undefined.md).
  Tracks [erdtman/canonicalize#22](https://github.com/erdtman/canonicalize/pull/22). Fails loud,
  caller bug to trigger. Bump the catalog entry when it ships. Fallback if the PR stalls: swap in
  an RFC 8785 implementation — non-breaking, the contract doesn't change.

### 6. Deferred — research-heavy, no affected consumer

- [lock — close the no-boot-ID fallback hole](backlog/2026-07-13-lock-fallback-platforms.md).
  Windows has no boot-ID source, and sandboxed macOS loses one because darwin's comes from
  spawning `sysctl`. Both need clock-independent sources that may not be reachable from Node
  without a native addon — establish that first. Failing that, surface the downgrade rather than
  hide it. Low priority until a consumer lands on an affected platform.
