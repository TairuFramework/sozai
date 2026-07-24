# @sozai/runtime

Platform-agnostic `Runtime` abstraction and `createRuntime` factory for `fetch` and crypto primitives.

## Installation

```sh
pnpm add @sozai/runtime
```

## Usage

```ts
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

// Resolve globalThis defaults for fetch and crypto
const runtime: Runtime = createRuntime()

const id = runtime.getRandomID()
const nonce = runtime.getRandomValues(new Uint8Array(16))
const response = await runtime.fetch('https://example.com/api')

// Override a single method (e.g. in tests)
const testRuntime = createRuntime({
  getRandomID: () => 'fixed-id-for-tests',
})
```

See [the runtime reference](../../docs/reference/runtime.md) for the full API.
