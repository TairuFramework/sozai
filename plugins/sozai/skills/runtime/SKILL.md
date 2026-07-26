---
name: runtime
description: Use when abstracting platform fetch and randomness, targeting Expo/React Native, or taking a cross-process lock in sozai.
---

# Sozai runtime

Platform runtime abstraction — environment-agnostic `fetch` and randomness via `createRuntime`,
plus the Expo / React Native binding. Also home to the one filesystem-dependent package in the
repo, a cross-process mutex.

## Packages

- **@sozai/runtime** — platform abstraction (`fetch`, randomness) via `createRuntime`. → `reference/runtime.md`
- **@sozai/runtime-expo** — Expo / React Native runtime binding. → `reference/runtime-expo.md`
- **@sozai/lock** — filesystem-based cross-process mutex. → `reference/lock.md`, and
  `reference/lock-semantics.md` for the failure modes

## Pick this when

- Writing library code that must run unchanged across Node, browsers, and workers, accepting a
  `Runtime` parameter instead of calling `globalThis` directly, or injecting a controlled runtime
  in tests → `@sozai/runtime`, `reference/runtime.md`
- Targeting Expo or React Native — call `polyfill()` at app startup to shim `globalThis.crypto`
  when it's missing (there is no fetch polyfill in this package), then pass `expoRuntime` or
  `createRuntime()` where a `Runtime` is expected; pin to your Expo SDK version, since it may major
  independently of `@sozai/runtime` → `@sozai/runtime-expo`, `reference/runtime-expo.md`
- Two processes may touch the same resource and the store underneath has no compare-and-swap —
  e.g. a keystore whose write API is an unconditional upsert → `@sozai/lock`, semantics file
  first: `reference/lock-semantics.md`

## Related

- `/sozai:dataflow` — `@sozai/lock` builds on `@sozai/async`.
