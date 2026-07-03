# codec — base64url padding decision

**Status:** open · freeze-blocker · priority 6 · decision gate
**Source:** [audit 2026-07-02 — codec](../completed/2026-07-02-repo-audit.complete.md#codec)

Small package, but one API-breaking decision must be made before freeze. JWT-adjacent
consumers sit directly on this layer.

## Decision gate — base64url padding (before freeze)

- **`src/index.ts:67-72` — base64url output is padded.** Tests assert the padding, so it's
  intentional — but RFC 7515 (JWS/JWT) requires *unpadded* base64url. Decide: switch to
  unpadded (and update tests), or document that this codec is deliberately padded and callers
  must strip. API-breaking either way; can't move post-freeze.

## Correctness

- `src/index.ts:16-19` — `canonicalStringify` can return `undefined` typed as `string`
  (hidden by `@ts-expect-error`); `fromUTF(undefined)` then yields an empty array, so
  `b64uFromJSON` silently produces `""` instead of throwing.
- `src/index.ts:84-86` — `toUTF` uses a non-fatal `TextDecoder`; corrupted input decodes to
  U+FFFD-mangled strings instead of failing. For a codec under signatures, use
  `{ fatal: true }` or document the lossy contract.

## Minor

- `src/index.ts:30-34` vs `57-61` — `fromB64U` pre-validates with a regex, `fromB64` doesn't;
  feature-detection style differs between the two paths.
