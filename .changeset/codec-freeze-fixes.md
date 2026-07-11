---
"@sozai/codec": minor
---

Fix the freeze-blocking correctness bugs found in the 2026-07-02 audit. All four are breaking behaviour changes, landed together before the package freezes.

- **`toB64U` now emits unpadded base64url.** RFC 7515 (JWS) and RFC 4648 §5 forbid `=` padding; an Ed25519 signature is 64 bytes and `64 % 3 === 1`, so every JWS signature produced through this codec previously ended in `==`. `toB64` remains padded, per RFC 4648 §4. `fromB64U` still accepts padded input — decode stays lenient, so tokens issued before this release keep verifying.
- **`toUTF` now uses a fatal `TextDecoder`.** Invalid UTF-8 throws a `TypeError` instead of decoding to a U+FFFD-mangled string, and the throw propagates through `b64uToUTF` and `b64uToJSON`. This codec sits under signature verification, where silent substitution let corrupted bytes decode to a plausible string.
- **`canonicalStringify` now throws on values with no JSON representation** (`undefined`, functions, symbols) instead of returning `undefined` typed as `string`, which made `b64uFromJSON` silently encode `""`. It is also no longer marked `@internal` — it is imported outside this package.
- **`fromB64` now validates its input.** It previously accepted malformed base64 — embedded whitespace, base64url characters — and silently decoded it anyway; it now throws. Surrounding whitespace is tolerated (base64 routinely arrives from files, env vars, and CLI flags with a trailing newline), but embedded whitespace and whitespace-only input throw.
