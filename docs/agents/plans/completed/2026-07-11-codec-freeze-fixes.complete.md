# codec — freeze-blocker fixes

**Status:** complete
**Date:** 2026-07-11
**Package:** `@sozai/codec` 0.1.0 → 0.2.0 (`minor`; on a 0.x package a breaking change is a minor bump)
**Branch:** `codec-freeze-fixes` — 17 commits
**Source:** [audit 2026-07-02 — codec](2026-07-02-repo-audit.complete.md#codec)

## Goal

Fix the API-breaking correctness defects in `@sozai/codec` before the package freezes. Once
frozen, the API ossifies and downstream repos (`@kokuin`, `@kubun`, `@enkaku`) pin published
`^` ranges — so none of these could be fixed later. The package sits directly under JWT/JWS
signature verification and private-key loading.

## The decision gate: base64url padding

The audit left this open, assuming padding was intentional because tests asserted it. The
evidence said otherwise, and it was decisive:

- The repo docs already documented `toB64U` as unpadded (`docs/reference/validation.md`,
  `docs/skills/validation.skill.md`). The code emitted `aGVsbG8=`. The docs were right; the
  code was wrong.
- The padding-asserting tests arrived with the initial `Setup` commit — they pinned accidental
  behaviour rather than recording a decision.
- It broke JWS interop. An Ed25519 signature is 64 bytes and `64 % 3 === 1`, so **every**
  `@kokuin/token` JWS signature ended in `==` — a character RFC 7515 §2 does not permit in
  compact serialisation. A JWE `epk.x` (32-byte X25519 key) picked up a single `=`. Those
  tokens were self-consistent but no third-party JWT library would accept them.

**Decision: `toB64U` emits unpadded output.**

## What shipped

**`toB64U` is unpadded.** `toB64` stays **padded** — RFC 4648 §4 mandates it for standard
base64; only the url-safe alphabet is unpadded in the JOSE context. `fromB64U` still *accepts*
padded input: **lenient decode, strict encode**. That asymmetry is deliberate and load-bearing
— it is why tokens issued before this release keep verifying, with no coordinated migration.

**`toUTF` uses a fatal decoder** (`{ fatal: true, ignoreBOM: true }`). Invalid UTF-8 throws a
`TypeError` instead of decoding to U+FFFD-mangled text, and the throw propagates through
`b64uToUTF` and `b64uToJSON`. Under signature verification, a corrupted payload must fail
loudly rather than parse into *a* string. `ignoreBOM` is what makes `toUTF(fromUTF(x)) === x`
actually hold.

**`canonicalStringify` throws instead of lying.** It was declared `: string` but returned
`undefined` for values `canonicalize` cannot serialize, hidden behind a `@ts-expect-error` —
so `b64uFromJSON` silently encoded `""`. It now throws a `TypeError`. It is also no longer
`@internal`: `@kokuin/token` imports it, so it was public in practice and froze that way.

**`fromB64` validates its input**, and **trims surrounding whitespace**. The trim is not a
nicety: `fromB64` is the private-key loader across the stack (`kubun`'s hub-server reads
`PRIVATE_KEY` from the environment through it; `@kokuin/token` re-exports it as
`decodePrivateKey`), and keys arriving from `.env` files, mounted secrets, and CLI flags
routinely carry a trailing newline. Rejecting that would have failed services at boot.
Embedded whitespace still throws — that is the corruption signal worth keeping — and so does
whitespace-only input, so a blank secret cannot silently load as a zero-length key.
`fromB64('')` still returns empty bytes.

`fromB64U` stays fully strict (no trim). The asymmetry is deliberate: `fromB64` takes keys
from files and env vars; `fromB64U` takes JWT segments off the wire, where whitespace is
always corruption.

**Both regexes are now real validators.** The originals checked alphabet and padding *shape*
but not that the padding count matched `dataLength % 4`, so `'AB='`, `'A'`, `'='` slipped past
the guard and threw the *decoder's* error — a different error class depending on the runtime.
The replacements only narrow input that already threw; property-testing against 1500 real JWS
segments and real Ed25519 signature/key sizes confirmed **zero** previously-valid inputs are
newly rejected.

**`stripInternal` is on.** `fromB64atob` / `fromB64Uatob` bypass every guard in the module.
They stay exported at runtime (they are the seam that lets the `atob` fallback be tested on a
runtime that has the native methods), but they no longer appear in the emitted `.d.ts`. The
frozen public type surface is exactly 11 functions.

Feature detection is unified on `typeof ... === 'function'` across all four codec functions.

## Consumer-visible breaks

Recorded in the changeset. The one most likely to bite: **encode output changed.** Any
base64url string this codec produced that a consumer persisted, compared, hashed, or keyed on
(JWK members, DB columns, cache/idempotency keys, test snapshots) is no longer string-equal to
the new value for the same bytes. Downstream repos should audit `===` comparisons against
stored base64url values. Error classes also moved: `b64uToJSON` on invalid UTF-8 threw
`SyntaxError` and now throws `TypeError`; a BOM-prefixed JSON payload that previously parsed
now throws `SyntaxError`.

## Defects the reviews caught (worth remembering)

Four things the plan itself got wrong, all found in review rather than by the plan author:

- **The `fromB64` guard's stated rationale was false.** The plan claimed the native and `atob`
  decoders disagreed on whitespace. Measured across 15 inputs, they agree on every one — the
  native decoder strips whitespace exactly as `atob` does. The guard is a *strictness* fix, not
  an alignment fix. The false story had reached a doc comment, the spec, and the changeset text.
- **The strict guard broke private-key loading** (trailing newlines), which is what forced the
  trim contract above.
- **The trim then opened a new hole:** whitespace-only input trimmed to `''`, matched the regex,
  and returned empty bytes where it had previously thrown.
- **`toUTF` was silently stripping a leading BOM.** No single-task review could see it — a
  per-call decoder had the same default — so it only surfaced in the whole-branch review.

The lesson worth carrying: a per-task review cannot see a defect that is invisible in isolation.
The whole-branch pass earned its cost here twice (BOM, and the decorative `@internal`).

## Verification

68 tests passing; `tsc --noEmit` clean on both configs; biome clean; repo-wide `build:types`
green across all 14 packages. No in-repo package depends on `@sozai/codec` — consumers are
downstream repos on published ranges.

**Tooling trap, recorded because it cost real time:** the `rtk` shim on this machine intercepts
`tsc` / `vitest` / `biome` / `pnpm run` and compresses their output such that **errors read as
successes** — `npx tsc -p ./nonexistent.json` prints "TypeScript: No errors found". Prefix with
`rtk proxy` to get truth, and sanity-probe with a bogus config to confirm the invocation is not
lying.

## Follow-ups

- [canonicalize nested-function bug](../backlog/codec-canonicalize-nested-undefined.md) —
  blocked on upstream.
- [base64 non-canonical encodings](../backlog/2026-07-11-codec-non-canonical-base64.md) —
  accepted for now, documented.
