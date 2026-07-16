# Project Loop State

| Activity | Last performed |
|----------|---------------|
| Triage | 2026-07-16 |
| Review | 2026-07-16 |
| Roadmap | 2026-07-16 |

Roadmap and next/backlog seeded from the [2026-07-02 repo audit](completed/2026-07-02-repo-audit.complete.md).
Rewritten 2026-07-16: freeze-blocker sequence complete, roadmap re-cut as a backlog burndown.

## 2026-07-16 review

First review. Findings and disposition:

- **`runtime-expo` fetch captured at import time — fixed.** The audit flagged it; no plan ever
  covered `runtime-expo`, so it was never picked up. `expoRuntime.fetch` now delegates at call
  time, matching `@sozai/runtime`. Its sibling finding (`polyfillFetch` no-op) had been fixed
  incidentally in the patch PR (#1) with no plan record.
- **Untracked follow-ups filed:** [runtime-expo-tests](backlog/2026-07-16-runtime-expo-tests.md),
  [release-workflow](backlog/2026-07-11-release-workflow.md).
- **Doc drift fixed:** `AGENTS.md` restated conventions-skill rules and pointed at kigu's
  `repo-split-design.md` (deleted 2026-07-01, replaced by `stack.md`); `docs/index.md` linked a
  non-existent `plans/next/`; `backlog/2026-07-02-infra-hygiene.md`'s `build:types` claim was half-stale.
- **Conventions:** clean on 6 of 8 sampled rules; one suppressed `any` with a stated reason.
  Constructor-params drift (single `ClassNameParams` object) at `execution/src/execution.ts:47`,
  `schema/src/errors.ts:39`, `patch/src/apply.ts:21`, `flow/src/flow.ts:14`, and 5
  `*Options`-named sites in `async/src/interruptions.ts`. **Accepted, not fixed:** these are
  frozen public constructors, so conforming costs a major per package for a style rule with no
  correctness content. Do not re-raise without a reason to break the surface.
- **Open question, belongs in kigu:** `docs/skills/` (6 tracked `*.skill.md`, the
  `kigu:discover-template` instantiation) is absent from the canonical repo layout in the
  `kigu:conventions` skill §7.

## 2026-07-16 triage

First triage. Nothing stale (oldest item traces to the 07-02 audit, 14 days), nothing removed,
merged, or demoted — every item is still live.

- **All 9 backlog files are now date-prefixed**, matching `completed/`. Six had no prefix, which
  made them invisible to the project-loop staleness rule that keys off exactly that prefix. Dates
  are found-dates, matching the source work. Inbound links updated in `roadmap.md`, this file, and
  three `completed/` records.
- **Upstream intel on [codec-canonicalize-nested-undefined](backlog/2026-07-11-codec-canonicalize-nested-undefined.md)
  — not yet folded into the file.** `erdtman/canonicalize#22` is authored by erdtman, the sole
  maintainer, opened 2026-06-13 and unmerged a month later. Release cadence is roughly annual
  (2.1.0 in 2025-03, 3.0.0 in 2026-04, still latest and what the catalog pins). So "bump the
  catalog when it ships" plausibly means waiting into 2027, and the RFC 8785 swap deserves more
  weight than the file's framing of it as a stall-fallback. Re-check the PR quarterly, not per
  triage.
- **Promotions to `next/` proposed and not taken:** `2026-07-16-runtime-expo-tests` (the 07-16
  fetch fix is the one known gap with no test behind it) and `2026-07-14-otel-span-id-validation-gap`
  (two lines plus a test, top of the roadmap's quick wins).
