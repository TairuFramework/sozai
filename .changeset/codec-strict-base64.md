---
'@sozai/codec': minor
---

Reject non-canonical base64 by default in `fromB64` and `fromB64U`.

The final chunk of a base64 string carries bits that encode nothing -- 4 spare bits for a one-byte tail, 2 for a two-byte tail -- and decoders ignore them. So 16 distinct strings decoded to the same one-byte tail and 4 to the same two-byte tail. For a 64-byte Ed25519 signature that meant **16 distinct base64url strings for one signature, all of which verify**: string-level malleability, dangerous anywhere the encoded string itself is treated as an identity (a dedup key, a cache or idempotency key, a replay set, a unique column).

Both decoders now require those spare bits to be zero. `fromB64(input, { strict: false })` and `fromB64U(input, { strict: false })` restore the previous lenient behaviour, via the new exported `DecodeOptions` type.

Canonicality is decided from the string, in the regex guard, before either decode path runs -- so the native `Uint8Array.fromBase64` path and the `atob` fallback accept exactly the same inputs. The earlier concern that a strict decoder would make the two paths disagree does not apply to this approach, and the fallback stays.

**Breaking for input that is not canonically encoded.** Every encoder in the stack emits canonical output, so round-tripped data is unaffected; third-party or hand-written encodings may now throw. Padding is a separate axis and is untouched: a padded and an unpadded spelling of the same bytes both still decode, so callers needing exactly one spelling per value must re-encode rather than rely on `strict`.
