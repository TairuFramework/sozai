# runtime-expo — stand up runtime tests

**Status:** complete
**Date:** 2026-07-24
**Packages:** `@sozai/runtime-expo` (no version bump — tests + test-script wiring only)
**Branch:** `feat/runtime-expo-tests`
**Source:** [backlog/2026-07-16-runtime-expo-tests](../backlog/) (removed on completion); the gap was
flagged by the [2026-07-02 audit](2026-07-02-repo-audit.complete.md) and again by the
[2026-07-16 review](../project-loop-state.md), which is where the import-time `fetch` capture was fixed.

## Goal

`runtime-expo` was the only package with no `test/` — its `test` script ran types only. That gap is
why the import-time `fetch` capture shipped and survived the freeze-blocker sweep, and the 2026-07-16
fix was still unverified. Stand up a real suite mirroring `@sozai/runtime`.

## What was built

- **`test/index.test.ts` — 10 unit tests.** `expo-crypto` is a native module that cannot load in a
  bare Node/vitest run (it drags in `expo-modules-core`'s TS source and a native `ExpoCrypto`
  binding), so it is mocked with `vi.mock` + `vi.hoisted` spies. Coverage:
  - `expoRuntime` wiring by identity (`getRandomID` → `randomUUID`, `getRandomValues`), asserted by
    call-through.
  - **`fetch` delegates to `globalThis.fetch` at call time** — the regression the suite exists for:
    the spy is assigned to `globalThis.fetch` *after* import and must still apply.
  - `createRuntime` resolves the expo defaults and lets overrides win / omitted entries fall back.
  - `polyfillCrypto` install-when-absent, leave-when-present (`override=false`), replace
    (`override=true`), and install-only-the-missing-one; `polyfill` delegates to it. Global mutation
    is contained with `vi.stubGlobal` + `vi.unstubAllGlobals` in `try/finally`.
- **Test wiring** mirroring `@sozai/runtime`: added `tsconfig.test.json`; `test` → `test:types &&
  test:unit`, `test:unit` = `vitest run`, `test:types` = `tsc -p tsconfig.test.json` (kept
  `--skipLibCheck` for the messy expo/RN ambient types). vitest resolves from the workspace root — no
  per-package devDependency, matching the sibling packages.

## Cut, with reason

- **The URL type-level test (backlog's "note on type coverage") was dropped as vacuous.** Its premise
  is that React Native's `fetch` overload (dragged in via `expo-crypto`) narrows `Parameters<Fetch>`
  and drops `URL`. But `react-native` is not installed in this workspace — it is a native-app peer —
  so that overload never enters the type program here; `Parameters<Fetch>` always includes `URL`, and
  a call-site URL assertion passes vacuously. Verified by mutation: rewriting `defaultFetch` to derive
  from `Parameters<Fetch>` produced no type error under `tsconfig.test.json`. `defaultFetch` keeps its
  spelled-out signature and explanatory comment in src as consumer-facing defence; it simply cannot be
  regression-pinned in-repo without pulling in react-native (wrong, heavy dependency for a library). A
  comment in the test file records this.

## Verification

- `@sozai/runtime-expo` vitest 10/10 green, `test:types` clean, biome clean.
- Mutation-sanity on the load-bearing test: capturing `globalThis.fetch` at bind time (the original
  bug shape) fails exactly the call-time-delegation test.
