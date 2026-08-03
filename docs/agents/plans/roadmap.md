# sozai roadmap

## Where things stand

The API freeze is done. Every correctness fix the [2026-07-02 repo audit](completed/2026-07-02-repo-audit.complete.md)
found has landed, both API-shape decision gates are resolved, and packages are published with
versions diverging per-package as designed (0.1.0–0.3.0). Consumers (`@kokuin`, `@enkaku`,
`@kumiai`) can pin `^` ranges against a surface that is not going to move.

One correctness fix landed late: the [2026-07-16 review](project-loop-state.md) found the audit's
`runtime-expo` findings had never been picked up by any plan — `expoRuntime.fetch` was still
captured at import time. Fixed in that review; the package still has no runtime tests, which is
why it was missed.

Since that roadmap cut, three things landed. The [span ID validation gap](completed/2026-07-19-otel-span-id-validation.complete.md)
found by the W3C review closed (07-19, `@sozai/otel` patch) — it spawned one follow-up, the
log-sink path below. And `@sozai/event` grew [`fire()` plus `EventsSource`/`EventsSink` view
types](completed/2026-07-24-event-fire-and-view-types.complete.md) (07-24, additive minors) — new
API on an unfrozen surface, so the freeze framing still holds. Its cross-repo adopters are future
work. The one in-repo candidate, `@sozai/flow`, was considered on 2026-07-24 and left as-is:
`EventsSink` is an object-of-methods view, not the single bound `emit` function flow hands each
handler, and intersecting the full view would leak `fire()`/`writable()` to handlers for no
consumer need. Resurface only if a real consumer wants it. Third, the codec's invalid-JSON
backlog item — the one entry that was blocked on an upstream PR — closed by taking the documented
fallback: `@sozai/json` now implements RFC 8785 in-repo and `@sozai/codec` drops the third-party
`canonicalize` dependency. That emptied the "blocked upstream" tier, which is gone from the
sequence below.

Three more landed on 2026-08-03, all of them backlog items rather than new work.

`@enkaku/react` moved off the third-party `canonicalize` package onto `@sozai/json`, which had
been waiting only on that package reaching npm. The ESM-interop cast at the call site went with
it. The edit landed in the enkaku repo; nothing here changed.

The codec's non-canonical base64 item closed — **with the opposite outcome to the one this
roadmap predicted**. It was filed on the expectation that the audit would find no consumer
treating a token string as an identity, and would close as a documented quirk. The audit found
one: `@enkaku/server`'s replay cache keyed on the base64url signature *string* when a message
carried no `jti`, and a 64-byte Ed25519 signature has 16 spellings that all verify, so a captured
message could be replayed once per spelling. Both sides are fixed. `@sozai/codec` now rejects
non-canonical encodings by default, with `{ strict: false }` restoring the old behaviour (minor —
breaking for input that was never canonically encoded). Enkaku's replay key re-encodes the
signature canonically, so it no longer depends on the codec version or on padding. The concern
that parked this for a month — that a strict decoder would fix only the native path and make it
disagree with the `atob` fallback — did not survive contact: canonicality is decidable from the
string, in the regex guard, before either decoder runs.

And `@sozai/json`'s cycle detection went back to a `Set`, making canonicalization linear rather
than quadratic in nesting depth.

A fourth closed the same day with **no code change**: the otel log-sink's unguarded context
forwarding. Its research gate — what a real logs SDK does with a zeroed span context — was run
against `@opentelemetry/sdk-logs`, and the SDK already drops an invalid context before it reaches
a log record. [The record](completed/2026-08-03-otel-log-sink-context-forwarding.complete.md)
carries the probe matrix so nobody re-derives it, and notes the scope of the claim: sozai depends
only on the API packages, so a non-reference SDK that stamps without validating would put the
question back.

Nothing left is urgent. What remains is a backlog of known, documented, non-blocking items —
each already carries its own `file:line` references and reasoning, so any of them can go
straight into `/dev-loop`.

## Sequence

Ordered by cost against value, not severity. Nothing here blocks anything else.

### 1. Docs & DX

- **Package READMEs — done [2026-07-24](completed/2026-07-24-package-readmes.complete.md).** The 12
  install-only stubs now carry a one-example overview each, seeded from `docs/reference/*.md` and
  verified against real exports.
- **Package the domain skills as a Claude Code plugin — done
  [2026-07-26](completed/2026-07-26-package-skills-as-plugin.complete.md).** sozai's six domain
  skills now ship as `plugins/sozai/` (26 Markdown files, a 120-line cap enforced by
  `kigu-check-skills` from `@kigu/dev`, configured in `skills-check.json`), registered through a
  `github`-sourced marketplace. `docs/skills/`
  and `docs/reference/` are gone. `/sozai:*` still won't resolve for sibling repos until this
  branch merges to `main`; kokuin carries the identical gap and gets its own cycle.

### 2. Deferred — research-heavy, no affected consumer

- [lock — close the no-boot-ID fallback hole](backlog/2026-07-13-lock-fallback-platforms.md).
  Windows has no boot-ID source, and sandboxed macOS loses one because darwin's comes from
  spawning `sysctl`. Both need clock-independent sources that may not be reachable from Node
  without a native addon — establish that first. Failing that, surface the downgrade rather than
  hide it. Low priority until a consumer lands on an affected platform.

### 3. Waiting on a release

- [stack — roll the strict base64 floor out to token verification](backlog/2026-08-03-codec-strict-floor-rollout.md).
  Nothing consumes the strict decode yet: `@kokuin/token` verifies signatures through whatever
  `@sozai/codec` it resolves, and its floor still admits the lenient `0.3.x`. Bumping it rejects a
  malleable signature at verification, upstream of every consumer. Blocked on the codec minor
  reaching npm. The edits land in kokuin and enkaku, not here.
