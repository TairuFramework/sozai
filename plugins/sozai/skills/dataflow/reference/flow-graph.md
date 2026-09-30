# @sozai/flow-graph

Use `createFlowGraph()` for JSON flow definitions that can be checked, persisted, and resumed. Node kinds execute directly. Use `@sozai/flow` for code-defined state machines.

| Export | Purpose |
|---|---|
| `createFlowGraph` | Register built-in and custom kinds, actions, retry defaults, resolver, `maxDepth`, shared `validators` cache, clock and runtime |
| `createMapResolver` | In-memory `FlowResolver`; unversioned lookup returns the highest version |
| `graph.authoringSchema` | Definition shape for editors and model generation |
| `graph.check` / `formatIssues` | Validate local static graph rules and produce repair hints; returns a `FlowCheckResult` |
| `graph.checkFlows` | Async cross-flow check: resolves `call`/`goto`/loop body references; returns a `FlowCheckResult` |
| `graph.start` / `graph.resume` / `graph.recover` | Yield durable `RunState` commits; `FlowRun.return()` ends a segment without committing |
| `graph.run` | Consume a new run to suspension or completion |
| `defineNodeKind` | Preserve type inference for an extension kind |
| `evaluateFilter` / `resolveValue` | Evaluate the JSON filter and value languages |
| `runStateSchema` / `assertRunState` | Validate persisted run state |

See [the package README](../../../../../packages/flow-graph/README.md) for a run/resume example and persistence rules. Persist every yielded revision with optimistic concurrency. Execution is at least once.

`call`, `goto` and `loop.body: { flow }` reference other flows through a resolver, which receives the run's abort `signal`; `resume`/`recover` take no `definition` and resolve every pinned frame. `input` accepts a `decline` edge.

`FlowCheckResult` is a Standard Schema result: `{ value, warnings }` when no issue is an error, else `{ issues }` with every issue, warnings included. Test `result.issues`; there is no `ok`.

`FlowDefinitionError`, `FlowInputError`, `FlowStateError`, and `FlowResumeError` expose Standard Schema compatible `issues` with paths. `FlowReferenceError` is a resolver miss and `FlowVersionMismatchError` a changed pinned definition. Custom kinds raise engine failure codes with `FlowNodeFailure`. `FlowGraphValidatorsError` means the injected `validators` cache was disposed. State invariant issues use fixed messages without payload values.

`validators` takes a `@sozai/schema` `createValidatorCache()` shared with the host's other schemas, bounding compiles for runtime definitions. It compiles the definition `input`, input-node, suspend and pending schemas with the cache's draft and strictness; kind, authoring and result schemas use a private bounded loose cache. Issues then follow sorted key order, and kind schemas must be plain JSON (`TypeError` at `createFlowGraph`). The graph never clears or disposes the cache; after the host disposes it, entry points throw `FlowGraphValidatorsError` and a run in progress rejects with it, leaving a `running` state to `recover`.
