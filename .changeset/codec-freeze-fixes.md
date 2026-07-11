---
"@sozai/codec": minor
---

Fix the freeze-blocking correctness bugs found in the 2026-07-02 audit. All four are breaking behaviour changes, landed together before the package freezes.

- **`toB64U` now emits unpadded base64url.** RFC 7515 (JWS) and RFC 4648 §5 forbid `=` padding; an Ed25519 signature is 64 bytes and `64 % 3 === 1`, so every JWS signature produced through this codec previously ended in `==`. `toB64` remains padded, per RFC 4648 §4. `fromB64U` still accepts padded input — decode stays lenient, so tokens issued before this release keep verifying.
- **`toUTF` now uses a fatal `TextDecoder`.** Invalid UTF-8 throws a `TypeError` instead of decoding to a U+FFFD-mangled string, and the throw propagates through `b64uToUTF` and `b64uToJSON`. This codec sits under signature verification, where silent substitution let corrupted bytes decode to a plausible string.
- **`canonicalStringify` now throws on values with no JSON representation** (`undefined`, functions, symbols) instead of returning `undefined` typed as `string`, which made `b64uFromJSON` silently encode `""`. It is also no longer marked `@internal` — it is imported outside this package.
- **`fromB64` now validates its input.** It previously accepted malformed base64 — embedded whitespace, base64url characters — and silently decoded it anyway; it now throws. Surrounding whitespace is tolerated (base64 routinely arrives from files, env vars, and CLI flags with a trailing newline), but embedded whitespace and whitespace-only input throw.

## Breaking: encode output changed, not just decode strictness

The bullets above focus on what now *rejects* invalid input. The change that actually bites downstream consumers is on the **encode** side: `toB64U` output is no longer padded (`…==` → `…`) for every byte length where `length % 3 !== 0`. Any base64url string this codec has ever produced that a consumer persisted, compared, hashed, or keyed on — JWK members, database columns, cache/idempotency keys, test snapshots, anything checked with `===` — is **no longer string-equal** to the new output for the same input bytes, even though both decode to the same bytes. Downstream repos must audit every `===`/equality check against a stored base64url value produced by this package, not just re-run their decode paths.

Also: `b64uToJSON` on invalid UTF-8 previously threw a `SyntaxError` (from `JSON.parse` choking on the U+FFFD-mangled string). It now throws a `TypeError` (from the fatal `TextDecoder`, before `JSON.parse` ever runs). Callers matching on error class/name rather than just catching `Error` will break.
