---
"@sozai/flow-graph": minor
---

Add an opt-in validators option to createFlowGraph that shares a host ValidatorCache for definition input, input-node, suspend and pending schemas. When set, internal loose compiles use a private bounded cache, createFlowGraph throws TypeError for non-JSON kind schemas, and a disposed host cache raises FlowGraphValidatorsError. FlowRun.next() after a finished run, including one ended by a rejected step, now resolves done with the current state instead of an undefined value.
