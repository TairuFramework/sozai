# sozai

> **For AI agents:** 素材 ("raw material") — the core utility layer of the stack.
> Stable, low-altitude packages: async, codecs, schema, streams, runtime, logging, otel.
> Everything else (identity, RPC, MLS) depends downward on this repo.

## What this repo is

The frozen foundation. Packages here ossify; consumers (`@kokuin`, `@enkaku`,
`@kumiai`) depend on published `^` ranges, never `workspace:`. `runtime-expo` is the
one independent package — it tracks the Expo SDK and may major without dragging the
fixed group.

## Conventions

Follow the `conventions` skill from the `kigu` marketplace (the canonical source of
truth). pnpm only. `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital
`ID`/`HTTP`/`JWT`/`DID`; ES `#fields`, never `private`/`readonly`. Do not edit
generated files (`lib/`).

## Toolchain

All dev tooling and shared configs come from `@kigu/dev`. Extend
`@kigu/dev/tsconfig.json`, `["@kigu/dev/biome.json"]`, and `@kigu/dev/swc.json`.

See `../kigu/docs/repo-split-design.md` for the broader monorepo-split architecture.
