# infra hygiene — package READMEs

**Status:** open · backlog · no freeze dependency
**Source:** [audit 2026-07-02 — repo / infrastructure](../completed/2026-07-02-repo-audit.complete.md#repo--infrastructure).
The build/test/config/keyword items from this file were done on
[2026-07-24](../completed/2026-07-24-infra-hygiene.complete.md); only the READMEs remain.

## Package READMEs are install-only stubs

Twelve packages ship ~60–110-byte install-only stubs: `async`, `codec`, `event`, `execution`,
`flow`, `generator`, `log`, `otel`, `runtime`, `runtime-expo`, `schema`, `stream`. (`lock`, `patch`,
`result` already have real content.) One usage example per package goes a long way for a published
package. `docs/reference/*.md` already has content that can seed them.

This is a content pass, not mechanical — each README wants a real minimal example, so it deserves its
own focused session rather than bundling with config hygiene.

## Deliberately not doing here

The other infra-hygiene items are resolved (see the completed record): Turbo `clean` rewired at the
root, root `build:types` routed through Turbo, `test:types --skipLibCheck` normalized across all 15
packages, empty `keywords` filled. `minimumReleaseAgeExclude` was left as-is — the original audit
finding ("no-op") was stale: pnpm v11 defaults `minimumReleaseAge` to 1440, so the `@kigu/*` exclude
is live and correct.
