# @sozai/runtime

Environment-agnostic `fetch` and randomness. `createRuntime()` fills in `globalThis` defaults so
consumers always get a fully resolved `Runtime` — no optional checks needed downstream.

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

Default implementations delegate to `globalThis` at call time (not bind time), so test spies and
mocks on `globalThis.fetch`, `globalThis.crypto.*` remain effective.

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

### Example: deterministic runtime for tests

```typescript
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

// Every field overridden — no real network, no random noise
const testRuntime: Runtime = createRuntime({
  getRandomID: () => 'test-id-001',
  getRandomValues: <T extends ArrayBufferView>(array: T): T => {
    // ArrayBufferView has no .fill — view it as bytes to zero it
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0)
    return array
  },
  fetch: async (_input, _init) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
})
```

Each unoverridden method still delegates to `globalThis`, so a partial override like this is safe.
