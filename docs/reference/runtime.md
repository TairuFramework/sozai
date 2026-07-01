# Runtime

Platform-agnostic runtime primitives (`fetch`, random ID, random bytes) and their Expo binding.

## Packages

| Package | Purpose |
|---|---|
| `@sozai/runtime` | Platform-agnostic `Runtime` abstraction and `createRuntime` factory |
| `@sozai/runtime-expo` | Expo / React Native binding; independently versioned per `runtime-<env>` pattern |

---

## @sozai/runtime

### Exports

| Export | Kind | Description |
|---|---|---|
| `Fetch` | type | Type alias for `globalThis.fetch` |
| `GetRandomID` | type | `() => string` — synchronous UUID generator |
| `GetRandomValues` | type | `<T extends ArrayBufferView>(array: T) => T` — fills array with random bytes |
| `Runtime` | type | Object with `fetch`, `getRandomID`, `getRandomValues` fields |
| `createRuntime` | function | Returns a `Runtime` with globalThis defaults; accepts partial overrides |

### Runtime shape

```typescript
type Runtime = {
  fetch: Fetch
  getRandomID: GetRandomID
  getRandomValues: GetRandomValues
}
```

Default implementations delegate to `globalThis` at call time (not bind time), so test spies and mocks on `globalThis.fetch`, `globalThis.crypto.*` remain effective.

### Example

```typescript
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

// Create with globalThis defaults
const runtime: Runtime = createRuntime()

// Generate a random UUID
const id = runtime.getRandomID()

// Fill a buffer with cryptographically random bytes
const nonce = runtime.getRandomValues(new Uint8Array(16))

// Fetch a resource using the environment's fetch
const response = await runtime.fetch('https://example.com/api/data')
const data = await response.json()

// Override a single method (e.g. in tests)
const testRuntime = createRuntime({
  getRandomID: () => 'fixed-id-for-tests',
})
```

---

## @sozai/runtime-expo

Provides a pre-built `Runtime` backed by `expo/fetch` and `expo-crypto`, and polyfill helpers to patch `globalThis` for older Expo environments.

> **Independent versioning.** `@sozai/runtime-expo` tracks the Expo SDK. It may increment a major version independently of the frozen `@sozai/runtime` core, following the `runtime-<env>` pattern.

### Exports

| Export | Kind | Description |
|---|---|---|
| `expoRuntime` | const | Pre-built `Runtime` using Expo's `fetch` and `expo-crypto` |
| `createRuntime` | function | Returns a `Runtime` with Expo defaults; accepts partial overrides |
| `polyfillCrypto` | function | Patches `globalThis.crypto` with `expo-crypto` implementations |
| `polyfillFetch` | function | Patches `globalThis.fetch` with Expo's `fetch` |
| `polyfill` | function | Calls both `polyfillCrypto` and `polyfillFetch` |

All three polyfill functions accept an optional `override: boolean` (default `false`). When `false`, existing globals are left untouched; pass `true` to force-replace them.

### Example — polyfill at app entry

```typescript
// app/_layout.tsx (or your root entry point)
import { polyfill } from '@sozai/runtime-expo'

// Patch globalThis once, before any other imports that rely on fetch/crypto
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

---

## When to Use

**Use `@sozai/runtime`** when:
- Writing code that must run in any JavaScript environment (Node.js, browsers, workers)
- Accepting a `Runtime` parameter to keep a module environment-agnostic
- Injecting a controlled runtime in tests (pass overrides to `createRuntime`)

**Use `@sozai/runtime-expo`** only in Expo / React Native apps:
- Call `polyfill()` once at app startup to shim missing globals
- Pass `expoRuntime` or `createRuntime()` where a `Runtime` is expected
- Pin the package to your Expo SDK version — it may major independently

---

## See Also

- `sozai:validation` — schema and codec utilities that work alongside a `Runtime`
- `sozai:dataflow` — stream and event processing that may depend on a `Runtime` for I/O
- `sozai:observability` — structured logging and metrics, environment-agnostic
- `sozai:primitives` — base utilities used across the sozai layer
