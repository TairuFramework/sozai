# sozai roadmap

Derived from the [2026-07-02 repo audit](completed/2026-07-02-repo-audit.complete.md).

## Goal

Land every correctness fix **before the API freeze**. sozai is the frozen foundation:
once a package ossifies, consumers (`@kokuin`, `@enkaku`, `@kumiai`) pin published `^`
ranges and the surface can't move. Infrastructure and conventions are already clean; the
open work is the correctness and lifecycle bugs the audit found, plus a few API-shape
decisions that are impossible to reverse after freeze.

## Decision gates — resolve before freeze

These change public API shape and cannot be fixed post-freeze. Decide first.

- ~~**patch — `createPatches(to, from)` argument order.**~~ ✅ **Resolved:** kept `(to, from?)`
  intentionally — `from` is optional (diff-from-empty), so it can't precede a required arg;
  documented as deliberate. → [completed/2026-07-03-patch-rfc6902-compliance](completed/2026-07-03-patch-rfc6902-compliance.complete.md)
- **codec — base64url padding.** RFC 7515 (JWS/JWT) requires *unpadded*; current output is
  padded and tests enshrine it. → [next/codec-base64url-decision](next/codec-base64url-decision.md)
- **result — predicate narrowing.** `isOK()`/`isSome()` false-branch narrows to `never`.
  Pick discriminated subtypes vs. plain `boolean`. → [next/result-option-semantics](next/result-option-semantics.md)

## Freeze-blocker sequence

Follows the audit's suggested order of work (roughly severity × blast radius), with `log`
folded in next to the otel work. Each is a self-contained unit (target: one PR).

1. ✅ **Done** — [patch — RFC 6902 compliance + prototype-pollution fix](completed/2026-07-03-patch-rfc6902-compliance.complete.md) (PR #1). Follow-ups in [backlog/patch-followups](backlog/patch-followups.md).
2. [schema — Ajv instance fixes](next/schema-ajv-fixes.md) — one-line `removeSchema` guard with global blast radius, plus memoization.
3. [runtime-expo — fetch fixes + first real tests](next/runtime-expo-fetch.md) — `polyfillFetch` currently cannot work.
4. [lifecycle pass — cancel timers / remove listeners on settle](next/lifecycle-pass.md) — same pattern across execution/async/generator/flow.
5. [result — map/mapError error handling + predicate design](next/result-option-semantics.md).
6. [codec — base64url padding decision](next/codec-base64url-decision.md) — API-breaking; see decision gates.
7. [stream — abort/cancel propagation + json-lines depth reset](next/stream-robustness.md).
8. [otel — W3C Trace Context compliance](next/otel-w3c-compliance.md).
9. [log — setup() double-configuration guard + first tests](next/log-setup-guard.md) — small crash, pairs with otel.
10. [infra — LICENSE files + changesets fixed-group decision](next/infra-license-and-versioning.md) — ship-blockers.

## Deferred (no freeze dependency)

- [infra hygiene — turbo, test scripts, READMEs, keywords](backlog/infra-hygiene.md).

## Notes

- Every `next/` item carries the audit's `file:line` references and its test-coverage gaps,
  so it can go straight into `/dev-loop` → brainstorming/writing-plans.
- The audit flagged the `docs/agents/plans/` dead link (`docs/index.md`); creating this
  folder resolves it.
