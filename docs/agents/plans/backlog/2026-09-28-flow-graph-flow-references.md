# flow-graph -- flow references

**Status:** open · follow-on of [flow-graph v1](../completed/2026-09-28-flow-graph-package.complete.md)
**Package:** `@sozai/flow-graph`

## Why

v1 runs one flow per run. Flows cannot call or hand over to other flows. The storage schema and
`RunState` frames already accept the reserved shapes, so stored definitions written for this
version still parse today. The authoring schema rejects them with the `unsupported` issue.

## Scope

- `FlowResolver`: `resolve(id, version?) => FlowDefinition`, plus an in-memory map helper, passed
  as `createFlowGraph({ resolver })`.
- `call`: `{ flow, version?, input?: Record<string, Value>, next, onError?, retry? }`, with
  `retries: true`.
- `goto`: `{ flow, version?, input?: Record<string, Value> }`.
- `loop.body: { flow, version? }`.

## Frame semantics

- `call` pushes a frame with `continuation = { kind: 'call', callerNode, returnTo: call.next,
  onError: call.onError }`. On the callee's `end`, the frame pops. The frame below receives
  `results.<callerNode> = { ...end.output, $outcome: end.outcome }` and continues at `returnTo`.
  Nested calls unwind one frame at a time.
- `goto` replaces the top frame and keeps its `continuation`, so a `goto` inside a called flow still
  returns to the original caller.
- A callee error pops the frame and goes to `continuation.onError` with
  `results.<callerNode> = { error: ... }`. Without `onError` it propagates to the next frame down.
- Unversioned references resolve at push time. The frame pins the resolved `version` and `digest`,
  so resume never re-resolves a moving reference.
- `loop.body: { flow }` pushes with `continuation = { kind: 'loopBody', callerNode: <loop id>,
  returnTo: <loop id> }`. The body output lands in `results.<loop id>`.

## Checker

The checker spans the resolved flow set: missing references, call cycles (recursion allowed only
under a `maxDepth`), and input/output mismatches between caller and callee.

## Also consider

- Silence the expected `console.error` fallback in flow-graph tests, which prints about 18
  `Flow run failed` lines per run.
