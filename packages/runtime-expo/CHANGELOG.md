# @sozai/runtime-expo

## 0.2.2

### Patch Changes

- `expoRuntime.fetch` now delegates to `globalThis.fetch` at call time instead of capturing it at
  import time.

  `expoRuntime` was built with `fetch: globalThis.fetch`, evaluated when the module was first
  imported. Two consequences: a `fetch` polyfill installed after that import was ignored — the
  runtime kept calling the implementation that happened to be present at load — and the captured
  reference was detached from `globalThis`, so a host that requires `fetch` to be called with
  `globalThis` as its receiver threw `TypeError: Illegal invocation`. Test spies and mocks on
  `globalThis.fetch` were silently bypassed for the same reason. `createRuntime()` inherited all of
  it, since its default came from `expoRuntime.fetch`.

  `@sozai/runtime` already delegated at call time; `@sozai/runtime-expo` now matches, so both
  runtimes resolve `fetch` the same way.
