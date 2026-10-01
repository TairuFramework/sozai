# flow-graph -- opt-in shared validator cache

**Status:** complete
**Date:** 2026-09-30
**Packages:** `@sozai/flow-graph` (minor intent), `@sozai/schema` (joins its pending minor)
**Builds on:** [schema validator cache](./2026-09-30-schema-validator-cache.complete.md)

## Why

`createFlowGraph` compiled every schema through a private, unbounded map on the shared
`createValidator` AJV instances. Definitions come from a `resolver`, so input, input-node, suspend
and pending schemas are runtime data: a long-running host running many distinct definitions grew
AJV's generated code without bound. A host wants to hand flow-graph one bounded
`createValidatorCache` and use the same instance for its other schemas (for example tool input
schemas), so one bound covers everything.

## Key design decisions

**Opt-in, one injected cache.** `FlowGraphOptions.validators?: ValidatorCache`. Without it, the
graph compiles exactly as before (flow-graph's internal lookup was renamed `createValidatorLookup`
to avoid clashing with the `@sozai/schema` export).

**The injected cache serves data schemas only.** A `ValidatorCache` has one set of factory options,
so it cannot serve both flow-graph's strict data schemas and its loose internal compiles. Data
schemas (definition `input`, input-node, suspend and pending `schema`) go to the host cache with
the host's draft and strictness. Kind `schema`, `authoringSchema` and `resultSchema` compiles
(`strict: false`) go to a private `createValidatorCache({ factory: { strict: false } })` the graph
owns. Routing reuses the existing `validatorFor(schema, strict?)` seam; no call site changed.
Rejected: two injected caches (leaks the split into the API) and a `validatorFor` hook (makes every
host compose one).

**The host owns the cache.** The graph never clears or disposes it. Validators are used at once and
never held, so recycling mid-run is safe.

**Non-JSON schemas: lifecycle decides the error.** With `validators`, schemas supplied up front
(registered kind schemas) must be plain JSON: `createFlowGraph` throws `TypeError`
`Kind <kind> schema is not JSON`. Dynamically supplied schemas keep their existing issue or failure
(`invalid_schema` for a result schema, `invalid_value` for a suspend result, `FlowStateError` for
a pending schema). The default path still tolerates `undefined` properties.

**A disposed host cache fails loudly.** `ValidatorCache` gained `disposed`. Entry points (`check`,
`checkFlows`, `start`, `resume`, `recover`) throw `FlowGraphValidatorsError` first, because cached
callee check results and lazy recovery would otherwise skip the compile. Every catch site a
data-schema compile can reach rethrows it instead of turning it into an `invalid_*` issue or node
failure. A run in progress is interrupted like a process crash: `FlowRunner.interrupt` closes the
failed node span as an error, marks the segment with `error.type`, and rethrows without
committing. A `running` state continues with `recover`; an interrupted resume segment stays
`suspended` and continues with `resume` and the same event. Abort keeps precedence.

**Effects of opting in:** dialect and strictness come from the host cache, and validation issues
follow sorted key order (both caches compile canonical snapshots).

## What was built

- `ValidatorCache.disposed` in `@sozai/schema`, with a test, docs and a line in its change intent.
- `validators` option, router, kind JSON check, `FlowGraphValidatorsError`, entry guards, catch-site
  rethrows and `FlowRunner.interrupt` in `@sozai/flow-graph`.
- `test/validators.test.ts` (sharing, routing, host options, bounding, ownership, non-JSON cases,
  issue order, disposal at entry points, mid-run, resume segments and abort) and a span and
  recovery test in `test/tracing.test.ts`.
- README "Shared validator cache" section, `sozai:dataflow` reference update, minor change intent.
- `FlowRun.next()` after a finished run (completion or a rejected step) resolves `done` with the
  current state, with a test after an interrupted resume.
