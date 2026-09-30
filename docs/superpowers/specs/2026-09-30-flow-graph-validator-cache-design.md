# flow-graph -- opt-in shared validator cache

**Status:** design approved · spec awaiting review
**Date:** 2026-09-30
**Packages:** `@sozai/flow-graph` (minor), `@sozai/schema` (joins its pending minor)
**Branch:** `feat/schema-validator-cache` (same PR as `createValidatorCache`, #19)

## Why

`createFlowGraph` compiles every schema through a private, unbounded map keyed by `JSON.stringify`
(`registry.ts:64`) on the shared `createValidator` AJV instances. Definitions come from a
`resolver`, so input, input-node, suspend and pending schemas are runtime data. A long-running
host that runs many distinct definitions grows AJV's generated code without bound -- the same
growth that made mokei recycle factories.

`@sozai/schema` now has `createValidatorCache`: a bounded LRU over recycled, isolated factories.
A host wants to hand flow-graph one such cache and use the same instance for its other schemas
(for example tool input schemas), so one bound covers everything.

**Success:** a host running unbounded distinct definitions keeps a bounded compile footprint, and
one cache instance serves flow-graph and the host's other consumers. A graph created without the
option behaves exactly as today.

## Key design decisions

**Opt-in, one injected cache.** `FlowGraphOptions.validators?: ValidatorCache`. Without it, the
graph uses today's compile path unchanged.

**The injected cache serves data schemas only.** Flow-graph compiles two classes of schema:

| Compile | `strict` today | Source |
|---|---|---|
| definition `input`, input-node `schema`, suspend `schema`, pending `schema` | AJV default (strict) | data (definitions, runs) |
| `kind.schema`, `authoringSchema` | `false` | registered kinds (finite) |
| `kind.resultSchema(node)` | `false` (path-only shapes) | derived per node (data-driven) |

A `ValidatorCache` has one set of factory options, so it cannot serve both a strict and a loose
class. The host's cache takes the data schemas, compiled with the host's draft and strictness.
Flow-graph's loose compiles go to a private `createValidatorCache({ factory: { strict: false } })`
the graph owns, created only when `validators` is set. The host shares one cache and never needs
to know flow-graph's internal split. Rejected: two injected caches (`{ strict, loose }`), which
leaks the split into the API; a `validatorFor` hook, which is not "inject a cache" and makes every
host compose one.

**Routing reuses the existing seam.** Every compile already goes through one
`validatorFor(schema, strict?)` function threaded to the checker, runner, resume check and state
check. Every data-schema call omits `strict`; every internal call passes `false`. Only the
function's construction in `runtime.ts` changes; no call site changes.

**The host owns the cache.** Flow-graph never calls `clear()` or `dispose()` on `validators`.
Validators are used at once and never held across runs, so recycling is safe.

**Non-JSON schemas: lifecycle decides the error.** `canonicalizeJSON` throws `TypeError` for
values that are not plain JSON (an `undefined` property, `toJSON`). Schemas supplied up front get
a `TypeError` at `createFlowGraph`; schemas supplied dynamically keep their existing issue or
failure:

| Schema | Arrives | Non-JSON with `validators` set |
|---|---|---|
| `kind.schema` (from `options.kinds`), and `authoringSchema` built from them | up front, `createFlowGraph` | `TypeError` from `createFlowGraph` naming the kind |
| definition `input`, input-node `schema` | per definition | unreachable: `check` rejects a non-JSON definition first (`isJSONValue`) |
| `kind.resultSchema(node)` | per node, at check time | existing `invalid_schema` issue on the node |
| suspend `schema` | per node result, at run time | unreachable: `requireJSON(result)` fails the node first with `invalid_value` (`run-execution.ts:168`) |
| pending `schema` | persisted `RunState` | existing `FlowStateError` from `assertRunStateShape` |

The up-front check runs only when `validators` is set: the default path tolerates `undefined`
properties as AJV does, and must not change.

**A disposed host cache fails loudly.** After the host disposes its cache, every data-schema
compile would throw `Validator cache is disposed`, which the existing catch sites would turn into
misleading `invalid_schema` issues or `invalid_suspend` failures. Instead:

1. `ValidatorCache` gains `readonly disposed: boolean` (`@sozai/schema`, unreleased, same PR).
2. Flow-graph's data-path wrapper throws `FlowGraphValidatorsError` ("Flow graph validator cache
   is disposed") when `validators.disposed`, before calling `get`.
3. Entry points check first: `check`, `start`, `resume` and `recover` throw it synchronously and
   `checkFlows` rejects with it when `validators.disposed`, before any work. A compile is not a
   reliable trigger on its own: `checkFlows` reuses cached callee check results (the `checked`
   digest map) and `recover` compiles nothing until `next()`.
4. Every catch site a data-schema compile can reach rethrows `FlowGraphValidatorsError`
   unchanged (list below), so a cache disposed after the entry point surfaces at the next
   data-schema compile. A run in progress rejects its iterator with it instead of failing or
   retrying the node, like a process interruption: the failed node span is closed, the segment
   records the error, and the last committed state stays `running` (its in-flight node counts as
   interrupted on `recover`) and can be recovered with a live cache. A run that reaches no further
   data-schema compile finishes normally.

## API

`@sozai/schema`:

```ts
export type ValidatorCache = {
  // ...existing members
  /** `true` once `dispose()` has been called. */
  readonly disposed: boolean
}
```

`@sozai/flow-graph`:

```ts
export type FlowGraphOptions = {
  // ...existing members
  /**
   * Shared validator cache for schemas that arrive with definitions and runs: definition
   * `input`, input-node `schema`, suspend and pending `schema`. Its factory options (draft,
   * strict) apply to those schemas. The graph never clears or disposes it. Default: compiles on
   * the shared `createValidator` instances, unbounded.
   */
  validators?: ValidatorCache
}

/** The injected validator cache was disposed while the graph still used it. */
export class FlowGraphValidatorsError extends Error {
  constructor() {
    super('Flow graph validator cache is disposed')

    this.name = 'FlowGraphValidatorsError'
  }
}
```

## Behaviour

`createFlowGraph(options)`:

- Without `validators`: `validatorFor` is today's function. Rename flow-graph's internal
  `createValidatorCache` (`registry.ts:64`) to `createValidatorLookup`, to avoid the clash with the
  `@sozai/schema` export; behaviour unchanged.
- With `validators`:
  1. For each registered kind (built-in and `options.kinds`), `isJSONValue(kind.schema)` or throw
     `TypeError` `Kind <key> schema is not JSON`, before building `authoringSchema`. (Built-in
     kinds and the built `authoringSchema` are plain JSON; checked with `isJSONValue`.)
  2. Create `loose = createValidatorCache({ factory: { strict: false } })`.
  3. `validatorFor(schema, strict)`: when `strict === false`, `loose.get(schema)`; otherwise, if
     `validators.disposed` throw `new FlowGraphValidatorsError()`, else `validators.get(schema)`.
  4. `check`, `checkFlows`, `start`, `resume` and `recover` first call an `assertValidators()`
     guard that throws `FlowGraphValidatorsError` when `validators.disposed` (`checkFlows` rejects).

Catch sites that rethrow `FlowGraphValidatorsError` (`if (error instanceof
FlowGraphValidatorsError) throw error` first in the catch):

- `checker.ts`: input-node `schema` (about line 493), definition `input` (about line 745). The
  loose sites (`kind.schema`, `resultSchema`, `authoringSchema`) never see it.
- `run-execution.ts`: suspend `schema` (about line 189).
- `state.ts`: pending `schema` (about line 284).
- `runtime.ts`: `validateShape` (about line 186) and `resolveFrames`' `preparePinned` catch
  (about line 209), which would otherwise wrap it in `FlowStateError`.
- `run-drive.ts`: both node-error catches (about lines 59 and 289), after the existing abort
  check (abort keeps precedence) and before `handleNodeError`, so it is neither retried nor
  recorded as a node failure. Before rethrowing, close the failed node span
  (`runner.closeFailedSpan`, which `run-execution.ts:223` leaves open for `handleNodeError`) and
  set `error.type` `FlowGraphValidatorsError` on the segment, which the drive loop's `finally`
  then ends with `flow.status` `running`. `run.ts`'s lazy-preflight catch already rethrows and
  records `error.type`.

Effects of opting in, documented for hosts:

- **Dialect and strictness** come from the host's cache: a `2020-12` cache compiles flow authors'
  schemas as 2020-12; a `strict: false` cache accepts unknown keywords that the default path
  reports as `invalid_schema`.
- **Issue order**: both caches compile snapshots, so `ValidationError` issues follow sorted key
  order. This affects `FlowInputError` and `FlowResumeError` issues, and `FlowCheckResult` issues
  from kind and authoring validation (loose cache).
- **Compile errors** are cached and rethrown by the host cache until evicted or recycled; the
  catch sites turn them into the same issues and failures as today.

## Tests

`@sozai/schema` (`test/cache.test.ts`): `disposed` is `false` on a new cache, `false` after
`clear()`, `true` after `dispose()`.

`@sozai/flow-graph` (new `test/validators.test.ts`):

- **Shared cache**: one host cache serves two graphs and a direct `get`; the same input schema used
  by both graphs and the host compiles once (`stats().compiles`).
- **Routing**: `check`, `start` and a suspend/resume cycle raise the host cache's `compiles` for the
  definition `input`, input-node `schema` and suspend/pending `schema`; checking a definition with
  no data schemas leaves it unchanged (kind, authoring and result schemas go elsewhere).
- **Host options apply**: with a host cache of `{ factory: { strict: false } }`, an input schema
  with an unknown keyword checks clean; with a default cache it is `invalid_schema`.
- **Bounded**: host cache `{ maxCompiles: 2 }`; checking five definitions with distinct input
  schemas leaves `generation > 0`, and every check succeeds.
- **Host owns the cache**: after checks and a full run, `disposed` is `false` and `get` works.
- **Disposed cache, entry points**: after `dispose()`, `check`, `start`, `resume` (on a suspended
  state) and `recover` (on a running state) each throw `FlowGraphValidatorsError` synchronously,
  and `checkFlows` rejects with it -- including a `checkFlows` of a definition whose callee check
  result was cached before disposal.
- **Disposed cache, mid-run**: a custom kind disposes the host cache and then suspends with a
  `schema`; the run's iterator rejects with `FlowGraphValidatorsError`, `getState().status` is
  `running`, the node span has ended with an error and the segment has `error.type`
  `FlowGraphValidatorsError` (in-memory span exporter). `recover` on that state with a graph over a
  live cache completes the run.
- **Up-front `TypeError`**: a kind whose schema has an `undefined` property makes
  `createFlowGraph({ validators, kinds })` throw `TypeError`; without `validators` the same kind
  registers and checks as today.
- **Issue order**: with `validators`, a definition failing kind validation on two properties
  reports issues in sorted key order.
- **Dynamic non-JSON**: a `resultSchema` returning a non-JSON schema gives `invalid_schema` on the
  node; a suspend `schema` with an `undefined` property fails the run with `invalid_value`
  (`requireJSON` runs before the compile), as it does without `validators`.
- **Default unchanged**: the existing suite passes with no change.

## Documentation

- `packages/flow-graph/README.md`: the `validators` option, with a short example of one host cache
  shared with another consumer; the routing table; the notes on dialect, strictness, issue order,
  ownership and `FlowGraphValidatorsError`.
- `plugins/sozai/skills/dataflow/reference/flow-graph.md`: add `validators` to the
  `createFlowGraph` row and `FlowGraphValidatorsError` to the errors line; one paragraph with the
  same notes.
- `packages/schema/README.md` and `plugins/sozai/skills/validation/reference/schema.md`: mention
  `disposed`.
- Change intents: `pnpm change @sozai/flow-graph --bump minor`; edit the existing `@sozai/schema`
  intent to add `disposed`.

## Out of scope

- Bounding the default path (no `validators`).
- Configuring the private loose cache's bounds.
- `@sozai/flow` and `@sozai/patch` compile paths.
