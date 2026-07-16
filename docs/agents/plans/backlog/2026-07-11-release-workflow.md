# infra — no release workflow, publishing is manual

**Status:** open · backlog
**Source:** [completed/2026-07-11-infra-license-and-versioning](../completed/2026-07-11-infra-license-and-versioning.complete.md#follow-ups-not-blockers)
— "worth automating before the freeze". The freeze happened; this didn't.

`.github/workflows/` contains only `build-test.yml` (which delegates to
`TairuFramework/kigu/.github/workflows/build-test.yml@main`). Releasing is a local
`pnpm run release` — `pnpm run build && changeset publish` — run by hand from a developer
machine.

## Why it matters more now than before the freeze

Fifteen packages version independently, so a release round is fifteen possible version bumps from
one `changeset version` run. Manual publishing means the published artifact is whatever was on one
machine's disk, and the `git tag` / npm / `main` states can diverge without anything noticing.

## The work

- Add a changesets release workflow (`changesets/action`): open a "Version Packages" PR as
  changesets accumulate on `main`, publish on merge.
- Check whether kigu already has a reusable release workflow to call, the way `build-test.yml`
  does — if so this is a five-line caller, and it belongs there rather than here. Note the gotcha
  that kigu reusable workflows must reference the setup action by full path, not `./setup`.
- Needs an npm token with publish rights for the `@sozai` scope in repo secrets, and
  `access: "public"` is already set in `.changeset/config.json`.
- `provenance` is worth considering while touching this, since every consumer repo pins these
  packages by `^` range.
