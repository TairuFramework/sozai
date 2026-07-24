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

Since that roadmap cut, two things landed. The [span ID validation gap](completed/2026-07-19-otel-span-id-validation.complete.md)
found by the W3C review closed (07-19, `@sozai/otel` patch) — it spawned one follow-up, the
log-sink path below. And `@sozai/event` grew [`fire()` plus `EventsSource`/`EventsSink` view
types](completed/2026-07-24-event-fire-and-view-types.complete.md) (07-24, additive minors) — new
API on an unfrozen surface, so the freeze framing still holds. Its cross-repo adopters are future
work. The one in-repo candidate, `@sozai/flow`, was considered on 2026-07-24 and left as-is:
`EventsSink` is an object-of-methods view, not the single bound `emit` function flow hands each
handler, and intersecting the full view would leak `fire()`/`writable()` to handlers for no
consumer need. Resurface only if a real consumer wants it.

Nothing left is urgent. What remains is a backlog of known, documented, non-blocking items —
each already carries its own `file:line` references and reasoning, so any of them can go
straight into `/dev-loop`.

## Sequence

Ordered by cost against value, not severity. Nothing here blocks anything else.

### 1. Docs & DX

- **Package READMEs — done [2026-07-24](completed/2026-07-24-package-readmes.complete.md).** The 12
  install-only stubs now carry a one-example overview each, seeded from `docs/reference/*.md` and
  verified against real exports.
- [package the domain skills as a Claude Code plugin](backlog/2026-07-24-package-skills-as-plugin.md).
  sozai's six `docs/skills/*.skill.md` already declare invocable names (`sozai:discover`) and
  cross-reference each other and sibling repos as `/sozai:*` commands, but without plugin packaging
  none resolve — while `@enkaku` has already packaged its skills (`../enkaku/plugins/enkaku/`) and
  points outward at `/sozai:*`. Real cross-repo DX gap; content exists. Coordinate the layout with
  `kigu:discover-template` first.

### 2. Needs a cross-repo audit first

- [codec — base64 accepts non-canonical encodings](backlog/2026-07-11-codec-non-canonical-base64.md).
  Signature malleability at the string level. Only bites if something downstream treats a token
  string as an identity. Audit `@kokuin` / `@kubun` / `@enkaku` for dedup sets, cache keys,
  idempotency keys, unique columns, replay sets. If none — and none is known today — this closes
  as a documented quirk. If one exists, fix it there, not in the codec.

### 3. Blocked upstream — watch, don't work

- [codec — canonicalize emits invalid JSON for nested non-serializable values](backlog/2026-07-11-codec-canonicalize-nested-undefined.md).
  Tracks [erdtman/canonicalize#22](https://github.com/erdtman/canonicalize/pull/22). Fails loud,
  caller bug to trigger. Bump the catalog entry when it ships. Fallback if the PR stalls: swap in
  an RFC 8785 implementation — non-breaking, the contract doesn't change.

### 4. Deferred — research-heavy, no affected consumer

- [otel — log-sink forwards the active context unguarded](backlog/2026-07-19-otel-log-sink-context-forwarding.md).
  Same zero-ID class the 07-19 guards closed, reached via the logs SDK path instead. Impact is
  unverified — the ID-stamping lives in whatever logs SDK the consumer installs, so establish what
  a real SDK does with a zeroed context before deciding whether it needs a guard at all. The
  predicate (`isValidSpanContext`) already exists internally. No affected consumer; may close as a
  documented quirk.
- [lock — close the no-boot-ID fallback hole](backlog/2026-07-13-lock-fallback-platforms.md).
  Windows has no boot-ID source, and sandboxed macOS loses one because darwin's comes from
  spawning `sysctl`. Both need clock-independent sources that may not be reachable from Node
  without a native addon — establish that first. Failing that, surface the downgrade rather than
  hide it. Low priority until a consumer lands on an affected platform.
