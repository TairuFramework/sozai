# codec — freeze-blocker fixes (design)

**Date:** 2026-07-11
**Package:** `@sozai/codec` (0.1.0 → 0.2.0)
**Source:** [next/codec-base64url-decision](../../agents/plans/next/codec-base64url-decision.md) ·
[audit 2026-07-02 — codec](../../agents/plans/completed/2026-07-02-repo-audit.complete.md#codec)

## Problem

`@sozai/codec` is about to freeze. Four correctness defects in `src/index.ts` are
API- or behaviour-breaking, so they cannot be fixed after the freeze. The largest is a
decision gate the audit left open: whether base64url output is padded.

### The padding gate is already decided by the evidence

The audit assumed padding was intentional because tests assert it. It isn't:

- **The docs say unpadded.** `docs/reference/validation.md:94` — "Encode `Uint8Array` to
  URL-safe Base64 (no padding)"; line 120 shows `toB64U(bytes) // "aGVsbG8"`.
  `docs/skills/validation.skill.md:142-143` says the same. The code emits `aGVsbG8=`.
- **The tests came in with the initial `Setup` commit** (`51fc2be`), so they pin accidental
  behaviour rather than record a decision.
- **It breaks JWS interop downstream.** `@kokuin/token` builds JWS/JWE/JWK compact
  serialisations directly on `toB64U`. An Ed25519 signature is 64 bytes, and `64 % 3 === 1`,
  so **every kokuin JWS signature currently ends in `==`** — a character not permitted in JWS
  compact serialisation (RFC 7515 §2 requires unpadded base64url). A JWE `epk.x` (32-byte
  X25519 key) picks up a single `=`. These tokens are self-consistent but no third-party JWT
  library will accept them.

Decision: **`toB64U` emits unpadded output.**

## Scope

`packages/codec/src/index.ts` and `packages/codec/test/lib.test.ts`. No structural change,
no new exports, no removed exports — every fix is behavioural, inside a function that already
exists.

## Changes

### 1. `toB64U` — unpadded (breaking)

Native path passes `omitPadding: true`; the `atob` fallback strips trailing `=` before the
`+/` → `-_` swap.

`toB64` stays **padded** — RFC 4648 §4 mandates padding for standard base64, and only the
url-safe alphabet is used in the unpadded JOSE context.

`fromB64U` is **unchanged**: it keeps accepting padded input. Lenient decode, strict encode.
Native `Uint8Array.fromBase64` accepts both forms (verified: default `lastChunkHandling` is
`'loose'`), and `B64U_RE` already allows `={0,2}`.

Consequence: already-issued padded tokens keep verifying. kokuin's `getVerifiableData`
falls back to a canonical decode-and-compare when the supplied `data` string differs from the
recomputed one, and `fromB64U(token.signature)` tolerates the padding. No coordinated
migration is required.

### 2. `toUTF` — fatal decoder (breaking)

`new TextDecoder('utf-8', { fatal: true })`, hoisted to a module-level const alongside a
`TextEncoder` const. Invalid UTF-8 throws instead of decoding to U+FFFD-mangled text, and the
throw propagates through `b64uToUTF` and `b64uToJSON`.

This package sits under signature verification; a corrupted payload must fail loudly rather
than parse into *a* string. The native `TypeError` surfaces as-is — no wrapping.

### 3. `canonicalStringify` — throws instead of lying (breaking)

`canonicalize` returns `undefined` for `undefined`, functions, and symbols. The
`@ts-expect-error` hides that, the declared `: string` is false, and `fromUTF(undefined)`
yields empty bytes — so `b64uFromJSON` silently produces `""` instead of throwing.

Drop the `@ts-expect-error`; throw a `TypeError` when `canonicalize` returns `undefined`.
Also drop the `@internal` tag: kokuin's `token.ts` already imports `canonicalStringify`, so
it is public in practice and is about to be frozen that way.

### 4. `fromB64` — validation guard (breaking for malformed input)

Add `B64_RE = /^[A-Za-z0-9+/]*={0,2}$/`, mirroring `B64U_RE`, throwing
`Error('Invalid base64 encoding')`.

This is not cosmetic. Without a guard, `fromB64` silently accepts malformed input — embedded
whitespace, base64url characters — on both the native and `atob` paths, decoding it as if
nothing were wrong. The guard is a strictness fix: it makes `fromB64` fail loudly on malformed
input, matching the strictness `fromB64U` already has via `B64U_RE`.

### 5. Feature detection — one style

Today the code mixes a static `typeof Uint8Array.fromBase64 === 'function'` check with an
instance `'toBase64' in bytes` check. Unify on `typeof`:

- `typeof Uint8Array.fromBase64 === 'function'`
- `typeof Uint8Array.prototype.toBase64 === 'function'`

`fromB64atob` / `fromB64Uatob` stay exported. Removing them is breaking, and they are the
seam that lets the fallback path be tested on a runtime that has the native methods.

## Error handling

Three failure modes, all throwing. Nothing returns a sentinel.

| Condition | Thrown |
|---|---|
| Malformed base64 input to `fromB64` | `Error('Invalid base64 encoding')` |
| Malformed base64url input to `fromB64U` | `Error('Invalid base64url encoding')` (existing) |
| Non-serialisable value to `canonicalStringify` | `TypeError` |
| Invalid UTF-8 to `toUTF` | native `TypeError` from the fatal decoder |

## Testing

Rewrite the three `toB64U` padding tests (`test/lib.test.ts:53-72`) to assert the *absence*
of `=` and to match a strict unpadded regex `/^[A-Za-z0-9_-]*$/`. `toB64`'s padding tests
(lines 25-44) stay as they are.

New coverage:

- `toB64U` round-trips through `fromB64U` at all three residue lengths (byte length mod 3 of
  0, 1, and 2)
- `fromB64U` still accepts padded input — the existing tests at lines 93-98 stay, but now
  guard the lenient-decode contract rather than describe our own output
- `fromB64` rejects whitespace, base64url characters (`-`, `_`), and invalid characters
- `toUTF` throws on invalid UTF-8 (`new Uint8Array([0xff])`), and the throw reaches
  `b64uToJSON`
- `canonicalStringify` throws on `undefined`, a function, and a symbol — so `b64uFromJSON`
  can no longer yield `""`
- `fromB64atob` / `fromB64Uatob` exercised directly, covering the fallback path on a runtime
  that has the native methods

## Release

Ships as a changeset. On a 0.x package a breaking behavioural change is a `minor`, so
`@sozai/codec` 0.1.0 → 0.2.0.

Docs need no edit: `docs/reference/validation.md` and `docs/skills/validation.skill.md`
already describe the unpadded contract. The code is what was wrong.

## Known implementation risk

`omitPadding` may be absent from the TypeScript lib types depending on the `lib` setting in
`@kigu/dev/tsconfig.json`. If so, that is a cast at one call site — not a design change.

## Out of scope

Downstream changes in `@kokuin/token`. Its tokens get shorter and lose their `=` characters
once it picks up `@sozai/codec` 0.2.0, which is the point; nothing in kokuin needs to change
for that to work.
