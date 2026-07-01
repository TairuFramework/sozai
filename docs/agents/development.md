# Development

Shared build, test, and release workflow lives in the kigu `development` skill,
auto-loaded via the kigu plugin. See it for the pnpm / Turbo / SWC / Biome / Vitest
workflow and the `docs/agents/plans/` lifecycle.

## Repo-specific

Core utility layer (async, codec, schema, stream, runtime, ...). `runtime-expo` versions
independently against the Expo SDK and may major without dragging the frozen utilities.
