# infra — LICENSE files + changesets fixed-group decision

**Status:** open · freeze-blocker · priority 10
**Source:** [audit 2026-07-02 — repo / infrastructure](../completed/2026-07-02-repo-audit.complete.md#repo--infrastructure)

The ship-blocking infra items — legal and release-correctness. The rest of the infra
findings are hygiene and live in [backlog/infra-hygiene](../backlog/infra-hygiene.md).

## LICENSE (legal ship-blocker)

- **No LICENSE file** — root or per-package — while every manifest declares MIT. npm
  tarballs ship without license text. Add a root LICENSE and per-package copies (or include
  via `files`).

## Changesets — align docs to per-package versioning (decided)

**Decision:** sozai versions per-package, no `fixed` lock between packages. Keep
`.changeset/config.json` `fixed: []` as-is; the docs are what's wrong. This matches the kigu
`development` skill (*per-package via changesets, no hard `fixed` lock* — coupled packages
bumped by releaser judgement).

The audit flagged `fixed: []` as contradicting the docs; the config is correct, so reword the
docs to drop the "fixed group" framing:

- **AGENTS.md** — the "frozen foundation" / "fixed group" language. Reword to "stable group":
  packages ossify and consumers pin `^` ranges, but versions move per-package.
- **`docs/agents/architecture.md`** — same "fixed group with `runtime-expo` independent"
  framing. Reword to "stable, per-package versioning"; `runtime-expo` is no longer a special
  case since nothing is locked.

Already-diverged versions (`otel` 0.2.0 vs 0.1.0 elsewhere) are fine under this model — no
reconciliation needed.
