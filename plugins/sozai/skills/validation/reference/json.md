# @sozai/json

## Exports

| Export | Kind | Description |
|---|---|---|
| `canonicalize` | function | Serialize to canonical JSON (RFC 8785), or `undefined` |
| `JSONValue` | type | JSON primitives, arrays and objects with finite numbers |
| `isJSONValue` | function | Check that JSON serialisation reproduces a value unchanged |
| `toJSONValue` | function | Coerce unknown input recursively to `JSONValue` without throwing |
| `parse` | function | Parse JSON with a depth limit and optional prototype-key guard |
| `ParseOptions` | type | `{ maxDepth?: number; protoKeys?: ProtoKeysMode }` |
| `ProtoKeysMode` | type | `'allow' \| 'strip' \| 'reject'` |

## Example

```typescript
import { canonicalize, parse } from '@sozai/json'

// Key order is deterministic, so identical data produces identical bytes.
canonicalize({ z: 1, a: 2 }) === canonicalize({ a: 2, z: 1 }) // true — '{"a":2,"z":1}'

// Like JSON.stringify on these points: dropped keys, null array holes, toJSON.
canonicalize({ a: undefined, b: () => {}, c: 1 }) // '{"c":1}'
canonicalize([undefined, 1])                      // '[null,1]'
canonicalize({ d: new Date(0) })                  // '{"d":"1970-01-01T00:00:00.000Z"}'

// undefined when the value itself has no JSON representation
canonicalize(undefined) // undefined

parse('{"a":1}')                          // { a: 1 }
parse(payload, { maxDepth: 32 })          // stricter nesting limit
parse(untrusted, { protoKeys: 'strip' })  // drop __proto__ and constructor
```

## Example: canonicalize error paths

`canonicalize` throws a `TypeError` on values that cannot be represented in canonical JSON:
`'NaN is not allowed'`, `'Infinity is not allowed'`, `'BigInt is not allowed'`, and
`'Circular reference detected'`. This is stricter than `JSON.stringify`, which turns `NaN` and
`Infinity` into `null`.

It returns `undefined` — it does not throw — when the value *itself* is `undefined`, a function
or a symbol, mirroring `JSON.stringify`. Wrap it if you need a guaranteed string;
`@sozai/codec`'s `canonicalStringify` does exactly that.

```typescript
import { canonicalize } from '@sozai/json'

try {
  canonicalize({ a: Number.NaN })
} catch (err) {
  console.log(err instanceof TypeError, (err as Error).message) // true 'NaN is not allowed'
}
```

## Example: parse guards

The depth check runs over the raw text before `JSON.parse`, so a hostile payload never reaches
the parser. The default limit is 128; exceeding it throws
`Error('JSON exceeds maximum nesting depth of N')`.

`protoKeys` defaults to `'allow'`; `'reject'` throws `TypeError('Forbidden key: <key>')`, a
`TypeError` so a rejected hostile payload is distinguishable from malformed JSON. `JSON.parse`
does not pollute prototypes by itself — it
creates an ordinary own property. The risk appears when the parsed value is merged into another
object: `__proto__` is reached by any `[[Set]]`-based copy (`Object.assign`, `target[key] =
value`), and `constructor` is the deep-merge path via `constructor.prototype`, which is the
published bypass of `__proto__`-only blocklists. Turn the guard on at merge sites; leave it off
where `{"constructor": "ACME Corp"}` is legitimate data.

```typescript
import { parse } from '@sozai/json'

parse('{"__proto__":{"x":1},"ok":1}', { protoKeys: 'strip' }) // { ok: 1 }

try {
  parse('{"constructor":{}}', { protoKeys: 'reject' })
} catch (err) {
  // true 'Forbidden key: constructor'
  console.log(err instanceof TypeError, (err as Error).message)
}
```

## Coerce unknown values

```typescript
import { toJSONValue } from '@sozai/json'

toJSONValue({ count: 2n, missing: undefined, ok: [1, undefined] })
// { count: '2', ok: [1, null] }
```

`toJSONValue(value: unknown): JSONValue` converts each property independently, preserving valid sibling properties when conversion fails.
Plain JSON input remains equal.

- Non-finite numbers become `null`.
- Bigints, symbols and functions use guarded `String()`.
- Undefined object properties are omitted. Undefined array entries and holes become `null`. Top-level undefined becomes `'undefined'`.
- Objects use `toJSON` output recursively. The method receives the property key, or `''` at the root.
- Self-returning `toJSON` methods traverse their receiver without another call.
- Ancestor cycles become `'[circular]'`. Shared references across siblings convert independently.
- Throwing getters use the thrown value's guarded string. Failed object conversion uses the object's guarded string.
- Failed string conversion becomes `'[unrenderable]'`.
- Boxed numbers, strings and booleans are unwrapped. Other objects retain only enumerable string keys.
- Symbol keys, non-enumerable properties and extra array properties are ignored, matching `JSON.stringify`.

`__proto__` remains an own data property without changing the output object's prototype.
