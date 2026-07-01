# Architecture

sozai (素材, "raw material") is the core utility layer of the stack: stable, low-altitude
packages with no upward dependencies.

## Packages

async, codec, event, execution, flow, generator, log, otel, patch, result, runtime, schema,
stream -- the stable fixed group. `runtime-expo` versions independently (bound to the Expo SDK).

## Position in the stack

Bottom of the dependency graph -- everything else depends downward on sozai; sozai depends on
nothing in the stack. See the stack overview: https://github.com/TairuFramework/kigu/blob/main/docs/stack.md
