# @sozai/flow-graph

## 0.2.0

### Minor Changes

- Add flow references (call, goto, loop flow bodies) with a resolver (which receives the run's abort signal) and frame stack, an input decline edge, unconstrained result paths, checkFlows, and FlowRun.return(). The authoring schema compiles under Ajv strict mode. Breaking: resume/recover take no definition, storageSchema removed, and check/checkFlows return a Standard Schema result (`{ value, warnings }` or `{ issues }`) instead of `{ ok, issues }`.

## 0.1.0

### Patch Changes

- Updated dependencies:
  - @sozai/async@0.3.0
  - @sozai/json@0.2.0
