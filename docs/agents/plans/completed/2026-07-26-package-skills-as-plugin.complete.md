# tooling — package the domain skills as a Claude Code plugin

**Status:** complete · 2026-07-26, extended 2026-07-27
**Source:** 2026-07-24, prompted by comparison with `@enkaku`'s skill plugin
(`../enkaku/plugins/enkaku/`).

## The gap

sozai has six domain-skill documents under `docs/skills/` (`discover`, `dataflow`, `validation`,
`runtime`, `observability`, `primitives`) — the `kigu:discover-template` instantiation. Their
frontmatter already declares invocable names (`name: sozai:discover`) and they cross-reference each
other as slash commands (`/sozai:dataflow`, `/sozai:validation`, …). But they are **flat markdown
files**, not a packaged plugin — there is no `plugins/` directory and no `.claude-plugin/plugin.json`
— so none of those `/sozai:*` commands actually resolve.

Meanwhile `@enkaku` has already made this real: `../enkaku/plugins/enkaku/` is a Claude Code plugin
(`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md` for `discover`, `transport`, `core-rpc`),
so `/enkaku:discover` and its domain skills are live. Enkaku's own discover skill points outward at
`/sozai:discover`, `/sozai:validation`, `/sozai:dataflow`, `/sozai:runtime`, `/sozai:observability`,
`/sozai:primitives` — exactly sozai's six skill docs — as if they were invocable. Today they are not,
so that cross-repo progressive-discovery path dead-ends at sozai.

## What was done

Stood up `plugins/sozai/` mirroring `../enkaku/plugins/enkaku/`: a `.claude-plugin/plugin.json`,
registered through a repo-root `.claude-plugin/marketplace.json` and `.claude/settings.json` using
a `github` source (`TairuFramework/sozai`). Six skills under `plugins/sozai/skills/`: `discover`
plus the five domains — `dataflow`, `validation`, `runtime`, `observability`, `primitives`. 26
Markdown files total — 6 `SKILL.md` plus 20 per-package `reference/*.md` files, one per package
under each domain's skill.

A 120-line cap applies to every Markdown file in the plugin, enforced by a structural checker that
also rejects prefixed frontmatter names, code blocks in `SKILL.md`, cross-repo references outside an
allowlist, dangling `reference/*.md` pointers, and `@sozai/*` names that are not real packages. The
cap was derived from measurement rather than taste: 12 packages documented at 38-78 lines and three
outliers at 147-155, so 120 sits in the natural gap. Three packages didn't
fit one reference file under the cap and were split by topic: `otel` three ways (`otel.md`,
`otel-propagation.md`, `otel-log-bridge.md`), `result` three ways (`result.md`,
`result-option.md`, `result-async.md`), `lock` two ways (`lock.md`, `lock-semantics.md`).

`docs/skills/` and `docs/reference/` — the old flat-markdown source — are deleted; the plugin's
`skills/` tree is now the only copy. 11 package `README.md` files were repointed from
`docs/reference/*.md` at the new per-package `reference/` files, and `docs/index.md` gained a
Skills line pointing at `plugins/sozai/`.

Every code sample in the 26 files type-checks against the real workspace through a dedicated
`.skill-check/tsconfig.json` harness (gitignored; the root `tsconfig.json` has no `include`, so
type-checking through it drags in all of `node_modules`). Its `paths` must map `@sozai/*` at
`lib/index.d.ts` rather than the package directory — `moduleResolution: nodenext` plus package
`exports` without a `types` condition breaks directory path-mapping. Each behavioral claim was also
read back against `packages/*/src`. That pass surfaced roughly a dozen real documentation errors,
fixed in place — including an exported function that never existed (`polyfillFetch`), an error code
that was never defined (`PATH_EXISTS`), a code sample that did not compile, and a
`MissingHandlerError` documented as thrown when it is actually returned.

## The checker moved to `@kigu/dev` (2026-07-27)

Started as a local `scripts/check-skills.mjs`. Three repos now ship a plugin — kigu, enkaku, sozai —
and none of the other two validated theirs, so it was generalized into `kigu-check-skills`
(`@kigu/dev` 0.2.0, TairuFramework/kigu#5) and the local copy deleted.

Two rules turned out to be **style policy rather than universal truth**: kigu's own skills
deliberately break both, with `conventions/SKILL.md` at 315 lines and six SKILL.md files containing
code blocks. So the line cap and the no-code-blocks rule are opt-in, while the structural rules
always run. Each repo states its policy once in `skills-check.json` at the root, which lets the
pre-commit hook and CI both invoke the bare command with no duplicated flags.

Skill references inside fenced code blocks are exempt — kigu's `discover-template` shows a sample
`/tejika:storage` listing that points at nothing. Package names stay checked everywhere, since a
sample importing a package that does not exist is wrong regardless.

sozai declares `allow: ["kigu"]`, because `discover/SKILL.md` cites `kigu:conventions` and
`kigu:stack-map`. The local checker never saw those: it used a deny-list naming only enkaku, kokuin
and kumiai. The shared version checks the whole stack namespace, so any cross-repo reference has to
be declared. Upward references to the toolchain root are legal; sideways ones are not, since sozai
sits at the bottom of the stack.

Enforcement is now real rather than local: CI passes `skills-check: true` to kigu's reusable
`build-test` workflow. Before that the checker ran only in a git hook, which nothing enforces on a
fresh clone.

## Still open

- **`/sozai:*` does not resolve for sibling repos yet.** The marketplace is `github`-sourced and
  resolves from `TairuFramework/sozai`'s default branch HEAD, so the six skills only become
  reachable from `@kokuin`/`@enkaku`/`@kumiai` once this branch merges to `main`.
- **kokuin carries the identical gap.** `docs/skills/{discover,auth,capability}.skill.md` exist
  flat, same as sozai's did, with no `plugins/` packaging. It gets its own cycle rather than being
  folded into this one.
- **`kigu:discover-template` documents a terser discover shape than either live instantiation**
  (sozai's or enkaku's). Drift unaddressed by design — out of scope here.
- **enkaku has not adopted `kigu-check-skills`.** Its plugin passes only with
  `allow: ["sozai", "kokuin"]`; nothing runs the checker there yet. Belongs to that repo.

## Worth remembering

The verification pass introduced an error of its own, and took three rounds to settle the
`@sozai/generator` disposal semantics — a true `Symbol.asyncDispose` claim was dropped after
grepping the wrong lib file, then replaced with a claim that synchronous `using` works (it fails
with TS2850 and throws at runtime). A correction that overturns an inherited claim deserves the
same evidentiary standard as the claim itself; "the old doc was wrong" is not evidence that the
replacement is right.
