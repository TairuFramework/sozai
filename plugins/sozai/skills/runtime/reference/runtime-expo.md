# @sozai/runtime-expo

Provides a pre-built `Runtime` for Expo / React Native: randomness from `expo-crypto`, and `fetch`
delegated to `globalThis.fetch` at call time (not captured at import, so a fetch polyfill installed
afterward still applies). Also exports a helper to patch `globalThis.crypto` where it is missing.

> **Independent versioning.** `@sozai/runtime-expo` tracks the Expo SDK. It may increment a major
> version independently of the frozen `@sozai/runtime` core, following the `runtime-<env>` pattern.

### Exports

| Export | Kind | Description |
|---|---|---|
| `expoRuntime` | const | Pre-built `Runtime`: `getRandomID`/`getRandomValues` from `expo-crypto`, `fetch` delegating to `globalThis.fetch` |
| `createRuntime` | function | Returns a `Runtime` with `expoRuntime` defaults; accepts partial overrides |
| `polyfillCrypto` | function | Patches `globalThis.crypto` with `expo-crypto`'s `getRandomValues`/`randomUUID` |
| `polyfill` | function | Currently just calls `polyfillCrypto` — this package has no separate fetch polyfill |

`polyfillCrypto` and `polyfill` accept an optional `override: boolean` (default `false`). When
`false`, an existing global is left untouched; pass `true` to force-replace it.

### Example — polyfill at app entry

```typescript
// app/_layout.tsx (or your root entry point)
import { polyfill } from '@sozai/runtime-expo'

// Patch globalThis.crypto once, before any other imports that rely on it
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
