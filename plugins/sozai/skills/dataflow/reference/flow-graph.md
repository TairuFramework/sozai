# @sozai/flow-graph

Use `createFlowGraph()` for JSON flow definitions that can be checked, persisted, and resumed. It builds on `@sozai/flow`. Use `@sozai/flow` directly for code-defined state machines.

| Export | Purpose |
|---|---|
| `createFlowGraph` | Register built-in and custom kinds, actions, retry defaults, clock and runtime |
| `graph.authoringSchema` / `graph.storageSchema` | Executable-only and forward-compatible definition shapes |
| `graph.check` / `formatIssues` | Validate static graph rules and produce repair hints |
| `graph.start` / `graph.resume` / `graph.recover` | Yield durable `RunState` commits |
| `graph.run` | Consume a new run to suspension or completion |
| `defineNodeKind` | Preserve type inference for an extension kind |
| `evaluateFilter` / `resolveValue` | Evaluate the JSON filter and value languages |
| `runStateSchema` / `assertRunState` | Validate persisted run state |

See [the package README](../../../../../packages/flow-graph/README.md) for a run/resume example and persistence rules. Persist every yielded revision with optimistic concurrency. Execution is at least once.
