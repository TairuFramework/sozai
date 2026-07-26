# tooling — package the domain skills as a Claude Code plugin

**Status:** complete · 2026-07-26
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

A 120-line cap applies to every Markdown file in the plugin, enforced by a new structural checker
(`scripts/check-skills.mjs`, wired as `pnpm run check:skills`) that also rejects prefixed
frontmatter names, code blocks in `SKILL.md`, outward cross-repo references, dangling
`reference/*.md` pointers, and `@sozai/*` names that are not real packages. Three packages didn't
fit one reference file under the cap and were split by topic: `otel` three ways (`otel.md`,
`otel-propagation.md`, `otel-log-bridge.md`), `result` three ways (`result.md`,
`result-option.md`, `result-async.md`), `lock` two ways (`lock.md`, `lock-semantics.md`).

`docs/skills/` and `docs/reference/` — the old flat-markdown source — are deleted; the plugin's
`skills/` tree is now the only copy. 11 package `README.md` files were repointed from
`docs/reference/*.md` at the new per-package `reference/` files, and `docs/index.md` gained a
Skills line pointing at `plugins/sozai/`.

Every code sample in the 26 files type-checks against the real workspace (`.skill-check/tsconfig.json`,
included by `scripts/check-skills.mjs`'s companion `tsc` pass), and each behavioral claim was read
back against `packages/*/src`. That pass surfaced roughly a dozen real documentation errors, fixed
in place — including an exported function that never existed (`polyfillFetch`), an error code that
was never defined (`PATH_EXISTS`), a code sample that did not compile, and a `MissingHandlerError`
documented as thrown when it is actually returned.

## Still open

- **`/sozai:*` does not resolve for sibling repos yet.** The marketplace is `github`-sourced and
  resolves from `TairuFramework/sozai`'s default branch HEAD, so the six skills only become
  reachable from `@kokuin`/`@enkaku`/`@kumiai` once this branch merges to `main`.
- **kokuin carries the identical gap.** `docs/skills/{discover,auth,capability}.skill.md` exist
  flat, same as sozai's did, with no `plugins/` packaging. It gets its own cycle rather than being
  folded into this one.
- **`kigu:discover-template` documents a terser discover shape than either live instantiation**
  (sozai's or enkaku's). Drift unaddressed by design — out of scope here.
