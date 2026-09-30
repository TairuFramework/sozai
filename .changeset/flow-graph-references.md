---
"@sozai/flow-graph": minor
---

Add flow references (call, goto, loop flow bodies) with a resolver (which receives the run's abort signal) and frame stack, an input decline edge, unconstrained result paths, checkFlows, and FlowRun.return(). Breaking: resume/recover take no definition, storageSchema removed, and check/checkFlows return a Standard Schema result (`{ value, warnings }` or `{ issues }`) instead of `{ ok, issues }`.
