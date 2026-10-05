# @sozai/flow-graph

## 0.2.3

### Patch Changes

- Updated dependencies:
  - @sozai/async@0.4.0
  - @sozai/json@0.3.0
  - @sozai/log@0.4.0

## 0.2.1

### Patch Changes

- Add an opt-in validators option to createFlowGraph that shares a host ValidatorCache for definition input, input-node, suspend and pending schemas. When set, internal loose compiles use a private bounded cache, createFlowGraph throws TypeError for non-JSON kind schemas, and a disposed host cache raises FlowGraphValidatorsError. FlowRun.next() after a finished run, including one ended by a rejected step, now resolves done with the current state instead of an undefined value.

## 0.2.0

### Minor Changes

- Add flow references (call, goto, loop flow bodies) with a resolver (which receives the run's abort signal) and frame stack, an input decline edge, unconstrained result paths, checkFlows, and FlowRun.return(). The authoring schema compiles under Ajv strict mode. Breaking: resume/recover take no definition, storageSchema removed, and check/checkFlows return a Standard Schema result (`{ value, warnings }` or `{ issues }`) instead of `{ ok, issues }`.

## 0.1.0

### Patch Changes

- Updated dependencies:
  - @sozai/async@0.3.0
  - @sozai/json@0.2.0
