# tooling — package the domain skills as a Claude Code plugin

**Status:** open · backlog · DX / cross-repo consistency
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

## The work, if picked up

- Stand up `plugins/sozai/` mirroring `../enkaku/plugins/enkaku/`: a `.claude-plugin/plugin.json`
  (name `sozai`, description, author) and `skills/<name>/SKILL.md` for each of the six domains.
- Move/convert the `docs/skills/*.skill.md` content into that structure. Decide whether `docs/skills/`
  remains (as source, or a symlink/generated view) or is replaced — coordinate with what
  `kigu:discover-template` expects, since that skill defines the template these instantiate.
- Verify every intra-repo (`/sozai:<domain>`) and cross-repo (`/enkaku:*`, `/kokuin:*`, `/kumiai:*`)
  reference resolves once packaged.
- Confirm the discover → domain-skill progressive flow works end to end when invoked.

## Why it matters / why not urgent

Real DX value: the stack's convention is skill-based capability discovery across repos, and sozai is
the common downward dependency everyone's discover skill points at — so the dead-end is felt from
every sibling repo. But nothing is *broken* at runtime; it is a docs/tooling packaging gap, and the
content already exists. Coordinate the structure with `kigu:discover-template` (and check whether
`@kokuin`/`@kumiai` have packaged theirs yet) before committing to a layout, so the stack stays
consistent rather than sozai inventing a third shape.
