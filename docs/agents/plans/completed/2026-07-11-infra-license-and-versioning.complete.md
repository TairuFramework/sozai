# infra — LICENSE files + changesets fixed-group decision

**Completed:** 2026-07-11 · freeze-blocker (priority 10)
**Source:** [audit 2026-07-02 — repo / infrastructure](2026-07-02-repo-audit.complete.md#repo--infrastructure)

## LICENSE (legal ship-blocker) — done

Added a root `LICENSE` (MIT, © 2026 Paul Le Cam) and a copy in each of the 14
`packages/*/`. The per-package copies are what matters: npm force-includes a `LICENSE`
at the package root regardless of the `files: ["lib/*"]` field, but it does **not** pull
one from the repo root — so before this, every published tarball shipped without license
text while its manifest declared MIT. Verified with `npm pack --dry-run` in
`packages/async`: `1.1kB LICENSE` now appears in the tarball contents.

## Changesets — per-package versioning (decided, docs aligned) — done

Decision held: sozai versions per-package, `.changeset/config.json` keeps `fixed: []`.
The docs were what contradicted the config, so they were reworded to drop the
"fixed group" framing:

- `AGENTS.md` — "frozen foundation" / "fixed group" → "stable foundation", versions move
  per-package via changesets, `runtime-expo` no longer framed as the one special case.
- `docs/agents/architecture.md` — same change; diverged versions (e.g. `otel` 0.2.0 vs
  0.1.0 elsewhere) are now documented as legitimate rather than an inconsistency.

## Also landed in this pass

Six merged PRs had shipped without changesets, so a release would have published `codec`
and `schema` only and silently left the lifecycle (#3) and stream (#4) work unpublished.
Wrote the missing changesets and ran `changeset version`:

- minor: `async` 0.2.0, `codec` 0.2.0, `execution` 0.2.0, `flow` 0.2.0, `generator` 0.2.0,
  `stream` 0.2.0
- patch: `event` 0.1.1, `schema` 0.1.1, `result` 0.1.1 (dependency-only bump)

Untouched: `log`, `otel`, `patch`, `runtime`, `runtime-expo`.

## Follow-ups (not blockers)

- **No release workflow.** `.github/workflows/` has only `build-test.yml`; publishing is
  manual (`changeset publish`). Worth automating before the freeze.
- `otel`'s `OTEL_PACKAGE_VERSION = '0.1.0'` is hardcoded and already drifted from the
  published 0.2.0 — tracked in [next/otel-w3c-compliance](../next/otel-w3c-compliance.md).
