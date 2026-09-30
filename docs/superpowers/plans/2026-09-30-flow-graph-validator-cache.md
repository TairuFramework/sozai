# flow-graph Shared Validator Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host inject one `@sozai/schema` `ValidatorCache` into `createFlowGraph` for data schemas, shared with its other consumers, with a disposed cache failing loudly.

**Architecture:** flow-graph already routes every compile through one `validatorFor(schema, strict?)` function; with the new `validators` option, `runtime.ts` builds it so `strict === false` compiles go to a private loose `createValidatorCache` and everything else to the host cache. A new `FlowGraphValidatorsError` is thrown at entry points and by the data-path wrapper when `validators.disposed`, and rethrown through every catch site that could swallow it.

**Tech Stack:** TypeScript, `@sozai/schema` (`createValidatorCache`), `@sozai/json` (`isJSONValue`), OpenTelemetry (`InMemorySpanExporter` in tests), vitest, pnpm, turbo.

**Spec:** `docs/superpowers/specs/2026-09-30-flow-graph-validator-cache-design.md`. Read it before any task; it holds the routing table, the non-JSON lifecycle table and the catch-site list.

## Global Constraints

- Branch `feat/schema-validator-cache` (PR #19). Commit after each task; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Conventions: `/Users/paul/dev/yulsi/kigu/plugins/kigu/skills/conventions/SKILL.md`. British spelling in prose and comments, ` -- ` not em dashes, `JSON` not `Json`, blank line after function bodies, more than 3 args take a named params object.
- Reuse `createValidatorCache` from `@sozai/schema` and `isJSONValue` from `@sozai/json`; do not hand-roll either.
- Default path (no `validators`) must behave exactly as today; the existing flow-graph suite passes unchanged.
- Exact strings: `Flow graph validator cache is disposed`, error `name` `FlowGraphValidatorsError`, `Kind <key> schema is not JSON` (key is `kind.kind`), segment attribute `error.type` `FlowGraphValidatorsError`.
- Do not edit `lib/`. Run scripts as `rtk proxy pnpm ...`; a one-line rtk success from biome/tsc is a real pass.

## Review Focus

1. A host cache shared between two graphs where one graph's run recycles the cache mid-check: every check still succeeds (validators are used immediately). Test in Task 2 (`bounded`).
2. `strict: false` compiles never touch the host cache even when the host cache is disposed: `check` of a definition with no data schemas still throws `FlowGraphValidatorsError` (entry guard) rather than silently passing. Test in Task 3.
3. A call node whose callee has an input schema, run after disposal mid-run: the iterator rejects with `FlowGraphValidatorsError`, not `invalid_input`/`invalid_flow`. Test in Task 3.
4. Abort still wins: a run aborted while its cache is disposed commits `aborted`, not the validators error. Test in Task 3.
5. A kind registered with a non-JSON schema and no `validators` keeps working (default path tolerance). Test in Task 2.

---

### Task 1: `ValidatorCache.disposed`

**Files:**
- Modify: `packages/schema/src/cache.ts` (type and returned object)
- Test: `packages/schema/test/cache.test.ts`
- Modify: `.changeset/sour-kiwis-rule.md`, `packages/schema/README.md`, `plugins/sozai/skills/validation/reference/schema.md`

**Interfaces:**
- Produces: `ValidatorCache.disposed: boolean` (readonly getter), used by Task 2 and Task 3.

- [ ] **Step 1: Write the failing test** `disposed reflects lifecycle`: a new cache has `disposed === false`; after `clear()` still `false`; after `dispose()` `true`; after a second `dispose()` still `true`.

- [ ] **Step 2: Run** `rtk proxy pnpm --filter @sozai/schema exec vitest run test/cache.test.ts -t disposed` -- expected FAIL (`undefined`).

- [ ] **Step 3: Implement** `readonly disposed: boolean` on `ValidatorCache` with doc comment `` `true` once `dispose()` has been called. ``, as a getter over the existing closure flag.

- [ ] **Step 4: Docs and intent.** Append to the changeset summary sentence: `ValidatorCache.disposed reports whether dispose() has been called.` Mention `disposed` next to `dispose()` in the schema README and in `reference/schema.md`.

- [ ] **Step 5: Run** `rtk proxy pnpm --filter @sozai/schema test` -- expected PASS (unit and types).

- [ ] **Step 6: Commit** `git add packages/schema .changeset/sour-kiwis-rule.md plugins/sozai/skills/validation` -- message `Add ValidatorCache.disposed`.

---

### Task 2: `validators` option and routing

**Files:**
- Modify: `packages/flow-graph/src/types.ts` (`FlowGraphOptions`), `packages/flow-graph/src/registry.ts` (rename, kind JSON check), `packages/flow-graph/src/runtime.ts:56` (build `validatorFor`)
- Create: `packages/flow-graph/test/validators.test.ts`

**Interfaces:**
- Consumes: `ValidatorCache` and `createValidatorCache` from `@sozai/schema` (Task 1 adds `disposed`, not needed yet).
- Produces: `FlowGraphOptions.validators?: ValidatorCache` (doc comment verbatim from the spec's API section); `createValidatorLookup(): (schema: Schema, strict?: boolean) => Validator<unknown>` in `registry.ts` (renamed from `createValidatorCache`, body unchanged); in `runtime.ts` a module-private `createValidatorRouter(validators: ValidatorCache): (schema: Schema, strict?: boolean) => Validator<unknown>` that Task 3 extends with the disposed check.

- [ ] **Step 1: Write the failing tests** in `test/validators.test.ts`. Use `createValidatorCache` from `@sozai/schema` as the host cache and an extension kind like `test/extension.test.ts`'s `ask`, with `execute` returning `{ suspend: { schema: { type: 'string' } } }` where a suspend schema is needed.
  - `shared cache serves two graphs and the host`: host cache `H`; graphs A and B both with `{ validators: H }`; definitions on A and B with the same `input: { type: 'object', properties: { n: { type: 'number' } } }`; `A.check`, `B.check`, `H.get(sameSchema)`: `H.stats().compiles === 1`.
  - `data schemas go to the host cache`: separate fresh `H` per sub-case, asserting `H.stats().compiles` grows by 1 for: `check` of a definition with `input`; `check` of a definition with an input node `schema`; a run suspending with a `schema` (the suspend compile), and `resume` of it adds 0 (same schema, hit).
  - `internal schemas stay private`: `check` of a definition with only built-in and `ask` nodes (with `resultSchema`) and no data schemas leaves `H.stats()` all zero.
  - `host options apply`: input schema `{ type: 'object', unknownKeyword: true }`; with `H = createValidatorCache({ factory: { strict: false } })` `check` has no issues; with a default `H` the check reports code `invalid_schema` at path `['input']`.
  - `bounded` (Review Focus 1): `H = createValidatorCache({ maxCompiles: 2 })`, graphs A and B share it; alternate `check` on 5 definitions with distinct input schemas across A and B: every result has no issues and `H.stats().generation > 0`.
  - `graph never disposes the host cache`: after `check` and a full `run` to completion, `H.disposed === false` and `H.get({ type: 'string' })` works.
  - `non-JSON kind schema throws up front`: a kind whose `schema` has `description: undefined`; `createFlowGraph({ validators: H, kinds: [kind] })` throws `TypeError` `Kind <kind> schema is not JSON`.
  - `non-JSON kind schema without validators` (Review Focus 5): the same kind with `createFlowGraph({ kinds: [kind] })` registers, and a definition using it checks with no issues.
  - `non-JSON result schema`: a kind whose `resultSchema` returns `{ type: 'object', description: undefined }`; with `validators`, `check` reports `invalid_schema` at `['nodes', <id>]`.
  - `non-JSON suspend schema`: a kind suspending with `{ schema: { type: 'string', description: undefined } }`; with `validators`, the run fails with node failure code `invalid_value`.
  - `issue order follows sorted keys`: with `validators`, a node of `ask` missing `prompt` and with `next: 1` reports its kind-validation issue paths in sorted key order (`next` before `prompt`).

- [ ] **Step 2: Run** `rtk proxy pnpm --filter @sozai/flow-graph exec vitest run test/validators.test.ts` -- expected FAIL (option ignored; `compiles` stays 0).

- [ ] **Step 3: Implement.**
  - `types.ts`: add `validators?: ValidatorCache` with the spec's doc comment.
  - `registry.ts`: rename to `createValidatorLookup` (update the `runtime.ts` import); in `createKindRegistry`, when `options.validators !== undefined`, throw `new TypeError(`Kind ${kind.kind} schema is not JSON`)` for a kind whose `schema` fails `isJSONValue`, inside the existing registration loop.
  - `runtime.ts`: `const validatorFor = options.validators ? createValidatorRouter(options.validators) : createValidatorLookup()`. The router creates `loose = createValidatorCache({ factory: { strict: false } })` and returns `(schema, strict) => strict === false ? loose.get(schema) : validators.get(schema)`.

- [ ] **Step 4: Run** `rtk proxy pnpm --filter @sozai/flow-graph test` -- expected PASS, whole existing suite included.

- [ ] **Step 5: Commit** `git add packages/flow-graph` -- message `Add opt-in shared validator cache to flow-graph`.

---

### Task 3: Disposed host cache, docs and change intent

**Files:**
- Modify: `packages/flow-graph/src/errors.ts` (new class), `runtime.ts` (router check, entry guard, catch sites), `checker.ts`, `run-execution.ts`, `state.ts`, `run-drive.ts` (catch sites)
- Test: `packages/flow-graph/test/validators.test.ts`, `packages/flow-graph/test/tracing.test.ts`
- Modify: `packages/flow-graph/README.md`, `plugins/sozai/skills/dataflow/reference/flow-graph.md`
- Create (via `pnpm change`): `.changeset/<generated>.md`

**Interfaces:**
- Consumes: `ValidatorCache.disposed` (Task 1); `createValidatorRouter` (Task 2).
- Produces: exported `class FlowGraphValidatorsError extends Error` (constructor with no parameters, message and `name` as in Global Constraints), exported from `src/index.ts` through `errors.ts`.

- [ ] **Step 1: Write the failing tests.** In `validators.test.ts`, `describe('disposed host cache')`, each with a fresh `H` disposed after graph creation unless stated:
  - `entry points throw`: `check(def)`, `start({ definition })`, `resume({ runState: suspended, event })`, `recover({ runState: running })` each throw `FlowGraphValidatorsError` synchronously (`expect(() => ...).toThrow(FlowGraphValidatorsError)`); `checkFlows(def)` rejects with it. Obtain `suspended` and `running` states from runs made before `H.dispose()`.
  - `entry guard covers data-free definitions` (Review Focus 2): `check` of a definition with no data schemas throws `FlowGraphValidatorsError`.
  - `cached callee result does not bypass the guard`: `checkFlows` of a definition calling a callee succeeds once, `H.dispose()`, the same `checkFlows` rejects with `FlowGraphValidatorsError`.
  - `mid-run call to a callee with input` (Review Focus 3): a kind disposes `H` in its first `execute` and returns `{ next }` to a `call` node whose callee has an `input` schema; the run iterator rejects with `FlowGraphValidatorsError`.
  - `abort wins` (Review Focus 4): a kind disposes `H`, aborts the run's controller, then suspends with a `schema`; the run commits `aborted` and the iterator does not reject.
  - `error name`: `new FlowGraphValidatorsError()` has `name` `FlowGraphValidatorsError` and message `Flow graph validator cache is disposed`.

  In `tracing.test.ts`, using its exporter setup: `disposed cache mid-run closes the node span`: a kind that on its first `execute` disposes `H` and suspends with `{ schema: { type: 'string' } }`, on later calls returns `{ next: 'end' }`. The run iterator rejects with `FlowGraphValidatorsError`; `getState().status === 'running'`; the node span is ended with error status; the segment span has `error.type` `FlowGraphValidatorsError` and `flow.status` `running`. `recover` on `getState()` with a new graph over a live cache drains to `completed` (under the existing in-flight recovery rules; if a non-retrying in-flight node does not re-execute on `recover`, report it instead of changing recovery).

- [ ] **Step 2: Run** `rtk proxy pnpm --filter @sozai/flow-graph exec vitest run test/validators.test.ts test/tracing.test.ts` -- expected FAIL (class missing; errors surface as `invalid_*`).

- [ ] **Step 3: Implement.**
  - `errors.ts`: the class, after the existing errors, doc comment `The injected validator cache was disposed while the graph still used it.`
  - `runtime.ts`: the router throws `new FlowGraphValidatorsError()` before `validators.get` when `validators.disposed`; a local `assertValidators()` (no-op without `validators`) called first in `check`, `checkFlows` (so it rejects), `start`, `resume` and `recover`.
  - Rethrow `if (error instanceof FlowGraphValidatorsError) throw error` first in each catch the spec lists: `checker.ts` input-node schema and definition `input`; `run-execution.ts` suspend schema; `state.ts` pending schema; `runtime.ts` `validateShape` and `resolveFrames`' `preparePinned` catch. Catches that bind no variable become `catch (error)`.
  - `run-drive.ts`, both node-error catches: after the abort check, if the error is a `FlowGraphValidatorsError`, call `runner.closeFailedSpan(() => {})`, set the segment's `error.type` to `FlowGraphValidatorsError` through a new `FlowRunner` method `markSegmentError(type: string): void` in `run.ts` (sets the attribute on `#segment`), then rethrow.

- [ ] **Step 4: Run** `rtk proxy pnpm --filter @sozai/flow-graph test` -- expected PASS.

- [ ] **Step 5: Docs.** Per the spec's Documentation section: README gets the `validators` option with a short example (one `createValidatorCache()` passed to `createFlowGraph({ validators })` and also used by the host for another schema), the routing table, and notes on dialect and strictness, issue order, ownership and `FlowGraphValidatorsError`; `reference/flow-graph.md` adds `validators` to the `createFlowGraph` row, `FlowGraphValidatorsError` to the errors line, and one paragraph of the same notes.

- [ ] **Step 6: Change intent.** `rtk proxy pnpm change @sozai/flow-graph --bump minor --summary "<summary>"` listing: opt-in `validators` option sharing a host `ValidatorCache` for definition, input-node, suspend and pending schemas; internal loose compiles on a private bounded cache when set; `TypeError` for non-JSON kind schemas when set; `FlowGraphValidatorsError` when the host cache is disposed.

- [ ] **Step 7: Full checks.** `rtk proxy pnpm run lint` and `rtk proxy pnpm run test` from the repo root -- expected PASS.

- [ ] **Step 8: Commit** `git add packages/flow-graph plugins/sozai/skills/dataflow .changeset` -- message `Fail loudly on a disposed flow-graph validator cache`.

---

### After the tasks

Run `kigu:complete` for this plan (completion record without follow-ons; delete this plan and spec), then push to PR #19 and update its description to cover flow-graph.
