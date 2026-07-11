# codec — canonicalize emits invalid JSON for nested non-serializable values

**Status:** open · backlog · blocked on upstream · no freeze dependency
**Tracks:** [erdtman/canonicalize#22](https://github.com/erdtman/canonicalize/pull/22)
**Found during:** [2026-07-11 codec freeze fixes](../../../superpowers/specs/2026-07-11-codec-freeze-fixes-design.md)

`canonicalize` 3.0.0 (catalog-pinned, `pnpm-workspace.yaml:27`) serializes a nested
function to invalid JSON rather than dropping the key — a bare `undefined` token in
objects, an elided element in arrays. Nested symbols and `undefined` values are handled
correctly and match `JSON.stringify`:

```js
canonicalize({ a: () => {} })  // '{"a":undefined}'  — not valid JSON
JSON.stringify({ a: () => {} }) // '{}'              — key dropped
```

So `b64uFromJSON({ a: () => {} })` encodes — and downstream `@kokuin/token` signs — a
payload that is not parseable JSON.

Not a freeze blocker, and deliberately left out of the 2026-07-11 codec pass:

- It fails **loudly**, not silently. The invalid JSON blows up at verify-time `JSON.parse`,
  unlike the top-level `undefined` hole (fixed in that pass), which silently produced `""`.
- Passing a function or symbol in a JSON payload is a caller bug in the first place.
- The only in-package guard is `JSON.parse`-ing our own output on every encode, which is real
  cost on the signing hot path — every token, every message.

The fix belongs upstream. `canonicalize#22` addresses it.

## Action

Watch [erdtman/canonicalize#22](https://github.com/erdtman/canonicalize/pull/22). When it
lands and ships:

- Bump the `canonicalize` catalog entry in `pnpm-workspace.yaml`.
- Drop the "upstream limitation" note from `canonicalStringify`'s TSDoc in
  `packages/codec/src/index.ts`.
- Add a test asserting `canonicalStringify({ a: () => {} })` behaves like `JSON.stringify`
  (drops the key) or throws — whichever the upstream fix settles on.

If the PR stalls, the fallback is replacing the dependency with an RFC 8785 (JCS)
implementation. `canonicalStringify` is public frozen API, but its *contract* (deterministic
key ordering) does not change — only the buggy edge case — so a swap stays non-breaking.
