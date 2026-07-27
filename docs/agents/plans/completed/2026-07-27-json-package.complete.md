# json — `@sozai/json`, replacing the `canonicalize` dependency

**Status:** complete
**Date:** 2026-07-27
**Packages:** `@sozai/json` (new — 0.1.0), `@sozai/codec` (minor — 0.2.0 → 0.3.0)
**Source:** the "codec — canonicalize emits invalid JSON for nested non-serializable values"
backlog item (2026-07-11, now removed), which had been parked awaiting an upstream fix.

## Why the deferral was reversed

The backlog item said the fix belonged upstream and tracked `erdtman/canonicalize#22`. Two facts
changed the calculus:

- **Upstream stalled.** #22 was opened 2026-06-13 by the sole maintainer, one commit, zero review
  comments, no activity since; the repository's last commit was 2026-04-07.
- **The dependency is 47 lines.** Owning it costs less than waiting for it.

The bug also turned out to be three bugs, not one. `canonicalize@3.0.0` emitted invalid JSON by
three separate routes, all verified against the real package:

```js
canonicalize({ a: () => {} })                          // '{"a":undefined}'
canonicalize({ a: { toJSON: () => undefined }, b: 1 }) // '{"a":undefined,"b":1}'
canonicalize([, 1])                                    // '[,1]'
```

Since `@sozai/codec` sits under token signing, each could encode — and a caller could sign — a
payload that `JSON.parse` rejects. **Upstream #22 fixes only the first.** It keeps `.map` over
arrays, which skips holes, and pre-checks the raw property value, which cannot observe what
`toJSON` returns.

## Key design decisions

**`serialize` returns `string | undefined`, and each container decides what an `undefined` child
means** — objects omit the key, arrays emit `null`. This is why all three routes close at once:
there is no separate "is this omitted?" predicate that has to stay in sync with the recursion.
Array elements are visited by index rather than `.map` for the same reason.

**A new package rather than inlining into `@sozai/codec`.** Canonical JSON already has a second
consumer in the stack — `@enkaku/react` depends on `canonicalize` directly — and more will follow
wherever payloads are signed or content-addressed.

**`parse` guards `__proto__` and `constructor`, deliberately not `prototype`.** `JSON.parse` does
not pollute prototypes by itself; the payload is inert until merged. The two guarded keys cover the
two distinct merge paths: `__proto__` via any `[[Set]]`-based copy (`Object.assign`,
`target[k] = v`), and `constructor` via a deep merge walking `constructor.prototype`, which is the
published bypass of `__proto__`-only blocklists. `prototype` is unreachable on a plain-object merge
target without first traversing `constructor`, so guarding it would only add false positives.
The mode defaults to `'allow'`, because `{"constructor": "ACME Corp"}` is legitimate data.

**Error identity is uniform `TypeError`** for values with no canonical representation. This changed
`@sozai/codec`'s observable behaviour: `NaN`, `Infinity` and circular references previously threw
plain `Error`, and `BigInt` reported `JSON.stringify`'s own message. Messages for the first three
are unchanged, and `TypeError extends Error`, so `instanceof Error` catches still hold.

## What was built

`@sozai/json`, dependency-free, exporting `canonicalize(value): string | undefined` and
`parse<T>(json, options?)` with `maxDepth` (default 128) and `protoKeys`. `@sozai/codec` dropped
the `canonicalize` dependency and its private `checkJSONDepth`, keeping every public signature
intact. The `canonicalize` catalog entry is gone from `pnpm-workspace.yaml`.

Correctness rests on the six official RFC 8785 vectors from `cyberphone/json-canonicalization`,
vendored byte-exact under `packages/json/test/vectors/` with Apache-2.0 attribution. They are
**downloaded, never retyped** — they carry precomposed characters, raw C0/C1 controls, and a
surrogate pair whose ordering is the point of the `weird` vector, and a copy-paste round trip
silently decomposes U+FB33 and inverts the expected sort order. Root `biome.json` excludes that
directory: biome reformatted 11 of the 12 fixtures on first run, so the exclusion is load-bearing.

45 tests in `@sozai/json`, 72 in `@sozai/codec`.

## Provenance note

The serializer was written twice. The first version reproduced the structure of upstream PR #22 —
Apache-2.0 — while the package's attribution file claimed `src/` was original work. The final
whole-branch review caught the contradiction and the serializer was rewritten independently from
the RFC and the test suite, decomposed by value kind across seven functions with an ancestor stack
in place of a `Set`. The re-review judged it a genuine independent expression, with the caveat that
it is clean-room-*ish* rather than a true clean room, since the author had seen the original shape.
Four error message strings were deliberately kept: they are asserted by tests and documented as
`@sozai/codec` behaviour.

Only the test fixtures are Apache-2.0; `src/` is MIT like the rest of the repo.

## Follow-on

- [json — cycle detection is O(depth) per node](../backlog/2026-07-27-json-cycle-detection-complexity.md)
- [enkaku — migrate `@enkaku/react` off the `canonicalize` dependency](../backlog/2026-07-27-enkaku-react-canonicalize-migration.md)

`erdtman/canonicalize#22` no longer needs watching — sozai has no dependency on that package.
