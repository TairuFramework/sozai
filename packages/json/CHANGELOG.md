# @sozai/json

## 0.1.0

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
