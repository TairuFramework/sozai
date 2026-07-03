# log — setup() double-configuration guard + first tests

**Status:** open · freeze-blocker · priority 9
**Source:** [audit 2026-07-02 — log](../completed/2026-07-02-repo-audit.complete.md#log)

Small package, real crash. Not in the audit's numbered order but sits in the critical
section. Pairs naturally with the otel observability work.

## Correctness

- **`src/index.ts:29-31` — `setup()` throws if configuration already happened**
  (`configureSync` errors on double configuration); two independent consumers calling
  `setup()` crash. Guard with a flag or expose a reset.

## Testing

- **No test directory at all.** Add coverage for the guard and basic setup.
