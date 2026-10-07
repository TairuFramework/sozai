# Architecture

sozai (素材, "raw material") is the core utility layer of the stack: stable, low-altitude
packages with no upward dependencies.

## Packages

async, codec, event, execution, flow, flow-graph, generator, http-server, json, lock, log, otel, patch,
result, runtime, schema, stream -- the stable group. Every package versions independently, via pnpm's native
versioning (`pnpm change` / `pnpm version -r`); `versioning.fixed` in `pnpm-workspace.yaml` is
unset, so there is no lock between them and versions legitimately diverge. `runtime-expo` is bound
to the Expo SDK but is not otherwise a special case.

`lock` is filesystem-based (`node:fs`) -- the one package here that is not environment-agnostic; it
exists because kokuin's keystores need a cross-process mutex and may only depend downward.

`http-server` is Node-only like `lock`: it wraps Hono so that HTTP services in the stack share one
lifecycle (dependency-ordered setup, health checks, graceful shutdown) and one plugin contract.

`flow-graph` executes node kinds directly and uses `async` for attempt timeouts and retries.
It does not depend on `flow`, which provides a separate code-defined state machine.

## Position in the stack

Bottom of the dependency graph -- everything else depends downward on sozai; sozai depends on
nothing in the stack. See the stack overview: https://github.com/TairuFramework/kigu/blob/main/docs/stack.md
