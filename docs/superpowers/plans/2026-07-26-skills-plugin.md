# sozai Skills Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package sozai's six domain-skill documents as a Claude Code plugin so `/sozai:discover` and the five domain skills actually resolve, with reference content split per package and verified against source.

**Architecture:** A `plugins/sozai/` plugin mirroring `../enkaku/plugins/enkaku/`, registered through a repo-root `.claude-plugin/marketplace.json` and `.claude/settings.json`. Each domain ships a thin routing `SKILL.md` plus per-package `reference/*.md` files carved out of the existing `docs/reference/*.md`. `docs/skills/` and `docs/reference/` are deleted at the end; the plugin becomes the single home for both.

**Tech Stack:** Markdown, JSON, Claude Code plugin manifests. Node for the verification scripts, `tsc` (via `pnpm exec`) for type-checking extracted code samples.

**Spec:** [`docs/superpowers/specs/2026-07-26-skills-plugin-design.md`](../specs/2026-07-26-skills-plugin-design.md)

**Branch:** `docs/skills-plugin` (already created, spec already committed)

## Global Constraints

Every task's requirements implicitly include this section.

- **120-line cap on every Markdown file under `plugins/sozai/`.** No exceptions. Over cap → split into `reference/<package>-<topic>.md` and index the parts from the domain `SKILL.md`.
- **Frontmatter names are bare.** `name: dataflow`, never `name: sozai:dataflow` — the plugin supplies the namespace, and the prefix would yield `/sozai:sozai:dataflow`.
- **No code blocks in any `SKILL.md`.** All code lives in `reference/*.md`. `SKILL.md` is index and routing only.
- **No outward cross-repo references.** No `/enkaku:*`, `/kokuin:*`, or `/kumiai:*` in any plugin file. sozai is the bottom of the stack; routing upward inverts the dependency graph. Verified: the current `docs/skills/` and `docs/reference/` contain zero such links, so this is a guard against adding one.
- **The reference file is the single home for code.** A "Key Patterns" block in an old `docs/skills/*.skill.md` is either already covered by the matching reference file (drop it) or is not (port it in). Nothing is discarded without being folded somewhere.
- **Content is verified against `packages/*/src` before it ships.** Every import resolves to a real export; every call signature matches the real type; no invented options. Type-checking is the mechanism for imports and signatures; prose claims need eyes on source.
- **Domain `SKILL.md` target is ≤50 lines** (the 120 cap is the hard limit, not the target).

## Deviations from the spec, flagged

Two, both deliberate. Raise them at review if either is unwanted.

1. **Finer splits than the spec estimated.** The spec predicted 2-way splits of `otel`, `result`, and `lock` (18 reference files, 24 total). Measuring the actual subsection boundaries gives cleaner 3-way splits for `otel` and `result`: **20 reference files, 26 total**. The spec's rule is the 120-line cap; the "expected splits" line was an estimate, and the cap still governs.
2. **A checker script is added to the repo** (`scripts/check-skills.mjs` + a `check:skills` npm script). The spec states the cap as a constraint but names no mechanism to enforce it after the branch lands. Roughly 40 lines, no dependencies. Drop it if unwanted — the plan's checks would then have to be run by hand.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `.claude-plugin/marketplace.json` | Repo-root marketplace listing the one plugin |
| `.claude/settings.json` (modify) | Register the marketplace (github source), enable `sozai@sozai` |
| `plugins/sozai/.claude-plugin/plugin.json` | Plugin manifest |
| `scripts/check-skills.mjs` | Enforces cap, bare names, no code in SKILL.md, no outward refs, no dangling reference pointers, no invented `@sozai/*` package names |
| `plugins/sozai/skills/discover/SKILL.md` | Entry-point router across the five domains |
| `plugins/sozai/skills/validation/` | `SKILL.md` + `reference/{schema,codec}.md` |
| `plugins/sozai/skills/primitives/` | `SKILL.md` + `reference/{result,result-option,result-async,patch}.md` |
| `plugins/sozai/skills/observability/` | `SKILL.md` + `reference/{log,otel,otel-propagation,otel-log-bridge}.md` |
| `plugins/sozai/skills/runtime/` | `SKILL.md` + `reference/{runtime,runtime-expo,lock,lock-semantics}.md` |
| `plugins/sozai/skills/dataflow/` | `SKILL.md` + `reference/{stream,async,event,flow,generator,execution}.md` |

**Deleted at the end:** `docs/skills/` (6 files), `docs/reference/` (5 files).

**Modified:** `docs/index.md`, `docs/agents/plans/roadmap.md`, `docs/agents/plans/backlog/2026-07-24-package-skills-as-plugin.md`, `.gitignore`, `package.json`.

### Source line ranges

Exact, measured. Use these when carving `docs/reference/*.md` apart. Line numbers are 1-indexed and inclusive.

**`docs/reference/dataflow.md`** (428 lines)

| Range | Section | Lines | Destination |
|---|---|---|---|
| 5-17 | `## Packages` | 13 | folds into `dataflow/SKILL.md` |
| 18-89 | `## @sozai/stream` | 72 | `dataflow/reference/stream.md` |
| 90-155 | `## @sozai/async` | 66 | `dataflow/reference/async.md` |
| 156-211 | `## @sozai/event` | 56 | `dataflow/reference/event.md` |
| 212-276 | `## @sozai/flow` | 65 | `dataflow/reference/flow.md` |
| 277-339 | `## @sozai/generator` | 63 | `dataflow/reference/generator.md` |
| 340-417 | `## @sozai/execution` | 78 | `dataflow/reference/execution.md` |
| 418-428 | `## When to Use` | 11 | folds into `dataflow/SKILL.md` |

**`docs/reference/validation.md`** (174 lines)

| Range | Section | Lines | Destination |
|---|---|---|---|
| 5-13 | `## Packages` | 9 | folds into `validation/SKILL.md` |
| 14-85 | `## @sozai/schema` | 72 | `validation/reference/schema.md` |
| 86-150 | `## @sozai/codec` | 65 | `validation/reference/codec.md` |
| 151-167 | `## When to Use` | 17 | folds into `validation/SKILL.md` |
| 168-174 | `## See Also` | 7 | folds into `validation/SKILL.md` |

**`docs/reference/primitives.md`** (237 lines)

