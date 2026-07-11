# codec — base64 accepts non-canonical encodings (JWS malleability)

**Status:** open · backlog · accepted-and-documented · no freeze dependency
**Found during:** [2026-07-11 codec freeze fixes](../completed/2026-07-11-codec-freeze-fixes.complete.md)

`Uint8Array.fromBase64` defaults to `lastChunkHandling: 'loose'`, and the `atob` fallback is
equally forgiving. So the trailing bits of the final base64 chunk are ignored, and multiple
distinct strings decode to identical bytes:

```js
fromB64U('YQ')  // [97]
fromB64U('YR')  // [97]  — same bytes
fromB64U('YS')  // [97]
fromB64U('YZ')  // [97]
```

A 64-byte Ed25519 signature has 4 spare bits in its final chunk, so **16 distinct base64url
strings decode to the same signature**. Same for any payload whose length is not a multiple
of 3.

## Why this matters (and why it probably doesn't yet)

This is signature malleability *at the string level*: the same signature can be written 16
ways, all of which verify. It only becomes a real problem if something downstream treats the
**token string** as an identity — deduplicating on it, using it as a cache or idempotency key,
storing it as a unique column, or checking a replay/nonce set by string equality. If every
such check operates on the decoded bytes or on a canonicalised re-encoding, there is no issue.

Nothing in the stack is known to dedup on token strings today. That should be confirmed rather
than assumed before this is closed.

## Why it was not fixed before the freeze

The obvious fix — passing `lastChunkHandling: 'strict'` to the native decoder — would fix
**only the native path**. The `atob` fallback cannot enforce it, so the two paths would then
disagree: the same input would decode on a runtime without the native methods and throw on one
with them. A runtime-dependent decode outcome in a codec under signature verification is worse
than the malleability it would fix.

Closing this properly means rejecting non-canonical encodings in *both* paths — checking the
trailing bits by hand in the `atob` fallback, or dropping the fallback once every target
runtime ships the native methods.

## Action

1. Audit downstream (`@kokuin`, `@kubun`, `@enkaku`) for any place a base64url token string is
   used as an identity: dedup sets, cache keys, idempotency keys, unique DB columns, replay
   protection. If none exists, this stays a documented quirk.
2. If any is found, fix it there (compare decoded bytes, or re-encode canonically before
   comparing) rather than tightening the codec — that is the cheaper and safer fix.
3. Revisit a strict decoder only when the `atob` fallback can be dropped entirely, so both
   paths cannot diverge.
