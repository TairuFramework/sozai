# runtime-expo — fetch fixes + first real tests

**Status:** open · freeze-blocker · priority 3
**Source:** [audit 2026-07-02 — runtime-expo](../completed/2026-07-02-repo-audit.complete.md#runtime-expo)

`polyfillFetch` currently cannot do useful work, and the package ships with no runtime
tests — which is why the bugs shipped. `runtime-expo` tracks the Expo SDK and may major
independently of the fixed group, but these are plain correctness fixes.

## Critical

- **`src/index.ts:30` — `polyfillFetch` is a no-op or a crash.** `globalThis.fetch = fetch`
  with no `fetch` import: when global fetch exists it assigns to itself; when absent (the
  case the polyfill targets) evaluating `fetch` throws `ReferenceError`. Intended
  `import { fetch } from 'expo/fetch'` — but `expo` is not in dependencies. Add the dep and
  the import.
- **`src/index.ts:5` — `expoRuntime.fetch` captured at import time.** `@sozai/runtime`
  deliberately delegates to `globalThis.fetch` at call time (documented + tested); the expo
  variant binds at module load, so later polyfills/mocks are ignored and a detached `fetch`
  can throw "Illegal invocation". Fix: `(...args) => globalThis.fetch(...args)`.

## Testing

- **No runtime tests at all** (test script is types-only). Add real tests covering both
  fixes above — the reason they shipped.
