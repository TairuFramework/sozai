# @sozai/runtime-expo

Expo / React Native binding for [`@sozai/runtime`](../runtime), backed by `expo/fetch` and `expo-crypto`.

## Installation

```sh
pnpm add @sozai/runtime-expo
```

## Usage

```ts
import { polyfill, expoRuntime } from '@sozai/runtime-expo'

// At your app entry (e.g. app/_layout.tsx), before imports that rely on crypto:
polyfill()

// Or pass the pre-built Runtime where one is expected:
const id = expoRuntime.getRandomID()
const nonce = expoRuntime.getRandomValues(new Uint8Array(16))
```

Also provides `createRuntime` (Expo defaults with partial overrides) and `polyfillCrypto`.

> This package tracks the Expo SDK and is versioned independently of the frozen `@sozai/runtime` core, so it may increment a major version on its own — pin it to your Expo SDK version.

See [the runtime-expo reference](../../plugins/sozai/skills/runtime/reference/runtime-expo.md) (part of the `sozai:runtime` skill) for the full API.
