# Package sozai's domain skills as a Claude Code plugin

**Date:** 2026-07-26
**Branch:** `docs/skills-plugin`
**Supersedes:** `docs/agents/plans/backlog/2026-07-24-package-skills-as-plugin.md`

## Problem

sozai carries six skill documents under `docs/skills/` (`discover`, `dataflow`, `validation`,
`runtime`, `observability`, `primitives`). Their frontmatter declares invocable names
(`name: sozai:discover`) and they cross-reference each other as slash commands
(`/sozai:dataflow`, …), but nothing serves them: there is no `plugins/` directory and no
`.claude-plugin/plugin.json`. None of those commands resolve.

The dead end is felt from outside the repo. `@enkaku` packaged its skills first
(`../enkaku/plugins/enkaku/`), and its discover skill routes outward to `/sozai:discover`,
`/sozai:validation`, `/sozai:dataflow`, `/sozai:runtime`, `/sozai:observability`,
`/sozai:primitives` as if they were live. sozai is the common downward dependency, so every
sibling repo's discovery path terminates here.

A second problem compounds it. `docs/reference/` already holds one deep document per domain
(`dataflow` 427 lines, `runtime` 285, `primitives` 236, `observability` 213, `validation` 173),
and the `docs/skills/*.skill.md` files (994 lines total) duplicate much of that material —
the skill copies carrying "Key Patterns" code blocks that restate the reference docs' examples.
Packaging the skills as-is would freeze that duplication and would load 20K of dataflow
reference to answer a question about one package.

## Goals

- `/sozai:discover` and the five domain skills resolve, in this repo and in sibling repos.
- Skill content is verified against package source before it is served.
- Context cost scales with the question: a narrow question loads a narrow file.
- One home per piece of content. No skill/reference duplication.

## Non-goals

- **kokuin.** It has the identical gap (`docs/skills/{discover,auth,capability}.skill.md`,
  no plugin) and gets its own cycle reusing this recipe. Enkaku's backlog item
  `2026-07-18-sibling-repo-skill-plugins.md`, which covers both repos, stays open.