| Range | Section | Lines | Destination |
|---|---|---|---|
| 5-13 | `## Packages` | 9 | folds into `primitives/SKILL.md` |
| 14-15 | `## @sozai/result` header | 2 | preamble for `result.md` |
| 16-67 | `### Result` | 52 | `primitives/reference/result.md` |
| 68-110 | `### Option` | 43 | `primitives/reference/result-option.md` |
| 111-161 | `### AsyncResult` | 51 | `primitives/reference/result-async.md` |
| 162-231 | `## @sozai/patch` | 70 | `primitives/reference/patch.md` |
| 232-237 | `## When to use` | 6 | folds into `primitives/SKILL.md` |

**`docs/reference/observability.md`** (214 lines)

| Range | Section | Lines | Destination |
|---|---|---|---|
| 5-15 | `## Packages` | 11 | folds into `observability/SKILL.md` |
| 16-53 | `## @sozai/log` | 38 | `observability/reference/log.md` |
| 54-59 | `## @sozai/otel` + `### Exports` header | 6 | preamble for `otel.md` |
| 60-71 | `#### Tracing` | 12 | `observability/reference/otel.md` |
| 72-79 | `#### Context propagation` | 8 | `observability/reference/otel-propagation.md` |
| 80-92 | `#### Baggage` | 13 | `observability/reference/otel-propagation.md` |
| 93-103 | `#### W3C headers` | 11 | `observability/reference/otel-propagation.md` |
| 104-110 | `#### Semantic constants` | 7 | `observability/reference/otel.md` |
| 111-117 | `#### ID validation` | 7 | `observability/reference/otel.md` |
| 118-124 | `#### Bridge (@sozai/log ↔ OTel)` | 7 | `observability/reference/otel-log-bridge.md` |
| 125-135 | `#### Re-exports from @opentelemetry/api` | 11 | `observability/reference/otel.md` |
| 136-155 | `### Example — tracer and span` | 20 | `observability/reference/otel.md` |
| 156-184 | `### Example — W3C context propagation` | 29 | `observability/reference/otel-propagation.md` |
| 185-208 | `### Example — log/trace bridge` | 24 | `observability/reference/otel-log-bridge.md` |
| 209-214 | `## When to use` | 6 | folds into `observability/SKILL.md` |

Resulting sizes: `otel.md` ≈ 63, `otel-propagation.md` ≈ 61, `otel-log-bridge.md` ≈ 31. All under cap.

**`docs/reference/runtime.md`** (286 lines)

| Range | Section | Lines | Destination |
|---|---|---|---|
| 6-15 | `## Packages` | 10 | folds into `runtime/SKILL.md` |
| 16-66 | `## @sozai/runtime` | 51 | `runtime/reference/runtime.md` |
| 67-115 | `## @sozai/runtime-expo` | 49 | `runtime/reference/runtime-expo.md` |
| 116-160 | `## @sozai/lock` header + `### Exports` + `### Usage` | 45 | `runtime/reference/lock.md` |
| 161-262 | the four bolded semantics blocks (boot ID, fallback path, reboot recovery, pid recycling) | 102 | `runtime/reference/lock-semantics.md` |
| 263-279 | `## When to Use` | 17 | folds into `runtime/SKILL.md` |
| 280-286 | `## See Also` | 7 | folds into `runtime/SKILL.md` |

Note `skills/runtime/reference/runtime.md` — a package named after its domain. Not a collision; the path is unambiguous.

---

### Task 1: Plugin wiring and the checker

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/sozai/.claude-plugin/plugin.json`
- Create: `scripts/check-skills.mjs`
- Modify: `.claude/settings.json`
- Modify: `package.json` (add `check:skills` script)
- Modify: `.gitignore` (add `.skill-check`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm exec node scripts/check-skills.mjs` — exits 0 when every structural rule holds, 1 with a per-violation report otherwise. Every later task runs it. The `plugins/sozai/skills/` directory it walks does not exist yet, which is what makes it fail in Step 2.

- [ ] **Step 1: Write the checker**

Create `scripts/check-skills.mjs`:

