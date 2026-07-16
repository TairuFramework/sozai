# infra hygiene — turbo, test scripts, READMEs, keywords

**Status:** open · backlog · no freeze dependency
**Source:** [audit 2026-07-02 — repo / infrastructure](../completed/2026-07-02-repo-audit.complete.md#repo--infrastructure)

Infra findings that don't block the freeze. Legal/release-correctness infra shipped separately:
[completed/2026-07-11-infra-license-and-versioning](../completed/2026-07-11-infra-license-and-versioning.complete.md).

## Build orchestration

- **`turbo.json` `clean` task is orphaned:** packages define `build:clean`, not `clean`, so
  `build:js`'s `dependsOn: ["^clean"]` matches nothing. Rename one side.
- **The root `build:types` script bypasses Turbo.** The `build:types` *task* now exists in
  `turbo.json` with `dependsOn: ["^build:types"]` (added by the result/option work), but the root
  script is still `"build:types": "pnpm run -r build:types"`, so `pnpm run build` runs it outside
  Turbo and gets no caching. Point the script at `turbo run build:types` — the task already
  preserves the topological order the `-r` run relies on.

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
