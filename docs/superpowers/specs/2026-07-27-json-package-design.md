# `@sozai/json` — canonical JSON serialization and hardened parsing

**Date:** 2026-07-27
**Branch:** `feat/json-package`
**Resolves:** [codec — canonicalize emits invalid JSON for nested non-serializable values](../../agents/plans/backlog/2026-07-11-codec-canonicalize-nested-undefined.md)

## Problem

`@sozai/codec` depends on `canonicalize@3.0.0` for RFC 8785 serialization. That package
serializes a *nested* function to invalid JSON — a bare `undefined` token in objects, an elided
element in arrays — instead of dropping the key:

```js
canonicalize({ a: () => {} })   // '{"a":undefined}'  — not parseable JSON
JSON.stringify({ a: () => {} }) // '{}'               — key dropped
```

So `b64uFromJSON({ a: () => {} })` encodes, and `@kokuin/token` signs, a payload that cannot be
parsed back.

The 2026-07-11 codec pass deferred this upstream because it fails loudly at verify-time
`JSON.parse` rather than silently, and passing a function in a JSON payload is a caller bug.
The upstream fix is [erdtman/canonicalize#22](https://github.com/erdtman/canonicalize/pull/22),
authored by the sole maintainer on 2026-06-13, with one commit, zero review comments, and no
activity since. The repo's last commit is 2026-04-07. It is stalled, not contested.

Meanwhile the dependency is 47 lines of source. The cost of owning it is lower than the cost of
waiting on it.

## Decision

Write `@sozai/json`: a dependency-free package providing RFC 8785 canonicalization and
depth-limited, prototype-safe JSON parsing. `@sozai/codec` consumes it and drops `canonicalize`.

A new package rather than inlining into codec, because canonical JSON has a second consumer in
the stack already — `@enkaku/react` imports `canonicalize` directly, with an ESM-interop cast
workaround — and more will follow wherever payloads are signed or content-addressed.

## Non-goals

- Submitting or adopting upstream #22. It is a reference for settled semantics, nothing more.
- Migrating `@enkaku/react`. Separate repo; a follow-up once `@sozai/json` publishes.
- Vendoring the ES6 number test vector (100M lines, hosted as a 
  [release artifact](https://github.com/cyberphone/json-canonicalization/releases/download/es6testfile/es6testfile100m.txt.gz)).
  Number serialization is delegated wholesale to `JSON.stringify`, which is specified to produce
  exactly the RFC's format; the file remains available for one-off validation.

## Package

`packages/json/` → `@sozai/json` v0.1.0, "Canonical JSON serialization and hardened parsing".
**No runtime dependencies.** Standard sozai skeleton: `package.json`, `tsconfig.json`,
`tsconfig.test.json`, `LICENSE`, `README.md`, `src/index.ts`, `test/`.

```ts
export function canonicalize(value: unknown): string | undefined

export type ParseOptions = {
  maxDepth?: number
  protoKeys?: 'allow' | 'strip' | 'reject'
}
export function parse<T = unknown>(json: string, options?: ParseOptions): T
```

`canonicalize` returns `undefined` when the **input itself** is non-serializable (`undefined`, a
function, a symbol), matching `JSON.stringify`. Callers needing a guaranteed string wrap it and
throw — `@sozai/codec`'s `canonicalStringify` already does exactly this.

## `canonicalize` semantics

### RFC 8785 conformance

| Requirement | Implementation |
|---|---|
| §3.2.3 — object keys sorted by UTF-16 code units | `Object.keys(o).sort()`; JS default string comparison is code-unit order |
| §3.2.2 — numbers per ECMAScript `Number::toString` | `JSON.stringify(number)` |
| §3.2.1 — strings, minimal escaping, well-formed output | `JSON.stringify(string)`; ES2019 well-formed stringify escapes lone surrogates as `\udXXX` |
| §3.2.2.2 — `NaN` and `Infinity` are not representable | `TypeError` |
| Literal `null`, `true`, `false` | `JSON.stringify` |

### ECMAScript data-model alignment

Behaviour matches `JSON.stringify` on every point where the RFC defers to the ES serializer:

- `toJSON` is honored, invoked as `toJSON.call(value, key)` with the property key.
- Boxed primitives are unwrapped — `new Number(5)` serializes as `5`, not `{}`.
- Property values are read exactly once, so getters fire once.
- Non-serializable values (`undefined`, symbols, **functions**) are omitted from objects and
  become `null` in arrays. **This is the bug being fixed.**
- A `toJSON` that returns `undefined`, a function, or a symbol is treated the same way — the key
  is omitted, not emitted as `"a":undefined`.
- Sparse array holes serialize as `null`, not as elided elements.

The last two are the same defect class as the reported bug — invalid JSON produced from a
non-serializable value — reached by different routes, and both are verified present in
`canonicalize@3.0.0`:

```js
canonicalize({ a: { toJSON: () => undefined }, b: 1 })  // '{"a":undefined,"b":1}'
canonicalize([, 1])                                     // '[,1]'
```

Upstream #22 fixes neither: it keeps `.map` over arrays, which skips holes, and it pre-checks the
raw property value, which cannot see what `toJSON` returns. Both fall out for free from the
structure chosen here — `serialize` returns `string | undefined` and each container decides what
an `undefined` child means (omit the key; emit `null` for an element), so there is no separate
"is this omitted?" predicate to keep in sync. Array elements are visited by index rather than
`.map` for the same reason.

### Errors

All non-representable values throw `TypeError`:

| Input | Message |
|---|---|
| `NaN` | `'NaN is not allowed'` |
| `Infinity` / `-Infinity` | `'Infinity is not allowed'` |
| `BigInt` | `'BigInt is not allowed'` |
| Circular reference | `'Circular reference detected'` |

This changes what `@sozai/codec` surfaces today, where the first three are plain `Error` and
`BigInt` yields `JSON.stringify`'s own `TypeError('Do not know how to serialize a BigInt')`.
`TypeError extends Error`, so `catch` blocks and `instanceof Error` checks are unaffected; only
the exact constructor and one message move. Uniform typing is worth that.

Deeply nested input may throw `RangeError` from stack exhaustion, as `JSON.stringify` does.

## `parse` semantics

### Depth

The string-aware pre-scan lifted verbatim from `@sozai/codec`'s private `checkJSONDepth`: walk
the raw text tracking string and escape state, count `{`/`[` against `}`/`]`, throw when the
counter exceeds the limit. Runs before `JSON.parse`, so a hostile payload never reaches the
parser.

- Default `maxDepth: 128` — today's value in codec.
- Throws `Error('JSON exceeds maximum nesting depth of N')` — unchanged class and message.

### Prototype keys

`protoKeys` defaults to `'allow'`, preserving today's behaviour exactly. No caller gets a
silent semantic change.

- `'allow'` — plain `JSON.parse`.
- `'strip'` — a reviver returns `undefined` for a guarded key, deleting the property.
- `'reject'` — throws `TypeError('Forbidden key: <key>')`.

Guarded keys: **`__proto__` and `constructor`.**

`JSON.parse` does not pollute prototypes on its own — `JSON.parse('{"__proto__":{}}')` creates
an ordinary own data property and leaves the prototype untouched. The payload is inert until a
consumer merges it, and the two keys cover the two distinct merge paths:

- `__proto__` — any `[[Set]]`-based copy (`Object.assign`, `target[k] = v` inside a hand-rolled
  merge) triggers the inherited `__proto__` setter and reassigns the prototype. Spread
  (`{...parsed}`) uses `CreateDataProperty` and is safe.
- `constructor` — the deep-merge path.
  `merge({}, JSON.parse('{"constructor":{"prototype":{"isAdmin":true}}}'))` walks
  `target.constructor` up the chain to `Object`, then `.prototype`, then writes. This is the
  published bypass of `__proto__`-only blocklists.

An opt-in guard that ships a known bypass grants false assurance, so both are covered.

`prototype` is deliberately **not** guarded. On a plain-object merge target `.prototype` is
`undefined`, and it is unreachable without first traversing `constructor`, which is already
blocked. Including it would only add false positives on legitimate schema and documentation
payloads.

`constructor` carries some false-positive risk of its own — `{"constructor": "ACME Corp"}` is
valid data. That is why the default is `'allow'` and the caveat is documented on the option.

## `@sozai/codec` integration

- Drop the `canonicalize` dependency; add `"@sozai/json": "workspace:^"`.
- Remove `canonicalize: 3.0.0` from the `pnpm-workspace.yaml` catalog — codec is its only
  consumer in this repo.
- `canonicalStringify` keeps its exact signature and its throw-on-`undefined` wrapper. The frozen
  API is intact; only the TSDoc changes — the "known upstream limitation" paragraph is deleted
  and the error list is corrected to the `TypeError` set above.
- Import the serializer under an alias (e.g. `import { canonicalize as canonicalizeJSON }`).
  `b64uFromJSON`'s second parameter is itself named `canonicalize`, and an unaliased import
  would be shadowed inside that function body — harmless today, a trap for the next editor.
- `checkJSONDepth` is deleted; `b64uToJSON` delegates to `parse`. Its signature stays
  `b64uToJSON<T>(base64url: string): T` — no `ParseOptions` passthrough until a caller needs one.
- Changesets: `@sozai/json` new package, `@sozai/codec` minor.

## Testing

Official RFC 8785 vectors from
[cyberphone/json-canonicalization](https://github.com/cyberphone/json-canonicalization), vendored
under `packages/json/test/vectors/` as six input/expected-output pairs: `arrays`, `french`,
`structures`, `unicode`, `values`, `weird` (each under 300 bytes). That repository is Apache-2.0
(Copyright 2018 Anders Rundgren); an `ATTRIBUTION.md` alongside the fixtures records the source,
copyright, and license.

The fixtures are **downloaded as bytes**, never retyped or pasted. They carry precomposed
characters, lone C0/C1 control characters, and a surrogate pair whose ordering is the whole point
of the `weird` vector; a copy-paste round trip silently decomposed U+FB33 during this spec's
research and inverted the expected sort order.

The implementation is written against RFC 8785 rather than derived from the Apache-2.0
`canonicalize` source.

Beyond the vectors:

- One case per row of the conformance and data-model tables above — key ordering, boxed
  primitives, `toJSON` with its key argument, a getter asserted to fire exactly once.
- One case per error row, asserting both `TypeError` and the exact message.
- The regression that started this: a nested function is omitted from objects and becomes `null`
  in arrays, and the result parses.
- The two adjacent routes to the same defect: a `toJSON` returning `undefined`, and a sparse
  array hole.
- Depth guard: at the limit, over the limit, a custom `maxDepth`, and braces inside strings and
  escapes not miscounted.
- All three `protoKeys` modes against both `__proto__` and `constructor`, nested as well as
  top-level.
- In `@sozai/codec`: `canonicalStringify({ a: () => {} })` drops the key — the original backlog
  bug, asserted at the public API.

## Docs and skills

`@sozai/json` joins the **Validation** domain, beside `@sozai/codec`.

| File | Change |
|---|---|
| `plugins/sozai/skills/validation/reference/json.md` | New — exports table, `canonicalize`/`parse` examples, RFC conformance notes, `protoKeys` modes with the false-positive caveat, error paths |
| `plugins/sozai/skills/validation/SKILL.md` | Add `@sozai/json` to Packages and a "Pick this when" block. Correct the closing line "`@sozai/codec` depends on no other `@sozai` package" — it now depends on `@sozai/json` |
| `plugins/sozai/skills/validation/reference/codec.md` | Rewrite the `canonicalStringify` error-path section (L100–119) for the new classes and messages; note the delegation to `@sozai/json`; document `b64uToJSON`'s depth limit, currently undocumented |
| `plugins/sozai/skills/discover/SKILL.md` | "15 packages" → 16; Validation domain blurb; Packages list; a "By use case" entry for signing and content-addressing |
| `docs/agents/architecture.md` | Package list and the "stable group" sentence |
| `README.md` | Package list (L3–4) — which also omits `lock` today, fixed in passing |
| `docs/agents/plans/roadmap.md` | Drop the backlog entry |
| `docs/agents/plans/project-loop-state.md` | Drop the upstream-intel note (L44–45) |
| `docs/agents/plans/backlog/2026-07-11-codec-canonicalize-nested-undefined.md` | Delete — resolved, not deferred |
| `packages/json/README.md` | New, per package convention |

`pnpm run check:skills` must pass.

## Verification

- `pnpm run test` — types and unit, across the workspace.
- `pnpm exec biome check ./packages`
- `pnpm run build`
- `pnpm run check:skills`
