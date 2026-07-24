# package READMEs — one-example overview per package

**Status:** complete
**Date:** 2026-07-24
**Packages:** 12 manifests' `README.md` (docs only — no version bump)
**Source:** the README half of [infra-hygiene](2026-07-24-infra-hygiene.complete.md) (backlog removed
on completion); flagged by the [2026-07-02 audit](2026-07-02-repo-audit.complete.md).

## What was done

Replaced the ~60–110-byte install-only stubs in 12 packages with an overview README each — mirroring
the existing `@sozai/patch` / `@sozai/result` format: H1 + one-line description, `## Installation`
(`pnpm add`), `## Usage` with a single concise, realistic example, and one closing sentence pointing
to the relevant `docs/reference/*.md` for the full API. Overview level, deliberately not deep docs
(23–47 lines each).

Packages: `async`, `codec`, `event`, `execution`, `flow`, `generator`, `log`, `otel`, `runtime`,
`runtime-expo`, `schema`, `stream`. (`lock`, `patch`, `result` already had real READMEs.)

## How

`async` was written by hand as the format exemplar, then the other 11 were fanned out to parallel
subagents — one per package, each instructed to distill the example from its `docs/reference/*.md`
section and verify every imported symbol against the package's real `src/index.ts` exports.

## Verification

- Every README's import line was checked against the package's actual exports — all resolve to real
  symbols (no invented API). Spot example: `@sozai/flow`'s `createFlow` is a genuine export (alongside
  `createGenerator`).
- Line counts 23–47 per file — overview density, consistent with the patch/result template.

## Follow-on filed

- [package the domain skills as a Claude Code plugin](../backlog/2026-07-24-package-skills-as-plugin.md)
  — separate DX item surfaced while reviewing docs structure against `@enkaku`'s packaged skills.
