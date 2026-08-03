# @sozai/codec

## 0.4.0

### Minor Changes

- Reject non-canonical base64 by default in `fromB64` and `fromB64U`.

  The final chunk of a base64 string carries bits that encode nothing -- 4 spare bits for a one-byte tail, 2 for a two-byte tail -- and decoders ignore them. So 16 distinct strings decoded to the same one-byte tail and 4 to the same two-byte tail. For a 64-byte Ed25519 signature that meant **16 distinct base64url strings for one signature, all of which verify**: string-level malleability, dangerous anywhere the encoded string itself is treated as an identity (a dedup key, a cache or idempotency key, a replay set, a unique column).

  Both decoders now require those spare bits to be zero. `fromB64(input, { strict: false })` and `fromB64U(input, { strict: false })` restore the previous lenient behaviour, via the new exported `DecodeOptions` type.

  Canonicality is decided from the string, in the regex guard, before either decode path runs -- so the native `Uint8Array.fromBase64` path and the `atob` fallback accept exactly the same inputs. The earlier concern that a strict decoder would make the two paths disagree does not apply to this approach, and the fallback stays.

  **Breaking for input that is not canonically encoded.** Every encoder in the stack emits canonical output, so round-tripped data is unaffected; third-party or hand-written encodings may now throw. Padding is a separate axis and is untouched: a padded and an unpadded spelling of the same bytes both still decode, so callers needing exactly one spelling per value must re-encode rather than rely on `strict`.

## 0.3.0

### Minor Changes

- f7335f2: New `@sozai/json` package: RFC 8785 canonical JSON serialization and depth-limited, optionally
  prototype-safe parsing, with no runtime dependencies. `@sozai/codec` now uses it and drops the
  `canonicalize` dependency.

  This fixes invalid JSON output for values with no JSON representation. `canonicalize@3.0.0`
  emitted a bare `undefined` token for a nested function (`{"a":undefined}`), an elided element for
  one inside an array (`[,1]` for a sparse hole), and the same bare token when a `toJSON` method
  returned `undefined` — so `b64uFromJSON` could encode, and a caller could sign, a payload that
  `JSON.parse` rejects. All three now match `JSON.stringify`: the key is omitted in objects and the
  element becomes `null` in arrays.

  Also aligned with `JSON.stringify`: boxed primitives are unwrapped (`new Number(5)` serializes as
  `5`, not `{}`), each property is read exactly once, so getters fire once, and a `toJSON` method is
  now called with the property key rather than no arguments — `{ k: { toJSON: (key) => String(key) } }`
  was `'{"k":"undefined"}'` and is now `'{"k":"k"}'`, which is user-visible for any custom `toJSON`
  that inspects its arguments.

  Breaking for anyone matching on error identity: `canonicalStringify` now throws `TypeError`
  rather than `Error` for `NaN`, `Infinity` and circular references, and reports
  `'BigInt is not allowed'` rather than `'Do not know how to serialize a BigInt'`. Messages for the
  first three are unchanged, and `TypeError extends Error`, so `instanceof Error` checks still hold.

### Patch Changes

- Updated dependencies [f7335f2]
  - @sozai/json@0.1.0

## 0.2.0

### Minor Changes

- 0a935fb: Fix the freeze-blocking correctness bugs found in the 2026-07-02 audit. The following are all breaking behaviour changes, landed together before the package freezes.

  - **`toB64U` now emits unpadded base64url.** RFC 7515 (JWS) and RFC 4648 §5 forbid `=` padding; an Ed25519 signature is 64 bytes and `64 % 3 === 1`, so every JWS signature produced through this codec previously ended in `==`. `toB64` remains padded, per RFC 4648 §4. `fromB64U` still accepts padded input — decode stays lenient, so tokens issued before this release keep verifying.
  - **`toUTF` now uses a fatal `TextDecoder`.** Invalid UTF-8 throws a `TypeError` instead of decoding to a U+FFFD-mangled string, and the throw propagates through `b64uToUTF` and `b64uToJSON`. This codec sits under signature verification, where silent substitution let corrupted bytes decode to a plausible string.
  - **`canonicalStringify` now throws on values with no JSON representation** (`undefined`, functions, symbols) instead of returning `undefined` typed as `string`, which made `b64uFromJSON` silently encode `""`. It is also no longer marked `@internal` — it is imported outside this package.
  - **`fromB64` now validates its input.** It previously accepted malformed base64 — embedded whitespace, base64url characters — and silently decoded it anyway; it now throws. Surrounding whitespace is tolerated (base64 routinely arrives from files, env vars, and CLI flags with a trailing newline), but embedded whitespace and whitespace-only input throw.
  - **`toUTF` no longer strips a leading BOM.** The decoder now sets `ignoreBOM: true`, so `toUTF(fromUTF(x)) === x` holds for every `x`, including one that starts with U+FEFF — previously the BOM was silently dropped on decode, breaking the round trip. The trade-off runs the other way through `b64uToJSON`: a base64url payload whose decoded bytes begin with the UTF-8 BOM (`EF BB BF`) now has that BOM survive into `JSON.parse`, which rejects it and throws a `SyntaxError`. This is the correct trade for a codec sitting under signature verification — round-trip fidelity matters more than silently swallowing a BOM, and JWT payloads do not carry one — but it is a behavior change from before.
  - **`fromB64`/`fromB64U` now validate padding count, not just padding shape.** The earlier guards checked alphabet and allowed 0–2 trailing `=` characters, but not that the padding count actually matches the data length (`dataLength % 4`). Malformed input like `'A'`, `'YQ='`, or `'AB='` used to leak past the guard and reach the underlying decoder, which threw its own runtime-dependent error (a `DOMException` from `atob`, or an error from `Uint8Array.fromBase64`). It now throws the documented `Error('Invalid base64 encoding')` / `Error('Invalid base64url encoding')` consistently instead — every input that previously threw still throws, but callers matching on error class/message for these edge cases will see a different one.
  - **`fromB64atob`/`fromB64Uatob` are stripped from the published type declarations** (`stripInternal`, honouring the `@internal` tag they already carried). They remain exported at runtime as a test/fallback seam, but no longer appear in `lib/index.d.ts`. Not breaking in practice — nothing in the stack imports either helper — but called out since it narrows the public typed surface right before the freeze.

  ## Breaking: encode output changed, not just decode strictness

  The bullets above focus on what now _rejects_ invalid input. The change that actually bites downstream consumers is on the **encode** side: `toB64U` output is no longer padded (`…==` → `…`) for every byte length where `length % 3 !== 0`. Any base64url string this codec has ever produced that a consumer persisted, compared, hashed, or keyed on — JWK members, database columns, cache/idempotency keys, test snapshots, anything checked with `===` — is **no longer string-equal** to the new output for the same input bytes, even though both decode to the same bytes. Downstream repos must audit every `===`/equality check against a stored base64url value produced by this package, not just re-run their decode paths.

  Also: `b64uToJSON` on invalid UTF-8 previously threw a `SyntaxError` (from `JSON.parse` choking on the U+FFFD-mangled string). It now throws a `TypeError` (from the fatal `TextDecoder`, before `JSON.parse` ever runs). Callers matching on error class/name rather than just catching `Error` will break.
