---
name: sozai:runtime
description: Platform runtime abstraction (fetch, randomness), Expo binding, and cross-process file lock
---

# Sozai Runtime

## Packages in This Domain

**Platform-agnostic runtime**: `@sozai/runtime`

**Expo / React Native binding**: `@sozai/runtime-expo`

**Filesystem-based cross-process mutex**: `@sozai/lock`

## Key Patterns

### Pattern 1: Create and Consume a Runtime

```typescript
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

// Build a runtime using globalThis defaults (fetch, crypto.randomUUID, crypto.getRandomValues)
const runtime: Runtime = createRuntime()

// Generate a unique ID
const id = runtime.getRandomID()

// Fill a buffer with random bytes
const bytes = runtime.getRandomValues(new Uint8Array(16))

// Issue a network request
const res = await runtime.fetch('https://example.com/api/status')
```

**Use case**: Any module that needs fetch or randomness without coupling to a specific environment.

**Key points**:
- `Runtime` carries exactly three fields: `fetch`, `getRandomID`, `getRandomValues`
- Defaults delegate to `globalThis` at call time — test spies on `globalThis.crypto` etc. work without extra wiring
- Accept a `Runtime` parameter in shared code instead of calling `globalThis` directly; inject via `createRuntime` at the call site

### Pattern 2: Override in Tests

```typescript
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

// Deterministic runtime for tests — no real network, no random noise
const testRuntime: Runtime = createRuntime({
  getRandomID: () => 'test-id-001',
  getRandomValues: (array) => {
    array.fill(0)
    return array
  },
  fetch: async (_input, _init) =>
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
})

// Pass to the unit under test
// await processItem(testRuntime, payload)
```

**Key points**:
- `createRuntime` accepts a partial override — supply only the methods you need to control
- Each unoverridden method still delegates to `globalThis`, so partial mocking is safe

### Pattern 3: Expo Polyfill at App Entry

```typescript
// app/_layout.tsx (or your Expo root entry)
import { polyfill } from '@sozai/runtime-expo'

// Patch globalThis.fetch and globalThis.crypto once, before other imports
polyfill()
```

**Use case**: Older Expo environments missing `globalThis.fetch` or `globalThis.crypto`.

**Key points**:
- `polyfill()` calls `polyfillFetch()` and `polyfillCrypto()` in one step
- Pass `true` to force-replace existing globals: `polyfill(true)`
- Default (`false`) is additive: existing globals are preserved
- `@sozai/runtime-expo` tracks the Expo SDK and may major independently of `@sozai/runtime`

### Pattern 4: Expo-Backed Runtime for Explicit Injection

```typescript
import type { Runtime } from '@sozai/runtime'
import { createRuntime, expoRuntime } from '@sozai/runtime-expo'

// Pre-built singleton — use when you just need the defaults
const runtime: Runtime = expoRuntime

// Or override a single method while keeping the rest Expo-native
const withHeaders: Runtime = createRuntime({
  fetch: (input, init) =>
    expoRuntime.fetch(input, { ...init, headers: { 'X-Client': 'my-app' } }),
})

const id = withHeaders.getRandomID()
const nonce = withHeaders.getRandomValues(new Uint8Array(32))
```

**Key points**:
- `expoRuntime` is a pre-built `Runtime` constant backed by `expo/fetch` and `expo-crypto`
- `createRuntime` from `@sozai/runtime-expo` starts from the Expo defaults (not `globalThis`)
- The return type is `Runtime` from `@sozai/runtime` — fully interchangeable

## When to Use What

**Use `@sozai/runtime`** when:
- Writing env-agnostic library code that accepts a `Runtime` parameter
- Injecting a controlled runtime in unit tests
- Running in Node.js, browsers, or edge workers where `globalThis` is already populated

**Use `@sozai/runtime-expo`** only in Expo / React Native apps:
- Add `polyfill()` at app startup to shim missing globals
- Pass `expoRuntime` or `createRuntime()` where a `Runtime` is required
- Pin to your Expo SDK version — the package follows the Expo SDK major and may update independently of the core

**Use `@sozai/lock`** when two processes may touch the same resource and the store underneath has no compare-and-swap — e.g. a keystore whose write API is an unconditional upsert.

## Related Domains

- See `sozai:validation` — schema and codec utilities that work alongside a `Runtime`
- See `sozai:dataflow` — stream and event pipelines that may depend on a `Runtime` for I/O
- See `sozai:observability` — structured logging and metrics, environment-agnostic
- See `sozai:primitives` — base utilities used across the sozai layer

## Domain Reference

For the full domain reference: `docs/reference/runtime.md`
