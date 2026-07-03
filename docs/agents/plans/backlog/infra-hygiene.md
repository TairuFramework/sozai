# infra hygiene — turbo, test scripts, READMEs, keywords

**Status:** open · backlog · no freeze dependency
**Source:** [audit 2026-07-02 — repo / infrastructure](../completed/2026-07-02-repo-audit.complete.md#repo--infrastructure)

Infra findings that don't block the freeze. Legal/release-correctness infra lives in
[next/infra-license-and-versioning](../next/infra-license-and-versioning.md).

## Build orchestration

- **`turbo.json` `clean` task is orphaned:** packages define `build:clean`, not `clean`, so
  `build:js`'s `dependsOn: ["^clean"]` matches nothing. Rename one side. Also `build:types`
  runs via `pnpm run -r` instead of Turbo, losing caching — a `build:types` task with
  `dependsOn: ["^build:types"]` preserves the topological order already relied on.

## Test scripts

- **`test:types` script drift:** `--skipLibCheck` present in ~half the packages, absent in
  the rest; `runtime-expo` points at `tsconfig.json` instead of a test config. Normalize.

## Workspace config

- **`minimumReleaseAgeExclude` set in `pnpm-workspace.yaml` with no `minimumReleaseAge`** — a
  no-op unless the age is set elsewhere (check `@kigu/dev` / global config).

## Package metadata

- **Package READMEs are install-only stubs** (~70 bytes). One usage example per package goes
  a long way for published packages; `docs/reference/*.md` content could seed them.
- **Empty `keywords: []`** in about half the manifests (async, execution, generator, log,
  result, runtime, runtime-expo).

## Resolved by creating this folder

- The audit flagged `docs/index.md:9`'s dead link to `docs/agents/plans/`. Creating the plans
  hierarchy resolves it — no action needed beyond confirming the link renders.