- **`kigu:discover-template`.** It prescribes a terser discover skill than either live
  instantiation (enkaku's and the one specified here). The drift is real and is left alone.
- **Package source fixes.** Verification will surface documentation bugs. If it surfaces a
  bug in `packages/*/src`, file it; do not fix it on this branch.
- **`AGENTS.md`.** It makes no `/sozai:*` claim today, so nothing there is false.

## Structure

```
sozai/
  .claude-plugin/marketplace.json
  .claude/settings.json
  plugins/sozai/
    .claude-plugin/plugin.json
    skills/
      discover/SKILL.md
      dataflow/
        SKILL.md
        reference/{stream,async,event,flow,generator,execution}.md
      validation/
        SKILL.md
        reference/{schema,codec}.md
      runtime/
        SKILL.md
        reference/{runtime,runtime-expo,lock}.md
      observability/
        SKILL.md
        reference/{log,otel}.md
      primitives/
        SKILL.md
        reference/{result,patch}.md
```

`docs/skills/` and `docs/reference/` are deleted; their content lives in the plugin.
`docs/index.md` replaces its Reference line with a Skills line pointing at
`plugins/sozai/skills/`.

This layout mirrors `../enkaku/plugins/enkaku/` and satisfies what `kigu:discover-template`
requires of a discover skill's location (`plugins/<repo>/skills/discover/SKILL.md`).

Note `skills/runtime/reference/runtime.md` — a package named after its domain. Not a collision;
the path is unambiguous.

Reference files must live inside the plugin, not in `docs/`. A plugin resolved into the
Claude Code cache contains only the plugin directory — a `SKILL.md` in a sibling repo's cache
cannot reach `../../docs/reference/`. Splitting content across files only pays off cross-repo
if the split files ship with the plugin.

### Frontmatter names are bare

Every skill declares `name: dataflow`, not `name: sozai:dataflow`. The namespace comes from
the plugin; keeping the prefix yields `/sozai:sozai:dataflow`. All six current files carry
the prefix and all six need the edit.

### Marketplace wiring

`.claude-plugin/marketplace.json` at the repo root lists one plugin with a relative source:

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

`.claude/settings.json` gains a `sozai` entry under `extraKnownMarketplaces` with a **`github`**
source (`TairuFramework/sozai`, `autoUpdate: true`) and `"sozai@sozai": true` under
`enabledPlugins`.

The `github` source is forced, not stylistic: relative marketplace sources are not supported
from `extraKnownMarketplaces`, only through a manual `/plugin marketplace add`, which
checked-in configuration cannot rely on. The consequence is that the plugin resolves from
GitHub HEAD — `/sozai:*` stays dead for sibling repos until this lands on `main`.

## Content contract

### Size cap

**120 lines, every Markdown file in the plugin, no exceptions.** A file over the cap splits
into `reference/<package>-<topic>.md`, and the domain's `SKILL.md` indexes each part.

The cap is derived, not arbitrary. Per-package section sizes in the current reference docs:

| lines | sections |
|---|---|
| 38–78 | `log` 38, `runtime-expo` 49, `runtime` 51, `event` 56, `generator` 63, `flow` 65, `codec` 65, `patch` 70, `schema` 72, `stream` 72, `async` 66, `execution` 78 |
| 147–155 | `lock` 147, `result` 148, `otel` 155 |

The gap between 78 and 147 means a cap of 120 splits exactly the three outliers, with 42 lines
of headroom over the largest normal package so that merged-in patterns do not tip files over by
accident. Expected splits:

- `otel` → tracing / context propagation + baggage
- `result` → `Result` + `Option` / `AsyncResult`
- `lock` → API / semantics + failure modes

Result: 18 reference files, 6 `SKILL.md`.

Apply the cap **after** step 3 (pattern merge), not before — porting patterns in grows sections.

### Deduplication rule

The reference file is the single home for code. For each "Key Patterns" block in a
`docs/skills/*.skill.md`: if the matching reference file already covers it, drop the skill copy;
if it does not, port the pattern into the reference file. No code block survives in a `SKILL.md`.

### Domain `SKILL.md`

Target ≤50 lines (hard cap 120). No code blocks. Index and routing only.

```markdown
---
name: dataflow
description: Use when working with streams, async, events, generators, or stateful flow in sozai.
---

# Sozai dataflow

One-paragraph scope.

## Packages

- **@sozai/stream** — Web Streams creation, transformation, JSON Lines framing. → `reference/stream.md`
- **@sozai/async** — deferred promises, lazy values, `Disposer`, interruptions. → `reference/async.md`

## Pick this when

- Framing NDJSON over a transport → `@sozai/stream`
- Cancelling a chained async operation and getting a `Result` → `@sozai/execution`

## Related

`/sozai:validation` for encoding payloads · `/sozai:primitives` for `Result`.
```

### Reference files

`reference/<package>.md`: exports, methods, worked examples. Lifted from the corresponding
`## @sozai/<pkg>` section of the current domain reference doc, plus ported patterns. Subject
to the 120-line cap. This is where depth lives, loaded only when the agent asks about that
package.

The current reference docs also carry non-package sections. These do not become reference
files — they fold into the domain's `SKILL.md`:

- `## Packages` (the intro list) → the `## Packages` section of `SKILL.md`
- `## When to Use` / `## When to use` → the `## Pick this when` section of `SKILL.md`
- `## See Also` → the `## Related` section of `SKILL.md`

Nothing from a reference doc is discarded without being folded somewhere.

### `discover/SKILL.md`

Enkaku-style router, not the terse `kigu:discover-template` shape. Sections: By Domain (five
entries, a sentence of rationale each), By Use Case, 15-package overview, Cross-repo routing.
No code blocks. It must fit within the 120-line cap as a single file — a router that has to be
loaded in pieces is not a router. If it runs over, cut prose; do not split it.

The cross-repo section must state that `/kokuin:*` targets do not resolve yet — kokuin's
skills are still unpackaged. Aspirational links are labelled as such rather than presented as
working, which is the mistake enkaku's discover skill made in the other direction.

### Effect

An agent asking "how do I frame NDJSON" loads `discover` + `dataflow/SKILL.md` +
`reference/stream.md` — roughly 220 lines — instead of a 278-line skill plus a 427-line
reference document.

## Verification

Skill content is verified against `packages/*/src` before it ships. This is the expensive part
of the work and it is not optional.

Enkaku's post-mortem is the reason. Its audit recorded its skill content as post-split current;
it was not. Every transport import used a pre-split package name, six server constructions
passed a singular `transport` with no `access` option, two passed a `public: true` option that
has never existed, and the discover skill named a WebSocket transport that does not exist.
Each would have thrown at construction. Serving stale content is worse than leaving it
unserved, because skills are what agents load first.

Per package, check against `packages/<name>/src`:

1. **Package name** — present in `pnpm-workspace.yaml`, matches its `package.json` name.
2. **Every import** — the named export is actually exported from that entry point.
3. **Every call signature** — argument shape and option keys exist on the real type. No
   invented options.
4. **Prose claims** — behavioral statements are traceable to source or tests.

Method: extract the code blocks of each domain into a scratch file and compile against the
workspace. Type-checking finds items 1–3 faster and more reliably than reading. Item 4 needs
eyes on source.

Cross-reference check, run separately from content verification:

- every `/sozai:<domain>` reference resolves to a skill shipped by this plugin;
- every `/enkaku:*` target exists in `../enkaku/plugins/enkaku/skills/`;
- every `/kokuin:*` and `/kumiai:*` target is confirmed present or labelled as not yet
  resolving.

### Pre-merge load test

Before merging, load the plugin from the working tree:

```
/plugin marketplace add /Users/paul/dev/yulsi/sozai
```

Confirm `/sozai:discover` and all five domain skills resolve, and that the discover → domain
skill → reference file path works end to end. This is a local, uncommitted step; it proves the
manifest is well-formed but does not make the plugin live for sibling repos.

## Order of work

1. Scaffold wiring: `.claude-plugin/marketplace.json`, `plugins/sozai/.claude-plugin/plugin.json`,
   `.claude/settings.json`.
2. Split `docs/reference/*.md` at `## @sozai/<pkg>` boundaries into
   `plugins/sozai/skills/<domain>/reference/<pkg>.md`; hold the non-package sections
   (`Packages`, `When to Use`, `See Also`) aside for step 5.
3. Port unique "Key Patterns" blocks from `docs/skills/*.skill.md` into the matching reference
   files; discard duplicates.
4. Apply the 120-line cap; split `otel`, `result`, `lock` and anything else over.
5. Write the six `SKILL.md` files with bare frontmatter names.
6. Verify content against source; verify cross-references.
7. Delete `docs/skills/` and `docs/reference/`; update `docs/index.md`.
8. Run the pre-merge load test.
9. Mark `docs/agents/plans/backlog/2026-07-24-package-skills-as-plugin.md` complete and update
   the roadmap entry at `docs/agents/plans/roadmap.md`.

## Risks

- **Not live until merged.** The github marketplace source means `/sozai:*` resolves from
  GitHub HEAD. Sibling repos see nothing until this reaches `main`. Accepted; the local load
  test is the mitigation for manifest errors, not for availability.
- **Verification surface is large.** Layout A puts the reference content into the plugin, so
  the verify pass covers roughly 1,300 lines of reference plus the skill files, not just the
  skills. This is the cost of not shipping unverified content.
- **File count.** 24 Markdown files replace 11. The cap makes the count predictable; the
  `SKILL.md` index in each domain is what keeps them navigable.