```javascript
#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'plugins/sozai/skills'
const CAP = 120
const failures = []

const realPackages = new Set(
  readdirSync('packages').map(
    (d) => JSON.parse(readFileSync(join('packages', d, 'package.json'), 'utf8')).name,
  ),
)

const mdFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? mdFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  )

if (!existsSync(ROOT)) {
  console.error(`missing ${ROOT}`)
  process.exit(1)
}

const skills = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

for (const file of mdFiles(ROOT)) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').length
  if (lines > CAP) failures.push(`${file}: ${lines} lines, cap is ${CAP}`)
  const outward = text.match(/\/(enkaku|kokuin|kumiai):[a-z-]+/g)
  if (outward) failures.push(`${file}: outward reference ${[...new Set(outward)].join(', ')}`)
  for (const named of new Set(text.match(/@sozai\/[a-z0-9-]+/g) ?? [])) {
    if (!realPackages.has(named)) failures.push(`${file}: no such package ${named}`)
  }
}

for (const skill of skills) {
  const file = join(ROOT, skill, 'SKILL.md')
  if (!existsSync(file)) {
    failures.push(`${file}: missing`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fm) {
    failures.push(`${file}: no frontmatter`)
    continue
  }
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  if (name !== skill) failures.push(`${file}: name is "${name}", expected "${skill}"`)
  if (!fm[1].match(/^description:\s*\S/m)) failures.push(`${file}: no description`)
  const body = text.slice(fm[0].length)
  if (/^```/m.test(body)) failures.push(`${file}: contains a code block`)
  for (const [, target] of body.matchAll(/`(reference\/[a-z0-9-]+\.md)`/g)) {
    if (!existsSync(join(ROOT, skill, target))) failures.push(`${file}: dangling pointer ${target}`)
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log(`PASS ${mdFiles(ROOT).length} file(s), ${skills.length} skill(s)`)
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node scripts/check-skills.mjs
```

Expected: `missing plugins/sozai/skills`, exit 1. Nothing has been created yet — this is the point.

- [ ] **Step 3: Create the marketplace manifest**

Create `.claude-plugin/marketplace.json`:

```json
{
  "name": "sozai",
  "owner": { "name": "Paul Le Cam" },
  "plugins": [
    {
      "name": "sozai",
      "source": "./plugins/sozai",
      "description": "Sozai core-utility discovery and domain skills."
    }
  ]
}
```

- [ ] **Step 4: Create the plugin manifest**

Create `plugins/sozai/.claude-plugin/plugin.json`:

```json
{
  "name": "sozai",
  "version": "0.1.0",
  "description": "Sozai core-utility skills: dataflow, validation, runtime, observability, and primitives.",
  "author": { "name": "Paul Le Cam" }
}
```

- [ ] **Step 5: Register the marketplace**

Modify `.claude/settings.json` to read exactly:

```json
{
  "extraKnownMarketplaces": {
    "kigu": {
      "source": {
        "source": "github",
        "repo": "TairuFramework/kigu"
      },
      "autoUpdate": true
    },
    "sozai": {
      "source": {
        "source": "github",
        "repo": "TairuFramework/sozai"
      },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "kigu@kigu": true,
    "sozai@sozai": true
  }
}
```

The `github` source is forced, not stylistic: relative marketplace sources are not supported from `extraKnownMarketplaces`, only through a manual `/plugin marketplace add`, which checked-in configuration cannot rely on.

- [ ] **Step 6: Wire the npm script and gitignore**

Add to `package.json` `scripts`, in alphabetical position (between `changeset` and `clean`):

```json
    "check:skills": "node scripts/check-skills.mjs",
```

Append to `.gitignore`:

```
.skill-check
```

- [ ] **Step 7: Verify the manifests parse**

```bash
node -e "for (const f of ['.claude-plugin/marketplace.json','plugins/sozai/.claude-plugin/plugin.json','.claude/settings.json','package.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok '+f) }"
```

Expected: four `ok` lines.

- [ ] **Step 8: Confirm the checker still fails, for the right reason**

```bash
node scripts/check-skills.mjs
```

Expected: still `missing plugins/sozai/skills`, exit 1. No skills exist yet. Task 2 is what first turns this green.

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin/marketplace.json plugins/sozai/.claude-plugin/plugin.json scripts/check-skills.mjs .claude/settings.json package.json .gitignore
git commit -m "chore: scaffold the sozai skills plugin and its structural checker"
```

---

### Task 2: Validation domain, and the type-check harness

Smallest domain (2 packages, no splits), so it proves the whole recipe — extract, fold, write `SKILL.md`, type-check, commit — before the harder ones.

**Files:**
- Create: `plugins/sozai/skills/validation/SKILL.md`
- Create: `plugins/sozai/skills/validation/reference/schema.md`
- Create: `plugins/sozai/skills/validation/reference/codec.md`
- Create: `.skill-check/tsconfig.json` (gitignored, not committed)
- Source: `docs/reference/validation.md`, `docs/skills/validation.skill.md`

**Interfaces:**
- Consumes: `scripts/check-skills.mjs` from Task 1.
- Produces: `.skill-check/tsconfig.json`, the type-check harness every later domain task reuses. Command: `pnpm exec tsc -p .skill-check/tsconfig.json`.

- [ ] **Step 1: Build the declaration files the harness resolves against**

```bash
pnpm run build:types
```

Expected: `15 successful, 15 total`. The harness maps `@sozai/*` to `packages/*/lib/index.d.ts`, which only exist after this runs. (Per the machine notes, if an `rtk` shim intercepts `pnpm run`, use `rtk proxy pnpm run build:types`.)

- [ ] **Step 2: Create the type-check harness**

Create `.skill-check/tsconfig.json`:

```json
{
  "extends": "@kigu/dev/tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"],
    "lib": ["es2025", "esnext.disposable", "dom"],
    "paths": { "@sozai/*": ["../packages/*/lib/index.d.ts"] }
  },
  "include": ["**/*.ts"]
}
```

Three details that are load-bearing, all established by testing: `paths` must point at `lib/index.d.ts` rather than the package directory (under `moduleResolution: nodenext` the packages' `exports` field has no `types` condition, so directory mapping fails to resolve); `baseUrl` must be absent (deprecated, errors under this TypeScript); `lib` needs `dom` for Web Streams and `esnext.disposable` for `Disposable`/`AsyncDisposable`.

- [ ] **Step 3: Prove the harness catches a real error**

Create `.skill-check/probe.ts`:

```typescript
import { Deferred } from '@sozai/async'
const d = new Deferred<number>()
void d
```

Run:

```bash
pnpm exec tsc -p .skill-check/tsconfig.json
```

Expected: FAIL — `error TS2693: 'Deferred' only refers to a type, but is being used as a value here.` This is the exact class of error the pass exists to catch: `@sozai/async` exports `defer()`, not a `Deferred` constructor. Delete the probe afterward: `rm .skill-check/probe.ts`

- [ ] **Step 4: Extract the two reference files**

Copy `docs/reference/validation.md` lines 14-85 into `plugins/sozai/skills/validation/reference/schema.md`, and lines 86-150 into `plugins/sozai/skills/validation/reference/codec.md`.

In each file, promote the heading: the source section starts `## @sozai/schema`, and in its own file that becomes `# @sozai/schema` with all nested headings promoted one level (`###` → `##`, `####` → `###`). Content is otherwise copied verbatim — this step is a move, not a rewrite. No frontmatter: reference files are not skills.

- [ ] **Step 5: Merge any unique patterns from the old skill file**

Read `docs/skills/validation.skill.md`. For each `### Pattern N:` block, find the matching `### Example` in the new reference file. Decision rule: if the reference file already demonstrates the same API in the same way, drop the skill's copy; if the pattern shows something the reference does not (a different entry point, an error path, a composition), port it into the matching reference file as a new `## Example: <name>` section.

Record which patterns were dropped and which were ported — the commit message names them.

- [ ] **Step 6: Write the domain skill**

Create `plugins/sozai/skills/validation/SKILL.md`. Fold in `docs/reference/validation.md` lines 5-13 (`## Packages`) as the package list, lines 151-167 (`## When to Use`) as `## Pick this when`, and lines 168-174 (`## See Also`) as `## Related` — rewritten to point at sibling `/sozai:*` skills, never outward.

```markdown
---
name: validation
description: Use when validating data against JSON Schema or encoding and decoding messages in sozai.
---

# Sozai validation

Schema validation and encoding. JSON Schema with compile-time type generation, plus the
encoding and decoding primitives that move validated values across a boundary.

## Packages

- **@sozai/schema** — JSON Schema validation with type generation (`Schema`, `FromSchema`). → `reference/schema.md`
- **@sozai/codec** — encoding and decoding primitives. → `reference/codec.md`

## Pick this when

- Deriving a TypeScript type from a JSON Schema at compile time → `@sozai/schema`
- Validating an untrusted payload before acting on it → `@sozai/schema`
- Encoding or decoding a value for transport or storage → `@sozai/codec`

## Related

`/sozai:dataflow` — `@sozai/flow` builds its state machines on `@sozai/schema`.
```

Replace the `Pick this when` bullets with what `## When to Use` (lines 151-167) actually says; the three above are a shape, not a substitute for the source content.

- [ ] **Step 7: Verify the code samples against source**

Extract every code block from `reference/schema.md` and `reference/codec.md` into `.skill-check/validation.ts`, concatenated, with duplicate identifiers renamed and imports merged. Then:

```bash
pnpm exec tsc -p .skill-check/tsconfig.json
```

Expected: exit 0, no output. Any error is a documentation bug — fix the reference file, not the sample-in-scratch. If an error points at a genuine bug in `packages/schema/src` or `packages/codec/src`, file it and leave the source alone; this branch does not fix package code.

Then read `packages/schema/src` and `packages/codec/src` and confirm the prose: every behavioral claim ("throws on…", "returns undefined when…") is traceable to source or to a test in `packages/*/test`.

- [ ] **Step 8: Run the structural checker**

```bash
node scripts/check-skills.mjs
```

Expected: `PASS 3 file(s), 1 skill(s)`.

- [ ] **Step 9: Commit**

```bash
git add plugins/sozai/skills/validation
git commit -m "docs: ship the validation domain skill and per-package reference"
```

---

### Task 3: Primitives domain

**Files:**
- Create: `plugins/sozai/skills/primitives/SKILL.md`
- Create: `plugins/sozai/skills/primitives/reference/result.md`
- Create: `plugins/sozai/skills/primitives/reference/result-option.md`
- Create: `plugins/sozai/skills/primitives/reference/result-async.md`
- Create: `plugins/sozai/skills/primitives/reference/patch.md`
- Source: `docs/reference/primitives.md`, `docs/skills/primitives.skill.md`

**Interfaces:**
- Consumes: `scripts/check-skills.mjs` (Task 1), `.skill-check/tsconfig.json` (Task 2).
- Produces: nothing later tasks depend on.

`@sozai/result` is 148 lines, over cap, and splits three ways along its own `###` boundaries — one file per exported type.

- [ ] **Step 1: Extract the four reference files**

| Source lines | File | Heading |
|---|---|---|
| 14-15 preamble + 16-67 | `reference/result.md` | `# @sozai/result — Result` |
| 14-15 preamble + 68-110 | `reference/result-option.md` | `# @sozai/result — Option` |
| 14-15 preamble + 111-161 | `reference/result-async.md` | `# @sozai/result — AsyncResult` |
| 162-231 | `reference/patch.md` | `# @sozai/patch` |

Lines 14-15 are the `## @sozai/result` section preamble; repeat it at the top of all three `result*` files so each stands alone. Promote headings one level in every file (`###` → `##`, `####` → `###`).

Each `result*` file opens with a one-line cross-pointer so a reader landing on one finds the others, for example in `result.md`:

```markdown
Sibling references: `reference/result-option.md` (Option), `reference/result-async.md` (AsyncResult).
```

- [ ] **Step 2: Merge any unique patterns from the old skill file**

Read `docs/skills/primitives.skill.md`. Apply the Step 5 rule from Task 2: covered → drop, uncovered → port into the matching reference file. Note which.

- [ ] **Step 3: Write the domain skill**

Create `plugins/sozai/skills/primitives/SKILL.md`, folding lines 5-13 into `## Packages` and lines 232-237 into `## Pick this when`:

```markdown
---
name: primitives
description: Use when working with Option, Result, AsyncResult, or JSON patches in sozai.
---

# Sozai primitives

Typed wrappers and JSON patching. `Option`, `Result`, and `AsyncResult` make success and
failure explicit in the type rather than in a thrown value; `@sozai/patch` diffs and applies
JSON patches.

## Packages

- **@sozai/result** — `Result` for explicit success/failure. → `reference/result.md`
  - `Option` for present/absent. → `reference/result-option.md`
  - `AsyncResult` for promise-returning chains. → `reference/result-async.md`
- **@sozai/patch** — JSON patch: `createPatches`, `applyPatches`. → `reference/patch.md`

## Pick this when

- Returning failure without throwing → `Result`, `reference/result.md`
- Modelling a value that may be absent → `Option`, `reference/result-option.md`
- Chaining async steps that each may fail → `AsyncResult`, `reference/result-async.md`
- Diffing two JSON documents or applying a patch → `@sozai/patch`

## Related

`/sozai:dataflow` — `@sozai/execution` returns `Result`, and `@sozai/result` builds on `@sozai/async`.
```

Replace the `Pick this when` bullets with what lines 232-237 actually say.

- [ ] **Step 4: Verify the code samples**

Extract every code block from the four reference files into `.skill-check/primitives.ts`, then:

```bash
pnpm exec tsc -p .skill-check/tsconfig.json
```

Expected: exit 0. Then read `packages/result/src` and `packages/patch/src` and confirm the prose claims.

- [ ] **Step 5: Run the structural checker**

```bash
node scripts/check-skills.mjs
```

Expected: `PASS 8 file(s), 2 skill(s)`.

- [ ] **Step 6: Commit**

```bash
git add plugins/sozai/skills/primitives
git commit -m "docs: ship the primitives domain skill, splitting result per type"
```

---

### Task 4: Observability domain

**Files:**
- Create: `plugins/sozai/skills/observability/SKILL.md`
- Create: `plugins/sozai/skills/observability/reference/log.md`
- Create: `plugins/sozai/skills/observability/reference/otel.md`
- Create: `plugins/sozai/skills/observability/reference/otel-propagation.md`
- Create: `plugins/sozai/skills/observability/reference/otel-log-bridge.md`
- Source: `docs/reference/observability.md`, `docs/skills/observability.skill.md`

**Interfaces:**
- Consumes: `scripts/check-skills.mjs` (Task 1), `.skill-check/tsconfig.json` (Task 2).
- Produces: nothing later tasks depend on.

`@sozai/otel` is 155 lines and its subsections interleave, so the split is by topic rather than by a single cut point. Each destination file gathers non-contiguous ranges.

- [ ] **Step 1: Extract `log.md`**

Copy lines 16-53 into `reference/log.md`, heading promoted to `# @sozai/log`.

- [ ] **Step 2: Extract `otel.md` — tracing core**

Gather, in this order: lines 54-59 (section preamble and `### Exports` header), 60-71 (`#### Tracing`), 104-110 (`#### Semantic constants`), 111-117 (`#### ID validation`), 125-135 (`#### Re-exports from @opentelemetry/api`), 136-155 (`### Example — tracer and span`).

Heading `# @sozai/otel — tracing`. Promote nested headings one level. Add a sibling pointer line:

```markdown
Sibling references: `reference/otel-propagation.md` (context, baggage, W3C headers), `reference/otel-log-bridge.md` (log/trace bridge).
```

Expected result ≈ 63 lines.

- [ ] **Step 3: Extract `otel-propagation.md`**

Gather: lines 72-79 (`#### Context propagation`), 80-92 (`#### Baggage`), 93-103 (`#### W3C headers`), 156-184 (`### Example — W3C context propagation`).

Heading `# @sozai/otel — context propagation and baggage`. Same sibling-pointer line, pointing at `otel.md` and `otel-log-bridge.md`. Expected ≈ 61 lines.

- [ ] **Step 4: Extract `otel-log-bridge.md`**

Gather: lines 118-124 (`#### Bridge (@sozai/log ↔ OTel)`), 185-208 (`### Example — log/trace bridge`).

Heading `# @sozai/otel — log/trace bridge`. Same sibling-pointer line. Expected ≈ 31 lines.

- [ ] **Step 5: Merge any unique patterns from the old skill file**

Read `docs/skills/observability.skill.md` and apply the Task 2 Step 5 rule.

- [ ] **Step 6: Write the domain skill**

Create `plugins/sozai/skills/observability/SKILL.md`, folding lines 5-15 into `## Packages` and 209-214 into `## Pick this when`:

```markdown
---
name: observability
description: Use when adding structured logging or OpenTelemetry tracing to sozai code.
---

# Sozai observability

Structured logging and tracing. A LogTape-backed namespaced logger, and OpenTelemetry tracing
with W3C context propagation and baggage.

## Packages

- **@sozai/log** — structured logging: `setup`, `getLogger`, console sink. → `reference/log.md`
- **@sozai/otel** — tracer and spans, semantic constants, ID validation. → `reference/otel.md`
  - W3C context propagation and baggage. → `reference/otel-propagation.md`
  - Bridging log records to the active span. → `reference/otel-log-bridge.md`

## Pick this when

- Emitting namespaced structured logs → `@sozai/log`
- Creating a tracer and spans → `reference/otel.md`
- Carrying trace context across a transport boundary → `reference/otel-propagation.md`
- Correlating log records with the active span → `reference/otel-log-bridge.md`

## Related

`@sozai/otel` depends on `@sozai/log`; both live in this domain.
```

Replace the `Pick this when` bullets with what lines 209-214 actually say.

- [ ] **Step 7: Verify the code samples**

Extract every code block from the four reference files into `.skill-check/observability.ts`, then:

```bash
pnpm exec tsc -p .skill-check/tsconfig.json
```

Expected: exit 0. Then read `packages/log/src` and `packages/otel/src` and confirm the prose. Pay particular attention to the W3C claims — `docs/agents/plans/completed/2026-07-14-otel-w3c-compliance.complete.md` records a compliance pass, so verify the reference text describes the post-pass behavior.

- [ ] **Step 8: Run the structural checker**

```bash
node scripts/check-skills.mjs
```

Expected: `PASS 13 file(s), 3 skill(s)`.

- [ ] **Step 9: Commit**

```bash
git add plugins/sozai/skills/observability
git commit -m "docs: ship the observability domain skill, splitting otel by topic"
```

---

### Task 5: Runtime domain

**Files:**
- Create: `plugins/sozai/skills/runtime/SKILL.md`
- Create: `plugins/sozai/skills/runtime/reference/runtime.md`
- Create: `plugins/sozai/skills/runtime/reference/runtime-expo.md`
- Create: `plugins/sozai/skills/runtime/reference/lock.md`
- Create: `plugins/sozai/skills/runtime/reference/lock-semantics.md`
- Source: `docs/reference/runtime.md`, `docs/skills/runtime.skill.md`

**Interfaces:**
- Consumes: `scripts/check-skills.mjs` (Task 1), `.skill-check/tsconfig.json` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Extract the four reference files**

| Source lines | File | Heading |
|---|---|---|
| 16-66 | `reference/runtime.md` | `# @sozai/runtime` |
| 67-115 | `reference/runtime-expo.md` | `# @sozai/runtime-expo` |
| 116-160 | `reference/lock.md` | `# @sozai/lock` |
| 161-262 | `reference/lock-semantics.md` | `# @sozai/lock — semantics and failure modes` |

The `lock` cut falls between `### Usage` (ending line 160) and the first bolded semantics block (`**"Same boot" is decided by an OS boot ID…**`, line 161). `lock.md` gets the header, `### Exports`, and `### Usage`; `lock-semantics.md` gets the four bolded blocks — boot ID, unsafe fallback path, TTL-bounded reboot recovery, pid recycling.

`lock.md` needs a pointer to the semantics file, and it must be emphatic rather than decorative — the semantics are what make the lock safe or unsafe to rely on:

```markdown
> Read `reference/lock-semantics.md` before depending on this lock. The fallback path is not
> safe, the TTL does not protect a long-held lock there, and reboot recovery is TTL-bounded
> rather than instant.
```

Verify that sentence against `reference/lock-semantics.md` after extraction and correct it if the source says otherwise.

- [ ] **Step 2: Merge any unique patterns from the old skill file**

Read `docs/skills/runtime.skill.md` and apply the Task 2 Step 5 rule.

- [ ] **Step 3: Write the domain skill**

Create `plugins/sozai/skills/runtime/SKILL.md`, folding lines 6-15 into `## Packages`, 263-279 into `## Pick this when`, and 280-286 into `## Related`:

```markdown
---
name: runtime
description: Use when abstracting platform fetch and randomness, targeting Expo/React Native, or taking a cross-process lock in sozai.
---

# Sozai runtime

Platform runtime abstraction — environment-agnostic `fetch` and randomness via `createRuntime`,
plus the Expo / React Native binding. Also home to the one filesystem-dependent package in the
repo, a cross-process mutex.

## Packages

- **@sozai/runtime** — platform abstraction (`fetch`, randomness) via `createRuntime`. → `reference/runtime.md`
- **@sozai/runtime-expo** — Expo / React Native runtime binding. → `reference/runtime-expo.md`
- **@sozai/lock** — filesystem-based cross-process mutex. → `reference/lock.md`, and
  `reference/lock-semantics.md` for the failure modes

## Pick this when

- Writing code that must run unchanged on Node and in a browser → `@sozai/runtime`
- Targeting Expo or React Native → `@sozai/runtime-expo`
- Serialising work across processes on one host → `@sozai/lock`, semantics file first

## Related

`/sozai:dataflow` — `@sozai/lock` builds on `@sozai/async`.
```

Replace the `Pick this when` bullets with what lines 263-279 actually say, and check lines 280-286 (`## See Also`) for anything that belongs in `## Related`.

- [ ] **Step 4: Verify the code samples**

Extract every code block from the four reference files into `.skill-check/runtime.ts`, then:

```bash
pnpm exec tsc -p .skill-check/tsconfig.json
```

Expected: exit 0. `@sozai/runtime-expo` samples may import Expo modules that resolve to `any` under `skipLibCheck` — that is acceptable, since the harness is checking sozai's own surface.

Then read `packages/runtime/src`, `packages/runtime-expo/src`, and `packages/lock/src`. The lock semantics claims are the highest-risk prose in the repo — boot ID, TTL bounds, pid recycling, fallback-path safety — and each one must be traceable to `packages/lock/src` or `packages/lock/test`.

- [ ] **Step 5: Run the structural checker**

```bash
node scripts/check-skills.mjs
```

Expected: `PASS 18 file(s), 4 skill(s)`.

- [ ] **Step 6: Commit**

```bash
git add plugins/sozai/skills/runtime
git commit -m "docs: ship the runtime domain skill, splitting lock semantics out"
```

---

### Task 6: Dataflow domain

Largest domain — six packages, six reference files, no splits needed.

**Files:**
- Create: `plugins/sozai/skills/dataflow/SKILL.md`
- Create: `plugins/sozai/skills/dataflow/reference/{stream,async,event,flow,generator,execution}.md`
- Source: `docs/reference/dataflow.md`, `docs/skills/dataflow.skill.md`

**Interfaces:**
- Consumes: `scripts/check-skills.mjs` (Task 1), `.skill-check/tsconfig.json` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Extract the six reference files**

| Source lines | File | Heading |
|---|---|---|
| 18-89 | `reference/stream.md` | `# @sozai/stream` |
| 90-155 | `reference/async.md` | `# @sozai/async` |
| 156-211 | `reference/event.md` | `# @sozai/event` |
| 212-276 | `reference/flow.md` | `# @sozai/flow` |
| 277-339 | `reference/generator.md` | `# @sozai/generator` |
| 340-417 | `reference/execution.md` | `# @sozai/execution` |

Promote headings one level in each. All six land under the cap; `execution.md` at ≈82 lines is the largest.

- [ ] **Step 2: Merge any unique patterns from the old skill file**

`docs/skills/dataflow.skill.md` has seven `### Pattern N` blocks, and each appears to map onto an existing reference example:

| Skill pattern | Candidate reference example |
|---|---|
| 1. Web Streams Transformation Pipeline | `stream.md` — "Example: transformation pipeline" |
| 2. JSON Lines (NDJSON) Streaming | `stream.md` — "Example: JSON Lines (NDJSON)" |
| 3. Event-Driven Streams | `event.md` — "Example: typed emitter and stream bridge" |
| 4. Async Resource Management | `async.md` — "Example: deferred, lazy, and Disposer" |
| 5. Stateful Flow Execution | `flow.md` — "Example: state machine with `createFlow`" |
| 6. Async Generator Adapters | `generator.md` — its two examples |
| 7. Chainable Execution | `execution.md` — "Example: chained execution with error handling and cancellation" |

That mapping is by title, not by content — compare the bodies before dropping anything. Where the skill's version shows something the reference does not, port that part in.

- [ ] **Step 3: Write the domain skill**

Create `plugins/sozai/skills/dataflow/SKILL.md`, folding lines 5-17 into `## Packages` and 418-428 into `## Pick this when`:

```markdown
---
name: dataflow
description: Use when working with Web Streams, async utilities, typed events, generators, state machines, or cancellable execution in sozai.
---

# Sozai dataflow

Streaming, async, events, generators, and stateful flow — Web Streams creation and
transformation, deferred promises and disposers, typed event emitters, async-generator state
machines, emitter and stream adapters, and chainable cancellable execution.

## Packages

- **@sozai/stream** — Web Streams creation, transformation, JSON Lines framing. → `reference/stream.md`
- **@sozai/async** — deferred promises, lazy evaluation, `Disposer`, interruptions. → `reference/async.md`
- **@sozai/event** — typed event emitter with stream bridging. → `reference/event.md`
- **@sozai/flow** — async-generator state machine. → `reference/flow.md`
- **@sozai/generator** — emitter and stream to async-generator adapters. → `reference/generator.md`
- **@sozai/execution** — chainable, cancellable async execution returning `Result`. → `reference/execution.md`

## Pick this when

- Framing NDJSON over a transport → `@sozai/stream`
- Deferring a promise or disposing a resource deterministically → `@sozai/async`
- Emitting typed events, or bridging them to a stream → `@sozai/event`
- Modelling a process as states and transitions → `@sozai/flow`
- Consuming an emitter or stream with `for await` → `@sozai/generator`
- Chaining async steps that can be cancelled and return `Result` → `@sozai/execution`

## Related

`/sozai:primitives` — `@sozai/execution` returns `Result`.
`/sozai:validation` — `@sozai/flow` builds on `@sozai/schema`.
`/sozai:observability` — `@sozai/event` depends on `@sozai/log`.
```

Replace the `Pick this when` bullets with what lines 418-428 actually say.

- [ ] **Step 4: Verify the code samples**

Extract every code block from the six reference files into `.skill-check/dataflow.ts`, then:

```bash
pnpm exec tsc -p .skill-check/tsconfig.json
```

Expected: exit 0.

One known trap, already hit while building the harness: `@sozai/async` exports `defer()`, not a `Deferred` constructor. Its exports are `defer`, `disposer`, `interruptions`, `lazy`, `on-abort`, `teardown`, `timeout`, `utils`. Any sample writing `new Deferred(...)` is wrong and must be fixed against `packages/async/src`.

Then read the source of all six packages and confirm the prose claims.

- [ ] **Step 5: Run the structural checker**

```bash
node scripts/check-skills.mjs
```

Expected: `PASS 25 file(s), 5 skill(s)`.

- [ ] **Step 6: Commit**

```bash
git add plugins/sozai/skills/dataflow
git commit -m "docs: ship the dataflow domain skill and its six package references"
```

---

### Task 7: Discover skill

**Files:**
- Create: `plugins/sozai/skills/discover/SKILL.md`
- Source: `docs/skills/discover.skill.md`

**Interfaces:**
- Consumes: all five domain skills from Tasks 2-6 — every `/sozai:<domain>` this file names must already exist.
- Produces: the plugin's entry point.

The router. It must fit in 120 lines as a single file — a router that has to be loaded in pieces is not a router. If it runs long, cut prose; do not split it.

- [ ] **Step 1: Write the discover skill**

Create `plugins/sozai/skills/discover/SKILL.md`, based on `docs/skills/discover.skill.md` with the By Use Case section added:

```markdown
---
name: discover
description: Use when exploring sozai capabilities - progressive discovery of this repo's domain skills.
---

# Sozai capability discovery

Sozai (素材 — "raw material") is the core-utilities layer of the stack: stable,
environment-agnostic packages that everything else depends on downward. One exception,
`@sozai/lock`, is filesystem-based. 15 packages across 5 domains.

## By domain

- **Dataflow** — streaming, async, events, generators, stateful flow. Web Streams creation and
  transformation, deferred promises and disposers, typed event emitters, async-generator state
  machines, emitter and stream adapters, chainable cancellable execution. → `/sozai:dataflow`
- **Validation** — JSON Schema with compile-time type generation (`FromSchema`), plus message
  encoding and decoding. → `/sozai:validation`
- **Runtime** — environment-agnostic `fetch` and randomness via `createRuntime`, the Expo /
  React Native binding, and a filesystem-based cross-process mutex. → `/sozai:runtime`
- **Observability** — LogTape-based namespaced loggers, and OpenTelemetry tracing with W3C
  context propagation and baggage. → `/sozai:observability`
- **Primitives** — `Option`, `Result`, and `AsyncResult` for explicit success and failure, plus
  JSON-patch diff and apply. → `/sozai:primitives`

## By use case

- **Moving framed data over a transport** — `@sozai/stream` for JSON Lines framing, `@sozai/codec`
  for the payload. `/sozai:dataflow` + `/sozai:validation`.
- **Making failure explicit instead of thrown** — `Result` from `@sozai/result`, produced by
  `@sozai/execution` chains. `/sozai:primitives` + `/sozai:dataflow`.
- **Instrumenting a request path** — `@sozai/otel` for the span, `@sozai/log` for the record,
  the bridge to correlate them. `/sozai:observability`.
- **Writing code that runs on Node, browser, and React Native** — `createRuntime` for `fetch` and
  randomness. `/sozai:runtime`.
- **Serialising work across processes** — `@sozai/lock`, semantics file first. `/sozai:runtime`.

## Packages

**Dataflow** — `@sozai/stream`, `@sozai/async`, `@sozai/event`, `@sozai/flow`,
`@sozai/generator`, `@sozai/execution`

**Validation** — `@sozai/schema`, `@sozai/codec`

**Runtime** — `@sozai/runtime`, `@sozai/runtime-expo`, `@sozai/lock`

**Observability** — `@sozai/log`, `@sozai/otel`

**Primitives** — `@sozai/result`, `@sozai/patch`

## Conventions

This repo follows the shared stack conventions — see the `kigu:conventions` skill. Packages here
ossify: consumers depend on published `^` ranges, never `workspace:`, and versions move
per-package via changesets.

Sozai is the bottom of the stack and depends on no sibling repo. Consumers live upstream; the
`kigu:stack-map` skill navigates there.
```

- [ ] **Step 2: Check the line count**

```bash
wc -l plugins/sozai/skills/discover/SKILL.md
```

Expected: at or under 120. If over, cut prose from the By Use Case entries first.

- [ ] **Step 3: Verify every domain reference resolves**

```bash
node -e "
const fs=require('fs');
const t=fs.readFileSync('plugins/sozai/skills/discover/SKILL.md','utf8');
const refs=[...new Set((t.match(/\/sozai:[a-z-]+/g)||[]))];
let bad=0;
for (const r of refs) {
  const name=r.slice('/sozai:'.length);
  const ok=fs.existsSync('plugins/sozai/skills/'+name+'/SKILL.md');
  console.log((ok?'ok   ':'MISS ')+r);
  if(!ok)bad++;
}
process.exit(bad?1:0)"
```

Expected: five `ok` lines (`dataflow`, `validation`, `runtime`, `observability`, `primitives`), exit 0.

- [ ] **Step 4: Verify the package list is complete and correct**

```bash
node -e "
const fs=require('fs');
const declared=new Set((fs.readFileSync('plugins/sozai/skills/discover/SKILL.md','utf8').match(/@sozai\/[a-z-]+/g)||[]));
const actual=new Set(fs.readdirSync('packages').map(d=>JSON.parse(fs.readFileSync('packages/'+d+'/package.json','utf8')).name));
const missing=[...actual].filter(n=>!declared.has(n));
const extra=[...declared].filter(n=>!actual.has(n));
if(missing.length)console.log('MISSING from discover: '+missing.join(', '));
if(extra.length)console.log('NOT A REAL PACKAGE: '+extra.join(', '));
console.log(missing.length||extra.length?'FAIL':'PASS: all 15 packages listed');
process.exit(missing.length||extra.length?1:0)"
```

Expected: `PASS: all 15 packages listed`. `check-skills.mjs` already rejects an `@sozai/*` name that is not a real package; this check covers the other direction — a real package the router forgot to list, which no structural rule catches.

- [ ] **Step 5: Run the structural checker**

```bash
node scripts/check-skills.mjs
```

Expected: `PASS 26 file(s), 6 skill(s)`.

- [ ] **Step 6: Commit**

```bash
git add plugins/sozai/skills/discover
git commit -m "docs: ship the sozai discover skill as the plugin entry point"
```

---

### Task 8: Retire the old docs

**Files:**
- Delete: `docs/skills/` (6 files)
- Delete: `docs/reference/` (5 files)
- Modify: `docs/index.md`

**Interfaces:**
- Consumes: all six skills from Tasks 2-7 — nothing is deleted until its content ships in the plugin.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Confirm nothing else links to the doomed paths**

```bash
node -e "
const fs=require('fs'),path=require('path');
const hits=[];
const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){
  if(e.name==='node_modules'||e.name==='.git'||e.name==='lib')continue;
  const p=path.join(d,e.name);
  if(e.isDirectory())walk(p);
  else if(/\.(md|json)$/.test(e.name)&&!p.startsWith('docs/skills')&&!p.startsWith('docs/reference')){
    const t=fs.readFileSync(p,'utf8');
    t.split('\n').forEach((l,i)=>{ if(/docs\/(skills|reference)\//.test(l)) hits.push(p+':'+(i+1)+': '+l.trim().slice(0,100)) })
  }}};
walk('.');
hits.forEach(h=>console.log(h));
console.log(hits.length+' reference(s) to update')"
```

Every hit outside `docs/agents/plans/completed/` must be updated in Step 3. Completed plan documents are historical records — leave them as written.

- [ ] **Step 2: Delete the old directories**

```bash
git rm -r docs/skills docs/reference
```

- [ ] **Step 3: Update the docs index**

In `docs/index.md`, replace the Reference line with a Skills line. The file currently reads:

```markdown
- **Reference:** [reference/](./reference/)
```

Replace with:

```markdown
- **Skills:** [../plugins/sozai/skills/](../plugins/sozai/skills/) — domain skills and per-package reference, served as the `sozai` plugin
```

Then apply any other updates Step 1 turned up.

- [ ] **Step 4: Confirm the tree is clean**

```bash
test ! -d docs/skills && test ! -d docs/reference && echo "PASS: old docs removed"
node scripts/check-skills.mjs
```

Expected: `PASS: old docs removed`, then `PASS 26 file(s), 6 skill(s)`.

- [ ] **Step 5: Commit**

```bash
git add -A docs
git commit -m "docs: retire docs/skills and docs/reference for the plugin"
```

---

### Task 9: Load test and close the loop

**Files:**
- Modify: `docs/agents/plans/backlog/2026-07-24-package-skills-as-plugin.md` (move to `docs/agents/plans/completed/`)
- Modify: `docs/agents/plans/roadmap.md`

**Interfaces:**
- Consumes: the complete plugin from Tasks 1-8.
- Produces: the finished branch.

- [ ] **Step 1: Load the plugin from the working tree**

This step is interactive and cannot be scripted. In Claude Code, run:

```
/plugin marketplace add /Users/paul/dev/yulsi/sozai
```

Then confirm each of these resolves and loads:

- `/sozai:discover`
- `/sozai:dataflow`
- `/sozai:validation`
- `/sozai:runtime`
- `/sozai:observability`
- `/sozai:primitives`

This is a local, uncommitted step. It proves the manifests are well-formed; it does not make the plugin live for sibling repos, which only happens once this branch reaches `main` and the github-sourced marketplace resolves it.

- [ ] **Step 2: Walk the progressive-discovery path**

From `/sozai:discover`, follow the routing to `/sozai:dataflow`, then open `reference/stream.md` from that skill's pointer. Confirm each hop names a file that exists and that the content answers a real question end to end — for example, "how do I frame NDJSON over a transport".

- [ ] **Step 3: Close the backlog item**

```bash
git mv docs/agents/plans/backlog/2026-07-24-package-skills-as-plugin.md \
       docs/agents/plans/completed/2026-07-26-package-skills-as-plugin.complete.md
```

Rewrite the file's status line to record the outcome: what shipped (26 files, six skills, the 120-line cap), what was verified against source, and that kokuin remains open. Keep the original gap description — it explains why the work happened.

- [ ] **Step 4: Update the roadmap**

`docs/agents/plans/roadmap.md` lines 38-43 describe this as open backlog work. Replace that entry with a completed reference pointing at the new path in `completed/`, following whatever convention the surrounding completed entries in that file already use.

- [ ] **Step 5: Full verification sweep**

```bash
node scripts/check-skills.mjs
pnpm exec tsc -p .skill-check/tsconfig.json
pnpm run test
git status --short
```

Expected: checker `PASS 26 file(s), 6 skill(s)`; tsc exit 0; tests pass; `git status` clean apart from the gitignored `.skill-check/`.

- [ ] **Step 6: Commit**

```bash
git add -A docs
git commit -m "docs: close the skills-plugin backlog item and update the roadmap"
```

- [ ] **Step 7: Report what is not done**

State plainly in the final summary:

- `/sozai:*` does not resolve for sibling repos until this branch merges to `main` — the marketplace is github-sourced.
- kokuin still carries the identical gap (`docs/skills/{discover,auth,capability}.skill.md`, no plugin). Enkaku's backlog item `2026-07-18-sibling-repo-skill-plugins.md` covers both repos and stays open.
- `kigu:discover-template` still documents a terser discover shape than either live instantiation. Drift unaddressed by design.
- Any package-source bugs surfaced during verification were filed, not fixed.

---

## Verification Summary

Three independent checks, run at every task boundary:

| Check | Command | Catches |
|---|---|---|
| Structural | `node scripts/check-skills.mjs` | Over-cap files, prefixed frontmatter names, code blocks in `SKILL.md`, outward cross-repo refs, dangling `reference/*.md` pointers, `@sozai/*` names that are not real packages |
| Type | `pnpm exec tsc -p .skill-check/tsconfig.json` | Imports that name non-exports, wrong call signatures, invented options |
| Prose | reading `packages/*/src` | Behavioral claims that source does not support |

The type check is the one that would have caught enkaku's failure: pre-split package names in every transport import, six server constructions passing options that never existed. The prose check is the one that catches what type-checking cannot — a correct API described with wrong semantics.
