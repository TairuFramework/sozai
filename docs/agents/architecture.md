# Architecture

sozai (素材, "raw material") is the core utility layer of the stack: stable, low-altitude
packages with no upward dependencies.

## Packages

async, codec, event, execution, flow, generator, lock, log, otel, patch, result, runtime, schema,
stream -- the stable group. Every package versions independently, per-package via changesets;
there is no `fixed` lock between them, so versions legitimately diverge. `runtime-expo` is bound
to the Expo SDK but is not otherwise a special case.

`lock` is filesystem-based (`node:fs`) -- the one package here that is not environment-agnostic; it
exists because kokuin's keystores need a cross-process mutex and may only depend downward.

## Position in the stack

Bottom of the dependency graph -- everything else depends downward on sozai; sozai depends on
nothing in the stack. See the stack overview: https://github.com/TairuFramework/kigu/blob/main/docs/stack.md
