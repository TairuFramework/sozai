# flow-graph -- flow references, input decline edge, unconstrained result paths

**Status:** complete
**Date:** 2026-09-30
**Packages:** `@sozai/flow-graph` (minor intent `flow-graph-references`, breaking 0.x API)
**Prerequisite:** [flow-graph package](./2026-09-28-flow-graph-package.complete.md)
**Requested by:** mokei (decline edge, unconstrained result paths) for `@mokei/decision-flow`

## Why

v1 flow-graph ran one flow per run. Real decision flows split into reusable sub-flows and hand
over between flows, so `call`, `goto` and flow-bodied loops were reserved but not executable.
Mokei also needed an `input` edge for a refused MCP form elicitation (`decline`/`cancel`) and a
way to declare a node result as arbitrary JSON without a depth-bounded schema. The three backlog
items shipped together because they touch the same run state, checker and resume validation.

## Key decisions

**A resolver is the only source of definitions for pinned frames.** `start` takes the root
definition explicitly; every other definition, including the root on `resume`/`recover`, comes
from `FlowResolver.resolve(id, version?)`. `resume`/`recover` no longer take `definition` and throw
`TypeError` without a resolver. `createMapResolver` serves in-memory sets and throws
`FlowReferenceError` on a miss. `storageSchema` was dropped: `authoringSchema` covers stored
definitions.

**Run state is a frame stack.** `frames[0]` is the root, the active frame is last. Each frame pins
`{ id, version, digest }` and, when not the root, a `continuation` (`call` or `loopBody`). The
invocation counter moved to `RunState.invocation` so IDs never collide after a pop and re-push.
Every stack change is part of exactly one commit with everything it implies, so recovery sees the
state before or after a transition, never between.

**Every executed definition is a snapshot.** JSON check, `structuredClone`, then check and digest.
Pinned frames are hashed and compared first (`FlowVersionMismatchError`), so a resolver that
mutates later cannot change a running frame. Unversioned references pin at push time.

**Resume validates in two phases.** Definition-free checks throw synchronously; resolution,
digests and definition-dependent invariants run on the first `next()`, which rejects and commits
nothing. The resolver's own error passes through unchanged.

**Callee failures walk down the stack.** Only `node_failed`, `loop_exhausted`, `missing_flow`,
`invalid_flow`, `max_depth` and `invalid_input` are eligible. The first caller that can retry the
call, or has `onError`, handles it in one commit that also removes the frames above. Engine and
budget faults (`invalid_value`, `invalid_target`, `invalid_suspend`, `max_steps`) end the run.
`RunError.flow` names the origin flow.

**Call retry.** `call` retries with the existing policy. `totalTimeoutMs` is a retry deadline from
call entry and never interrupts a callee; `attemptTimeoutMs` is rejected. A retry re-pushes with
the same `invocationID`.

**Error typing.** A call node's own failures (`missing_flow`, `invalid_flow`, `max_depth`,
`invalid_input`, recovery interruptions) routed to `onError` carry the default error type
(`FlowNodeFailure` / `Error`). `FlowCallError` marks failures that came from a callee (the walk, or
a retry deadline stop before re-push). After a call retry is scheduled, a later deadline stop
reports `RunError`/result on the call node in the caller frame, since callee frames were already
removed. Handled-failure log records carry the handling caller's `flow.id`.

**Invocation IDs.** Every node entry draws `${runID}:n`, including a `goto` node's own entry; the
frame replacement it triggers draws none, and neither do push, pop and unwind.

**Terminal kinds.** `NodeKind.terminal` lets custom kinds return `end`; other kinds returning
`end` fail with `invalid_value`. An uncompilable `suspend.schema` fails with `invalid_suspend`.

**Input decline edge.** `input.decline: { to }` plus a `decline` resume event (`reason` of
`decline` or `cancel`). Result `{ declined }`. Without the edge the node fails with
`invalid_suspend`.

**Unconstrained result paths.** `true`, annotation-only schemas and `additionalProperties: true`
accept any remaining path; local `$ref`s are followed; `anyOf`/`oneOf` are not walked.

**checkFlows.** Async preflight over the resolved flow set: `missing_flow`, `unbounded_cycle`,
`recursive_call`, `input_mismatch`, `invalid_result_path` (also through unversioned references,
against the version resolved at check time) and `unversioned_reference`. `start` runs it lazily on
the first `next()` for definitions with references: errors reject with `FlowDefinitionError` and
commit nothing; warnings do not block. The preflight reuses the root's local check from `start`
instead of checking the root again.

**Check results follow Standard Schema.** `graph.check` and `graph.checkFlows` return one
`FlowCheckResult`: `{ value, warnings }` when no issue is an error, else `{ issues }` holding every
issue, warnings included, in report order. `ok` is gone; callers test `result.issues`. Internal
checks (`DefinitionCheck`, the callee check cache, the preflight's reused local result) share the
type, and the cache hands out copies.

**FlowRun lifecycle.** `FlowRun.return()` ends the segment span without committing; later `next()`
calls return `done` with the current state. It is idempotent, safe before any `next()`, after a
rejected `next()` and after completion, and rejects while a `next()` is pending. A rejected lazy
preparation leaves the segment span open for a retry and records an `exception` event only with
`recordErrorMessages`, as node spans do; `return()` after such a failure ends the span with ERROR
and `error.type`, and a later successful preparation clears the failure. `graph.run()` calls
`return()` before rethrowing a rejected `next()`.

**Abort before resolution.** `FlowResolver.resolve` takes an optional `{ signal }`; the runtime
passes the run's signal on `resume`/`recover` resolution, the start preflight and push-time
resolution. An already aborted signal on the first `next()` commits `aborted` without resolving,
and a resolver rejection while the signal is aborted commits `aborted` instead of rejecting.

**Validator reuse.** Phase 1 compiles `pending.schema` through the graph's validator cache, so a
suspend schema compiles once per graph across suspend and resume, also after a JSON round trip.

## What was built

- Resolver, `createMapResolver`, `FlowReferenceError`, `maxDepth`, snapshot/prepare helpers.
- `call`, `goto` and flow-bodied `loop` node kinds; frame stack, push/replace/pop/unwind commits.
- Run state schema and invariants for multi-frame state; sync and lazy resume validation.
- `checkFlows`, local checker additions, terminal-kind reachability, unconstrained result paths.
- Input `decline` edge and resume event; `FlowNodeFailure` exported for custom kinds.
- Flow-aware tracing (`flow.id`, `flow.depth`) and log records.
- New tests: `references`, `call-failure`, `resolver`, `checker-flows`; existing suites updated.
- README, skill reference and `flow-graph-references` release intent.

## Deviations from the plan

- The `invocation` counter is 3 for `a -> b -> end`: it counts node entries, and the end node
  draws one.
- A push does not fire `node:enter`; only node entries do.
- `FlowNodeFailure` moved to `errors.ts` so it can be exported from the entry point.
- `issue` and `reads` modules were extracted from the checker to share with `checkFlows`.
- `checkFlows` lives in its own module and is reachable only as `graph.checkFlows`, not exported
  standalone.

`anyOf`/`oneOf` result path walking and static validation of arbitrary callee input schemas stay
out of scope.
