# runtime-expo — no runtime tests

**Status:** open · backlog
**Package:** `@sozai/runtime-expo`
**Found during:** [2026-07-16 review](../project-loop-state.md); originally flagged by the
[2026-07-02 repo audit](../completed/2026-07-02-repo-audit.complete.md)

`runtime-expo` is the only package with no `test/` directory. Its `test` script is
`pnpm run test:types` — types only, zero runtime assertions.

That gap is why the import-time `fetch` capture (fixed 2026-07-16) shipped and survived the whole
freeze-blocker sweep: every other package's equivalent behavior is pinned by a test, and
`@sozai/runtime` explicitly tests that its defaults delegate to `globalThis` at call time. Nothing
was watching the Expo variant, so it silently diverged from the package it mirrors.

The fetch fix itself is currently **unverified by any test**.

## The work

- Stand up `test/` with the same vitest setup the other packages use, and wire a real `test:unit`
  script (the `test` script currently shadows the shared `turbo run test:types test:unit` shape).
- `expo-crypto` is a native module, so `getRandomID` / `getRandomValues` need it mocked — that
  mock is most of the cost here and is probably why the package never got tests.
- Minimum worth having, mirroring `@sozai/runtime`'s own suite:
  - `expoRuntime.fetch` delegates at call time — assign a spy to `globalThis.fetch` *after*
    importing the module, call `expoRuntime.fetch(...)`, assert the spy ran.
  - `createRuntime()` overrides win over the defaults; omitted entries fall back.
  - `polyfillCrypto()` installs only when absent, and `override = true` replaces regardless.

## Note on type coverage

`runtime-expo` compiles against React Native's `fetch` global declaration (dragged in via
`expo-crypto`), which **overloads** the DOM one. So `Parameters<Fetch>` resolves to RN's narrower
overload and silently drops `URL` input support — which is why `defaultFetch` there spells its
signature out instead of deriving it. Worth a type-level test pinning that `expoRuntime.fetch`
accepts a `URL`, since only this package sees the overload.
