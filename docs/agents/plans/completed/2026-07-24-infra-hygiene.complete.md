# infra hygiene — build/test/config batch

**Status:** complete
**Date:** 2026-07-24
**Packages:** repo root + all 15 package manifests (no version bump — tooling/metadata only)
**Source:** [backlog/2026-07-02-infra-hygiene](../backlog/2026-07-02-infra-hygiene.md) (READMEs half
remains there); from the [2026-07-02 audit](2026-07-02-repo-audit.complete.md).

The mechanical half of the infra-hygiene item. READMEs (12 stubs) were split out as a content pass.

## What was done

- **Turbo `clean` rewired at the root.** `turbo.json` had a `clean` task and `build:js`'s
  `dependsOn: ["^clean"]` that matched no package script (packages define `build:clean`) — doubly
  broken, since `^` is *upstream* scope, not self. Removed both. The real gap it was meant to plug:
  the root `build` runs the `build:types` and `build:js` *tasks* directly, so it never invoked
  `build:clean` (only each package's own `build` *script* does). Fixed by cleaning once at the root:
  `build` is now `pnpm run clean && pnpm run build:types && pnpm run build:js`, with a new
  `"clean": "pnpm -r build:clean"`. Clean must run once before both passes — making it a per-task
  dependency would have the second pass (`build:js`/`build:types` share `lib/`) wipe the first's
  output. Verified: a full `pnpm run build` produces `lib/` with both `.js` and `.d.ts` present.
- **Root `build:types` routed through Turbo.** Was `pnpm run -r build:types`, bypassing Turbo's
  cache; now `turbo run build:types`. The `build:types` task already carries `dependsOn:
  ["^build:types"]`, preserving the topological order the `-r` run relied on.
- **`test:types` normalized.** `--skipLibCheck` was present in 9 packages, absent in 6 (codec, event,
  generator, runtime, schema, stream). Standardized ON across all 15. Safe direction: `--skipLibCheck`
  only skips checking *dependency* `.d.ts`; a package's own src/test stay fully checked, so adding it
  to already-passing packages cannot break them. (runtime-expo's `tsconfig.json`→`tsconfig.test.json`
  was fixed in the same day's runtime-expo work.)
- **Empty `keywords` filled** for the 8 that had none: async, execution, generator, lock, log,
  result, runtime, runtime-expo.

## Decided, no change

- **`minimumReleaseAgeExclude` left as-is.** The audit flagged it as a no-op ("`minimumReleaseAge`
  not set"). That finding was stale: **pnpm v11 defaults `minimumReleaseAge` to 1440** (24h), and the
  repo runs pnpm@11.15.1, so the setting is live and the `@kigu/*` exclude correctly lets local stack
  deps install immediately while third-party packages wait a day. Confirmed against the pnpm docs.
- **`docs/index.md` dead link** — already resolved by the plans hierarchy existing; renders fine.

## Deferred

- **Package READMEs** — 12 install-only stubs. A content pass (one usage example each, seeded from
  `docs/reference/*.md`); kept in the backlog for its own session.

## Verification

- Full `pnpm test` (test:types + test:unit, 15 packages): 44/44 Turbo tasks green.
- `pnpm run build` clean → both `.js` and `.d.ts` land in `lib/`.
- biome clean on `package.json`, `turbo.json`, and all package manifests.
