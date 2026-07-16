# sozai

> **For AI agents:** 素材 ("raw material") — the core utility layer of the stack.
> Conventions: `kigu:conventions` skill (canonical — do not restate).
> Stack map / sibling docs: `kigu:stack-map` skill.

## What this repo is

The stable foundation — low-altitude packages that everything else (identity, RPC, MLS)
depends downward on. Packages here ossify; consumers (`@kokuin`, `@enkaku`, `@kumiai`)
depend on published `^` ranges, never `workspace:`. Versions move per-package via
changesets — there is no `fixed` lock, so versions diverge as each package bumps.
`runtime-expo` tracks the Expo SDK but is not otherwise special. Package list and
positioning: [docs/agents/architecture.md](./docs/agents/architecture.md).

## Guardrails

See the `kigu:conventions` skill. Repo-specific only: pnpm only; do not edit generated
files (`lib/`); all dev tooling and shared configs come from `@kigu/dev` — extend
`@kigu/dev/tsconfig.json`, `["@kigu/dev/biome.json"]`, and `@kigu/dev/swc.json`.

Stack overview — roles, downward dependency graph, shared toolchain and CI:
https://github.com/TairuFramework/kigu/blob/main/docs/stack.md
