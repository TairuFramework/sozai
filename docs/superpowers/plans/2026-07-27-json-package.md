# `@sozai/json` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks
**Spec:** [2026-07-27-json-package-design.md](../specs/2026-07-27-json-package-design.md)

**Goal:** Replace the stalled `canonicalize` dependency with `@sozai/json` — a dependency-free RFC 8785 serializer plus depth-limited, prototype-safe JSON parsing — and move `@sozai/codec` onto it.

**Architecture:** One new package with two exports. `canonicalize` is a single recursive `serialize` function returning `string | undefined`, where each container decides what an `undefined` child means (omit the key; emit `null` for an array element). `parse` runs a string-aware depth pre-scan before `JSON.parse`, with an optional reviver guarding prototype-polluting keys. `@sozai/codec` keeps its exact public API and delegates.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, vitest, biome, changesets. No runtime dependencies.

## Global Constraints

- pnpm only. Never `npm` or `yarn`.
- Do not edit generated files (`lib/`).
- All dev tooling comes from `@kigu/dev`: extend `@kigu/dev/tsconfig.json`, `["@kigu/dev/biome.json"]`, `@kigu/dev/swc.json`.
- Intra-repo dependencies use `workspace:^`.
- Conventions: the `kigu:conventions` skill is canonical.
- Package version starts at `0.1.0`. License MIT, `"access": "public"`.
- Lint with `pnpm exec biome check --write ./packages` — do NOT use `pnpm run lint` (a machine-local `rtk` shim redirects it to eslint).
- Every error message and export name in this plan is exact. Do not paraphrase them; tests assert on them verbatim.
- Test files import from source (`../src/index.js`), matching every other package here.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/json/package.json` | Package manifest — no runtime dependencies |
| `packages/json/tsconfig.json` | Build config, extends `@kigu/dev/tsconfig.json` |
| `packages/json/tsconfig.test.json` | Test typecheck config |
| `packages/json/LICENSE` | MIT, copied from a sibling package |
| `packages/json/README.md` | Package README |
| `packages/json/src/index.ts` | Both exports plus their private helpers |
| `packages/json/test/canonicalize.test.ts` | Serializer unit tests |
| `packages/json/test/vectors.test.ts` | Official RFC 8785 vector harness |
| `packages/json/test/parse.test.ts` | Depth and prototype-key tests |
| `packages/json/test/vectors/input/*.json` | 6 downloaded fixtures |
| `packages/json/test/vectors/output/*.json` | 6 downloaded expected outputs |
| `packages/json/test/vectors/ATTRIBUTION.md` | Apache-2.0 attribution for the fixtures |
| `plugins/sozai/skills/validation/reference/json.md` | Skill reference for the new package |

**Modified:** `packages/codec/{package.json,src/index.ts,test/lib.test.ts}`, `pnpm-workspace.yaml`, `plugins/sozai/skills/validation/SKILL.md`, `plugins/sozai/skills/validation/reference/codec.md`, `plugins/sozai/skills/discover/SKILL.md`, `docs/agents/architecture.md`, `README.md`, `docs/agents/plans/roadmap.md`, `docs/agents/plans/project-loop-state.md`

**Deleted:** `docs/agents/plans/backlog/2026-07-11-codec-canonicalize-nested-undefined.md`

`src/index.ts` stays a single file: it is roughly 130 lines and the two exports share no helpers worth separating. This matches `@sozai/codec`, which keeps a comparable surface in one file.

---

### Task 1: Scaffold `@sozai/json` and implement `canonicalize`

**Files:**
- Create: `packages/json/package.json`, `packages/json/tsconfig.json`, `packages/json/tsconfig.test.json`, `packages/json/LICENSE`, `packages/json/src/index.ts`
- Test: `packages/json/test/canonicalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonicalize(value: unknown): string | undefined` from `@sozai/json`. Task 5 consumes it; Task 2 tests it against official vectors.

- [ ] **Step 1: Create the package skeleton**

```bash
mkdir -p packages/json/src packages/json/test
cp packages/lock/LICENSE packages/json/LICENSE
```

`packages/json/package.json`:

```json
{
  "name": "@sozai/json",
  "version": "0.1.0",
  "description": "Canonical JSON serialization and hardened parsing",
  "keywords": [
    "json",
    "canonical",
    "rfc8785",
    "jcs"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/TairuFramework/sozai",
    "directory": "packages/json"
  },
  "license": "MIT",
  "sideEffects": false,
  "type": "module",
  "exports": {
    ".": "./lib/index.js"
  },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": [
    "lib/*"
  ],
  "scripts": {
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "build:clean": "del lib",
    "build:js": "swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths",
    "build:types": "tsc --emitDeclarationOnly --skipLibCheck",
    "prepublishOnly": "pnpm run build",
    "test": "pnpm run test:types && pnpm run test:unit",
    "test:types": "tsc --noEmit --skipLibCheck -p tsconfig.test.json",
    "test:unit": "vitest run"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

`packages/json/tsconfig.json`:

```json
{
  "extends": "@kigu/dev/tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./lib",
    "types": ["node"]
  },
  "include": ["./src/**/*"]
}
```

`packages/json/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["./src/**/*", "./test/**/*"]
}
```

Then install so the workspace picks the package up:

```bash
pnpm install
```

- [ ] **Step 2: Write the failing tests**

`packages/json/test/canonicalize.test.ts`:

```typescript
import { describe, expect, test } from 'vitest'

import { canonicalize } from '../src/index.js'

describe('canonicalize()', () => {
  test('sorts object keys by UTF-16 code unit', () => {
    expect(canonicalize({ z: 1, a: 2, '10': 3, '1': 4 })).toBe('{"1":4,"10":3,"a":2,"z":1}')
  })

  test('sorts a surrogate pair before U+FB33, per code-unit order', () => {
    // U+1F602 leads with 0xD83D, which is below 0xFB33 — code-POINT order would
    // invert these. RFC 8785 section 3.2.3 requires code-unit order.
    const emoji = String.fromCharCode(0xd83d, 0xde02)
    const hebrew = String.fromCharCode(0xfb33)
    expect(canonicalize({ [hebrew]: 1, [emoji]: 2 })).toBe(
      `{${JSON.stringify(emoji)}:2,${JSON.stringify(hebrew)}:1}`,
    )
  })

  test('serializes numbers as JSON.stringify does', () => {
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27])).toBe(
      '[333333333.3333333,1e+30,4.5,0.002,1e-27]',
    )
  })

  test('returns undefined for non-serializable input', () => {
    expect(canonicalize(undefined)).toBeUndefined()
    expect(canonicalize(() => {})).toBeUndefined()
    expect(canonicalize(Symbol('s'))).toBeUndefined()
  })

  test('omits non-serializable object values and nulls array elements', () => {
    expect(canonicalize({ a: undefined, b: Symbol('s'), c: () => {}, d: 1 })).toBe('{"d":1}')
    expect(canonicalize([undefined, Symbol('s'), () => {}, 1])).toBe('[null,null,null,1]')
  })

  test('emits parseable JSON for a nested function', () => {
    // The regression this package exists for: canonicalize@3.0.0 emitted
    // '{"a":undefined}' here, which JSON.parse rejects.
    const serialized = canonicalize({ a: () => {}, b: 1 }) as string
    expect(serialized).toBe('{"b":1}')
    expect(JSON.parse(serialized)).toEqual({ b: 1 })
  })

  test('omits a key whose toJSON returns undefined', () => {
    expect(canonicalize({ a: { toJSON: () => undefined }, b: 1 })).toBe('{"b":1}')
  })

  test('serializes sparse array holes as null', () => {
    // Built rather than written as `[, 1]`, which biome's noSparseArray rejects.
    const sparse = new Array(2)
    sparse[1] = 1
    expect(canonicalize(sparse)).toBe('[null,1]')
  })

  test('honors toJSON and passes it the property key', () => {
    expect(canonicalize({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}')
    expect(canonicalize({ k: { toJSON: (key: string) => key } })).toBe('{"k":"k"}')
  })

  test('unwraps boxed primitives', () => {
    // Object(x) rather than `new Number(x)`, which biome's wrapper-object rule rejects.
    expect(canonicalize({ a: Object(5) })).toBe('{"a":5}')
    expect(canonicalize({ a: Object('x') })).toBe('{"a":"x"}')
    expect(canonicalize({ a: Object(true) })).toBe('{"a":true}')
  })

  test('reads each property exactly once', () => {
    let reads = 0
    const value = {
      get a() {
        reads++
        return 1
      },
    }
    canonicalize(value)
    expect(reads).toBe(1)
  })

  test('allows a repeated non-circular reference', () => {
    const shared = { v: 1 }
    expect(canonicalize([shared, shared])).toBe('[{"v":1},{"v":1}]')
  })

  test.each([
    ['NaN', { a: Number.NaN }, 'NaN is not allowed'],
    ['Infinity', { a: Number.POSITIVE_INFINITY }, 'Infinity is not allowed'],
    ['-Infinity', { a: Number.NEGATIVE_INFINITY }, 'Infinity is not allowed'],
    ['BigInt', { a: 1n }, 'BigInt is not allowed'],
  ])('throws a TypeError on %s', (_label, value, message) => {
    expect(() => canonicalize(value)).toThrow(TypeError)
    expect(() => canonicalize(value)).toThrow(message)
  })

  test('throws a TypeError on a circular reference', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => canonicalize(value)).toThrow(TypeError)
    expect(() => canonicalize(value)).toThrow('Circular reference detected')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @sozai/json exec vitest run`
Expected: FAIL — `Failed to resolve import "../src/index.js"`, since `src/index.ts` does not exist yet.

- [ ] **Step 4: Implement the serializer**

`packages/json/src/index.ts`:

```typescript
/**
 * Canonical JSON serialization and hardened parsing.
 *
 * ## Installation
 *
 * ```sh
 * npm install @sozai/json
 * ```
 *
 * @module json
 */

/**
 * Serialize a value to canonical JSON, per RFC 8785 (JSON Canonicalization Scheme).
 *
 * Object keys are sorted by UTF-16 code unit (RFC 8785 section 3.2.3), and numbers and strings
 * are serialized by `JSON.stringify`, which implements exactly the format the RFC requires.
 *
 * Returns `undefined` when the value itself has no JSON representation — `undefined`, a function
 * or a symbol — mirroring `JSON.stringify`. Callers needing a guaranteed string should wrap this
 * and throw.
 *
 * Throws a `TypeError` on values that cannot be represented in canonical JSON: `NaN`, `Infinity`,
 * `BigInt`, and circular references. This is stricter than `JSON.stringify`, which turns
 * `NaN` and `Infinity` into `null`. Deeply nested values may throw a `RangeError` from stack
 * exhaustion, as `JSON.stringify` does.
 *
 * Otherwise the output matches `JSON.stringify` semantics: `toJSON` is honored, boxed primitives
 * are unwrapped, each property is read exactly once, non-serializable values are omitted from
 * objects and become `null` in arrays, and sparse array holes become `null`.
 */
export function canonicalize(value: unknown): string | undefined {
  return serialize(value, '', new Set())
}

function serialize(value: unknown, key: string, seen: Set<object>): string | undefined {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      throw new TypeError('NaN is not allowed')
    }
    if (!Number.isFinite(value)) {
      throw new TypeError('Infinity is not allowed')
    }
  }
  if (typeof value === 'bigint') {
    throw new TypeError('BigInt is not allowed')
  }

  // Covers null, numbers, strings and booleans, and returns undefined for the three
  // non-serializable types — which every caller below already handles.
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  const object = value as Record<string, unknown>
  const toJSON = object.toJSON
  if (typeof toJSON === 'function') {
    if (seen.has(object)) {
      throw new TypeError('Circular reference detected')
    }
    seen.add(object)
    const result = serialize((toJSON as (key: string) => unknown).call(object, key), key, seen)
    seen.delete(object)
    return result
  }

  if (object instanceof Number || object instanceof String || object instanceof Boolean) {
    return serialize(object.valueOf(), key, seen)
  }

  if (seen.has(object)) {
    throw new TypeError('Circular reference detected')
  }
  seen.add(object)

  let result: string
  if (Array.isArray(object)) {
    const values: Array<string> = []
    // Indexed rather than `.map`, which skips holes in a sparse array and would emit an
    // elided element instead of `null`.
    for (let index = 0; index < object.length; index++) {
      values.push(serialize(object[index], String(index), seen) ?? 'null')
    }
    result = `[${values.join(',')}]`
  } else {
    const parts: Array<string> = []
    for (const name of Object.keys(object).sort()) {
      // Read once, so getters fire once.
      const serialized = serialize(object[name], name, seen)
      // Catches a raw undefined/function/symbol and a toJSON that returned one.
      if (serialized === undefined) {
        continue
      }
      parts.push(`${JSON.stringify(name)}:${serialized}`)
    }
    result = `{${parts.join(',')}}`
  }

  seen.delete(object)
  return result
}
```

Note on `instanceof` for boxed primitives: it does not recognise values from another realm (a
different `vm` context or iframe). `JSON.stringify` uses internal slots and does. This matches
upstream behaviour and is not worth a workaround; do not add one.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @sozai/json exec vitest run`
Expected: PASS, 17 tests.

- [ ] **Step 6: Typecheck, lint and build**

```bash
pnpm --filter @sozai/json run test:types
pnpm exec biome check --write ./packages
pnpm --filter @sozai/json run build
```

Expected: all clean. `pnpm run lint` is NOT the command here — see Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add packages/json pnpm-lock.yaml
git commit -m "feat(json): add @sozai/json with an RFC 8785 canonicalize"
```

---

### Task 2: Verify against the official RFC 8785 vectors

**Files:**
- Create: `packages/json/test/vectors/input/*.json`, `packages/json/test/vectors/output/*.json`, `packages/json/test/vectors/ATTRIBUTION.md`, `packages/json/test/vectors.test.ts`

**Interfaces:**
- Consumes: `canonicalize` from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Download the fixtures**

Download them as bytes. Do NOT retype or copy-paste the contents — they carry precomposed
characters, C0/C1 control characters, and a surrogate pair whose ordering is the point of the
`weird` vector. A paste round trip silently decomposes U+FB33 and inverts the expected order.

```bash
mkdir -p packages/json/test/vectors/input packages/json/test/vectors/output
for f in arrays french structures unicode values weird; do
  curl -sSL --fail -o "packages/json/test/vectors/input/$f.json" \
    "https://raw.githubusercontent.com/cyberphone/json-canonicalization/master/testdata/input/$f.json"
  curl -sSL --fail -o "packages/json/test/vectors/output/$f.json" \
    "https://raw.githubusercontent.com/cyberphone/json-canonicalization/master/testdata/output/$f.json"
done
```

Verify the sizes, which pin down a correct download (input then output, in bytes):
`arrays` 62/32, `french` 150/130, `structures` 138/98, `unicode` 39/30, `values` 182/118,
`weird` 283/214.

```bash
wc -c packages/json/test/vectors/input/*.json packages/json/test/vectors/output/*.json
```

- [ ] **Step 2: Record attribution**

`packages/json/test/vectors/ATTRIBUTION.md`:

```markdown
# Test vector attribution

The JSON files in `input/` and `output/` are the official RFC 8785 (JSON Canonicalization
Scheme) test vectors, copied verbatim from the `testdata/` directory of:

https://github.com/cyberphone/json-canonicalization

Copyright 2018 Anders Rundgren, licensed under the Apache License, Version 2.0:
https://www.apache.org/licenses/LICENSE-2.0

These fixtures are the only Apache-2.0 material in this package. `src/` is original work written
against RFC 8785 and is MIT licensed, like the rest of this repository.

Not included: the ES6 number test vector, a 100-million-line file distributed as a release
artifact. Number serialization here is delegated wholesale to `JSON.stringify`, which is
specified to produce exactly the format the RFC requires.
```

- [ ] **Step 3: Write the vector harness**

`packages/json/test/vectors.test.ts`:

```typescript
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { canonicalize } from '../src/index.js'

const VECTORS_DIR = join(import.meta.dirname, 'vectors')
const NAMES = ['arrays', 'french', 'structures', 'unicode', 'values', 'weird']

describe('RFC 8785 official test vectors', () => {
  test.each(NAMES)('%s', (name) => {
    const input = readFileSync(join(VECTORS_DIR, 'input', `${name}.json`), 'utf8')
    const expected = readFileSync(join(VECTORS_DIR, 'output', `${name}.json`), 'utf8')
    expect(canonicalize(JSON.parse(input))).toBe(expected)
  })
})
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sozai/json exec vitest run vectors`
Expected: PASS, 6 tests. If `weird` fails on key order, the fixture was corrupted in transit —
re-download it rather than adjusting the implementation.

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm --filter @sozai/json run test:types
pnpm exec biome check --write ./packages
```

Biome may want to ignore the fixture JSON; if it reformats anything under `test/vectors/`, revert
that file and add an override rather than accepting the change — the bytes are the test.

- [ ] **Step 6: Commit**

```bash
git add packages/json/test
git commit -m "test(json): verify canonicalize against the official RFC 8785 vectors"
```

---

### Task 3: `parse` with a depth limit

**Files:**
- Modify: `packages/json/src/index.ts`
- Test: `packages/json/test/parse.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parse<T = unknown>(json: string, options?: ParseOptions): T` and `ParseOptions`, both from `@sozai/json`. Task 4 extends `ParseOptions` with `protoKeys`; Task 5 calls `parse` from `@sozai/codec`.

- [ ] **Step 1: Write the failing tests**

`packages/json/test/parse.test.ts`:

```typescript
import { describe, expect, test } from 'vitest'

import { parse } from '../src/index.js'

const nest = (depth: number) => '['.repeat(depth) + ']'.repeat(depth)

describe('parse()', () => {
  test('parses ordinary JSON', () => {
    expect(parse('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] })
  })

  test('accepts nesting at the default limit', () => {
    expect(() => parse(nest(128))).not.toThrow()
  })

  test('rejects nesting past the default limit', () => {
    expect(() => parse(nest(129))).toThrow('JSON exceeds maximum nesting depth of 128')
  })

  test('honors a custom maxDepth', () => {
    expect(() => parse(nest(2), { maxDepth: 2 })).not.toThrow()
    expect(() => parse(nest(3), { maxDepth: 2 })).toThrow(
      'JSON exceeds maximum nesting depth of 2',
    )
  })

  test('does not count brackets inside strings', () => {
    expect(parse('{"a":"[[[[["}')).toEqual({ a: '[[[[[' })
  })

  test('does not miscount an escaped quote', () => {
    expect(parse('{"a":"\\"[[["}')).toEqual({ a: '"[[[' })
  })

  test('checks depth before parsing', () => {
    // Invalid JSON past the limit must fail on depth, not on syntax.
    expect(() => parse(`${nest(200)} not json`)).toThrow(
      'JSON exceeds maximum nesting depth of 128',
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sozai/json exec vitest run parse`
Expected: FAIL — `parse is not a function` / no matching export.

- [ ] **Step 3: Implement `parse` and the depth scan**

Append to `packages/json/src/index.ts`:

```typescript
const DEFAULT_MAX_DEPTH = 128

/** Options for {@link parse}. */
export type ParseOptions = {
  /**
   * Maximum nesting depth accepted, checked before parsing. Defaults to 128.
   */
  maxDepth?: number
}

/**
 * Parse JSON with a nesting limit.
 *
 * The depth check runs over the raw text before `JSON.parse`, so a hostile payload never reaches
 * the parser. Exceeding the limit throws
 * `Error('JSON exceeds maximum nesting depth of N')`.
 */
export function parse<T = unknown>(json: string, options: ParseOptions = {}): T {
  const { maxDepth = DEFAULT_MAX_DEPTH } = options
  checkDepth(json, maxDepth)
  return JSON.parse(json) as T
}

function checkDepth(json: string, maxDepth: number): void {
  let depth = 0
  let inString = false
  let isEscaped = false
  for (let i = 0; i < json.length; i++) {
    const char = json[i]
    if (isEscaped) {
      isEscaped = false
      continue
    }
    if (inString) {
      if (char === '\\') isEscaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      depth++
      if (depth > maxDepth) {
        throw new Error(`JSON exceeds maximum nesting depth of ${maxDepth}`)
      }
    } else if (char === '}' || char === ']') {
      depth--
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sozai/json exec vitest run parse`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm --filter @sozai/json run test:types
pnpm exec biome check --write ./packages
```

- [ ] **Step 6: Commit**

```bash
git add packages/json
git commit -m "feat(json): add parse with a nesting depth limit"
```

---

### Task 4: Prototype-key guard for `parse`

**Files:**
- Modify: `packages/json/src/index.ts`
- Test: `packages/json/test/parse.test.ts`

**Interfaces:**
- Consumes: `parse` and `ParseOptions` from Task 3.
- Produces: `ProtoKeysMode = 'allow' | 'strip' | 'reject'`, exported, plus `ParseOptions.protoKeys`. Nothing later depends on it — `@sozai/codec` keeps the default.

- [ ] **Step 1: Write the failing tests**

Append to `packages/json/test/parse.test.ts`, inside the existing `describe('parse()')` block:

```typescript
  describe('protoKeys', () => {
    const payload =
      '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"ok":1}'

    test('allows prototype keys by default, without polluting', () => {
      const result = parse<Record<string, unknown>>(payload)
      // JSON.parse creates an ordinary own property and leaves the prototype alone.
      expect(Object.hasOwn(result, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })

    test('strips __proto__ and constructor', () => {
      const result = parse<Record<string, unknown>>(payload, { protoKeys: 'strip' })
      expect(Object.hasOwn(result, '__proto__')).toBe(false)
      expect(Object.hasOwn(result, 'constructor')).toBe(false)
      expect(result).toEqual({ ok: 1 })
    })

    test('strips nested prototype keys', () => {
      expect(parse('{"a":{"__proto__":{"x":1},"b":2}}', { protoKeys: 'strip' })).toEqual({
        a: { b: 2 },
      })
    })

    test('leaves array elements alone when stripping', () => {
      expect(parse('[1,2,3]', { protoKeys: 'strip' })).toEqual([1, 2, 3])
    })

    test.each([
      ['__proto__', '{"__proto__":{}}'],
      ['constructor', '{"constructor":{}}'],
      ['__proto__', '{"a":{"__proto__":{}}}'],
      ['constructor', '{"a":{"constructor":{}}}'],
    ])('rejects %s in %s', (key, json) => {
      expect(() => parse(json, { protoKeys: 'reject' })).toThrow(`Forbidden key: ${key}`)
    })

    test('accepts a payload with no prototype keys when rejecting', () => {
      expect(parse('{"a":1}', { protoKeys: 'reject' })).toEqual({ a: 1 })
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @sozai/json exec vitest run parse`
Expected: FAIL — `protoKeys` is not a known property of `ParseOptions`, and the strip/reject tests fail.

- [ ] **Step 3: Implement the guard**

In `packages/json/src/index.ts`, add the mode type and constant above `ParseOptions`:

```typescript
const PROTO_KEYS = new Set(['__proto__', 'constructor'])

/** How {@link parse} treats prototype-polluting keys. */
export type ProtoKeysMode = 'allow' | 'strip' | 'reject'
```

Extend `ParseOptions` with the new field:

```typescript
/** Options for {@link parse}. */
export type ParseOptions = {
  /**
   * Maximum nesting depth accepted, checked before parsing. Defaults to 128.
   */
  maxDepth?: number
  /**
   * How to treat the `__proto__` and `constructor` keys. Defaults to `'allow'`.
   *
   * `JSON.parse` does not pollute prototypes on its own — it creates an ordinary own property
   * and leaves the prototype untouched. The payload is inert until a consumer merges it, and the
   * two guarded keys cover the two distinct merge paths: `__proto__` is reached by any
   * `[[Set]]`-based copy (`Object.assign`, `target[key] = value`), which triggers the inherited
   * `__proto__` setter; `constructor` is the deep-merge path, where walking
   * `target.constructor.prototype` reaches `Object.prototype` and is the published bypass of
   * `__proto__`-only blocklists.
   *
   * `'strip'` removes the key, `'reject'` throws `Error('Forbidden key: <key>')`. The default is
   * `'allow'` because `{"constructor": "ACME Corp"}` is legitimate data — turn the guard on where
   * the parsed value is merged into another object.
   *
   * `prototype` is deliberately not guarded: on a plain-object merge target it is `undefined`,
   * and it is unreachable without first traversing `constructor`.
   */
  protoKeys?: ProtoKeysMode
}
```

Replace the body of `parse`:

```typescript
export function parse<T = unknown>(json: string, options: ParseOptions = {}): T {
  const { maxDepth = DEFAULT_MAX_DEPTH, protoKeys = 'allow' } = options
  checkDepth(json, maxDepth)
  if (protoKeys === 'allow') {
    return JSON.parse(json) as T
  }
  return JSON.parse(json, (key, value) => {
    if (PROTO_KEYS.has(key)) {
      if (protoKeys === 'reject') {
        throw new Error(`Forbidden key: ${key}`)
      }
      // Returning undefined from a reviver deletes the property.
      return undefined
    }
    return value
  }) as T
}
```

Also extend the `parse` TSDoc summary to mention the guard:

```typescript
/**
 * Parse JSON with a nesting limit and an optional prototype-key guard.
 *
 * The depth check runs over the raw text before `JSON.parse`, so a hostile payload never reaches
 * the parser. Exceeding the limit throws
 * `Error('JSON exceeds maximum nesting depth of N')`.
 *
 * See {@link ParseOptions.protoKeys} for the prototype-key guard, which is off by default.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @sozai/json exec vitest run parse`
Expected: PASS, 16 tests.

- [ ] **Step 5: Full package check**

```bash
pnpm --filter @sozai/json run test
pnpm exec biome check --write ./packages
pnpm --filter @sozai/json run build
```

Expected: all clean, 39 tests across three files (17 canonicalize, 16 parse, 6 vectors).

- [ ] **Step 6: Commit**

```bash
git add packages/json
git commit -m "feat(json): guard __proto__ and constructor keys in parse"
```

---

### Task 5: Move `@sozai/codec` onto `@sozai/json`

**Files:**
- Modify: `packages/codec/package.json`, `packages/codec/src/index.ts:13` and `:15-41` and `:199-236`, `pnpm-workspace.yaml:28`
- Test: `packages/codec/test/lib.test.ts`

**Interfaces:**
- Consumes: `canonicalize` and `parse` from `@sozai/json` (Tasks 1, 3, 4).
- Produces: no API change. `canonicalStringify`, `b64uFromJSON` and `b64uToJSON` keep their exact signatures.

Cross-package imports resolve to built output (`lib/`), not source — turbo's `test:unit` task
declares `dependsOn: ["^build:js"]`. Build `@sozai/json` before running codec's tests, or use
`pnpm run test`, which handles ordering.

- [ ] **Step 1: Swap the dependency**

In `packages/codec/package.json`, replace the `dependencies` block:

```json
  "dependencies": {
    "@sozai/json": "workspace:^"
  },
```

In `pnpm-workspace.yaml`, delete line 28 (`  canonicalize: 3.0.0`) from the catalog — codec was
its only consumer in this repo.

```bash
pnpm install
```

- [ ] **Step 2: Write the failing tests**

Add to `packages/codec/test/lib.test.ts`, inside the existing `canonicalStringify` describe block
(create one if the tests are flat):

```typescript
test('emits parseable JSON for a nested function', () => {
  const serialized = canonicalStringify({ a: () => {}, b: 1 })
  expect(serialized).toBe('{"b":1}')
  expect(JSON.parse(serialized)).toEqual({ b: 1 })
})

test('throws a TypeError on values with no canonical representation', () => {
  expect(() => canonicalStringify({ a: Number.NaN })).toThrow(TypeError)
  expect(() => canonicalStringify({ a: 1n })).toThrow('BigInt is not allowed')
})

test('still throws when the value itself is not serializable', () => {
  expect(() => canonicalStringify(undefined)).toThrow('Value has no canonical JSON representation')
})
```

Existing tests asserting the old error classes or the old BigInt message will now fail. Update
them to `TypeError` and `'BigInt is not allowed'` — this is the intended change, recorded in the
spec. Do not weaken the assertions to make them pass.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm --filter @sozai/json run build
pnpm --filter @sozai/codec exec vitest run
```

Expected: FAIL — the nested-function test gets `'{"a":undefined}'` until the import is swapped.

- [ ] **Step 4: Rewrite the codec integration points**

Replace `packages/codec/src/index.ts:13`:

```typescript
import { canonicalize as canonicalizeJSON, parse as parseJSON } from '@sozai/json'
```

The aliases are deliberate: `b64uFromJSON`'s second parameter is itself named `canonicalize`, and
an unaliased import would be shadowed inside that function body.

Replace `canonicalStringify` (lines 15-41) with:

```typescript
/**
 * Serialize a value to canonical JSON, with deterministic key ordering.
 *
 * Throws a `TypeError` if the value has no JSON representation at all — `undefined`, a
 * function or a symbol. Returning a non-string here would silently encode to `""` downstream
 * in {@link b64uFromJSON}.
 *
 * Also throws (propagated from `@sozai/json`) on values a plain `JSON.stringify` would reject or
 * silently mangle, all as `TypeError`: `'NaN is not allowed'`, `'Infinity is not allowed'`,
 * `'BigInt is not allowed'`, and `'Circular reference detected'`. These are stricter than
 * `JSON.stringify`, which turns `NaN`/`Infinity` into `null` rather than throwing — so
 * `b64uFromJSON({a: NaN})` throws while `b64uFromJSON({a: NaN}, false)` succeeds with
 * `{"a":null}`. The two modes differ on more than key order.
 */
export function canonicalStringify(value: unknown): string {
  const serialized = canonicalizeJSON(value)
  if (serialized === undefined) {
    throw new TypeError('Value has no canonical JSON representation')
  }
  return serialized
}
```

The "Known upstream limitation" paragraph is gone — that is the point of this work.

Delete `MAX_JSON_DEPTH` and `checkJSONDepth` (lines 199-227) and replace `b64uToJSON`
(lines 229-236) with:

```typescript
/**
 * Convert a base64url-encoded string to a JSON object.
 *
 * Parsing is depth-limited (128 levels) via `@sozai/json`, checked before `JSON.parse` runs.
 */
export function b64uToJSON<T = Record<string, unknown>>(base64url: string): T {
  return parseJSON<T>(b64uToUTF(base64url))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @sozai/json run build
pnpm --filter @sozai/codec run test
```

Expected: PASS. The depth-limit tests already in `lib.test.ts` must still pass unchanged — the
limit and its message did not move.

- [ ] **Step 6: Verify the dependency is gone**

```bash
grep -rn "canonicalize" packages/codec/src packages/codec/package.json pnpm-workspace.yaml
```

Expected: only the `canonicalize` *parameter* of `b64uFromJSON` in `src/index.ts`. No import, no
dependency, no catalog entry.

- [ ] **Step 7: Full workspace check and commit**

```bash
pnpm run test
pnpm exec biome check --write ./packages
git add packages/codec pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(codec)!: serialize and parse via @sozai/json

Drops the canonicalize dependency. A nested function now yields parseable
JSON instead of a bare undefined token. NaN, Infinity and circular
references now throw TypeError rather than Error, and BigInt reports
'BigInt is not allowed'."
```

---

### Task 6: Docs, skills, changesets and backlog cleanup

**Files:**
- Create: `packages/json/README.md`, `plugins/sozai/skills/validation/reference/json.md`, `.changeset/json-package.md`
- Modify: `plugins/sozai/skills/validation/SKILL.md`, `plugins/sozai/skills/validation/reference/codec.md`, `plugins/sozai/skills/discover/SKILL.md`, `docs/agents/architecture.md`, `README.md`, `docs/agents/plans/roadmap.md`, `docs/agents/plans/project-loop-state.md`
- Delete: `docs/agents/plans/backlog/2026-07-11-codec-canonicalize-nested-undefined.md`

**Interfaces:**
- Consumes: the finished API from Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: Write the package README**

`packages/json/README.md`, following the shape of `packages/lock/README.md` (title, one-line
description, Installation, Usage):

````markdown
# @sozai/json

Canonical JSON serialization (RFC 8785) and hardened parsing.

## Installation

```sh
npm install @sozai/json
```

## Usage

```ts
import { canonicalize, parse } from '@sozai/json'

// Deterministic output regardless of insertion order — for signing and content addressing.
canonicalize({ z: 1, a: 2 }) // '{"a":2,"z":1}'

// Returns undefined when the value itself has no JSON representation.
canonicalize(undefined) // undefined

// Throws a TypeError on NaN, Infinity, BigInt and circular references.

// Depth-limited parsing, checked before JSON.parse runs.
parse('{"a":1}') // { a: 1 }
parse(deeplyNested, { maxDepth: 32 })

// Optional guard for keys that pollute prototypes when the result is merged.
parse(untrusted, { protoKeys: 'strip' })
```
````

- [ ] **Step 2: Write the skill reference**

`plugins/sozai/skills/validation/reference/json.md`, matching the structure of the sibling
`codec.md` — an `## Exports` table, an `## Example` block, and error-path sections:

````markdown
# @sozai/json

## Exports

| Export | Kind | Description |
|---|---|---|
| `canonicalize` | function | Serialize to canonical JSON (RFC 8785), or `undefined` |
| `parse` | function | Parse JSON with a depth limit and optional prototype-key guard |
| `ParseOptions` | type | `{ maxDepth?: number; protoKeys?: ProtoKeysMode }` |
| `ProtoKeysMode` | type | `'allow' \| 'strip' \| 'reject'` |

## Example

```typescript
import { canonicalize, parse } from '@sozai/json'

// Key order is deterministic, so identical data produces identical bytes.
canonicalize({ z: 1, a: 2 }) === canonicalize({ a: 2, z: 1 }) // true — '{"a":2,"z":1}'

// Output matches JSON.stringify semantics apart from ordering and strictness.
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

`protoKeys` defaults to `'allow'`. `JSON.parse` does not pollute prototypes by itself — it
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
  console.log((err as Error).message) // 'Forbidden key: constructor'
}
```
````

- [ ] **Step 3: Update the validation skill**

In `plugins/sozai/skills/validation/SKILL.md`:

- Add to `## Packages`: `- **@sozai/json** — canonical JSON and hardened parsing. → `reference/json.md``
- Add a `Use @sozai/json to:` block after the `@sozai/codec` one, with bullets: produce byte-identical JSON for signing or content addressing; parse untrusted JSON with a nesting limit; defend a merge site against prototype-polluting keys.
- Fix the final line. It currently reads "`@sozai/codec` depends on no other `@sozai` package and nothing in this repo depends on it." That is now false. Replace with: "`@sozai/codec` depends on `@sozai/json`; nothing else in this repo depends on either."

- [ ] **Step 4: Update the codec skill reference**

In `plugins/sozai/skills/validation/reference/codec.md`:

- In the `## Exports` table, change the `b64uToJSON` description to `Decode Base64URL string to typed object (depth-limited)`.
- Rewrite the prose at lines 102-106. The error list becomes: "`canonicalStringify` delegates to `@sozai/json` and throws a `TypeError` on values `JSON.stringify` would silently mangle or reject: `'NaN is not allowed'`, `'Infinity is not allowed'`, `'BigInt is not allowed'`, `'Circular reference detected'`." Keep the following sentence about `b64uFromJSON`'s two modes diverging.
- In the example at lines 111-115, the comment stays `// 'NaN is not allowed'` — the message did not change, only the class.
- Add to the decode error-path section: `b64uToJSON` rejects payloads nested deeper than 128 levels with `Error('JSON exceeds maximum nesting depth of 128')`, checked before parsing.

- [ ] **Step 5: Update the discover skill**

In `plugins/sozai/skills/discover/SKILL.md`:

- `15 packages across 5 domains` → `16 packages across 5 domains`
- Validation domain bullet → "**Validation** — JSON Schema with compile-time type generation (`FromSchema`), message encoding and decoding, plus canonical JSON and hardened parsing. → `/sozai:validation`"
- Packages list → "**Validation** — `@sozai/schema`, `@sozai/codec`, `@sozai/json`"
- Add a `## By use case` entry: "**Signing or content-addressing a payload** — `@sozai/json` for byte-identical serialization, `@sozai/codec` for the base64url envelope. `/sozai:validation`."

- [ ] **Step 6: Update the repo docs**

- `docs/agents/architecture.md`: add `json` to the alphabetical package list in the `## Packages` section and to the "the stable group" sentence.
- `README.md` lines 3-4: add `json` to the list. The list also omits `lock` today — add it in the same pass.
- `docs/agents/plans/roadmap.md`: delete the backlog bullet at lines 56-58.
- `docs/agents/plans/project-loop-state.md`: delete the upstream-intel note at lines 44-45.

- [ ] **Step 7: Delete the resolved backlog item**

```bash
git rm docs/agents/plans/backlog/2026-07-11-codec-canonicalize-nested-undefined.md
```

- [ ] **Step 8: Write the changeset**

`.changeset/json-package.md`:

```markdown
---
'@sozai/json': minor
'@sozai/codec': minor
---

New `@sozai/json` package: RFC 8785 canonical JSON serialization and depth-limited, optionally
prototype-safe parsing, with no runtime dependencies. `@sozai/codec` now uses it and drops the
`canonicalize` dependency.

This fixes invalid JSON output for values with no JSON representation. `canonicalize@3.0.0`
emitted a bare `undefined` token for a nested function (`{"a":undefined}`), an elided element for
one inside an array (`[,1]` for a sparse hole), and the same bare token when a `toJSON` method
returned `undefined` — so `b64uFromJSON` could encode, and a caller could sign, a payload that
`JSON.parse` rejects. All three now match `JSON.stringify`: the key is omitted in objects and the
element becomes `null` in arrays.

Also aligned with `JSON.stringify`: boxed primitives are unwrapped (`new Number(5)` serializes as
`5`, not `{}`), and each property is read exactly once, so getters fire once.

Breaking for anyone matching on error identity: `canonicalStringify` now throws `TypeError`
rather than `Error` for `NaN`, `Infinity` and circular references, and reports
`'BigInt is not allowed'` rather than `'Do not know how to serialize a BigInt'`. Messages for the
first three are unchanged, and `TypeError extends Error`, so `instanceof Error` checks still hold.
```

Then confirm the planned bumps:

```bash
pnpm exec changeset status --verbose
```

Expected: `@sozai/json` at `0.1.0` and `@sozai/codec` bumping `0.2.0` → `0.3.0`. `@sozai/json` is
new and its `package.json` already carries `0.1.0`, which is exactly what `@sozai/lock` did for its
first release (created at `0.1.0` with a `minor` changeset, published as `0.1.0`). If the status
output instead shows `@sozai/json` going to `0.2.0`, set its `package.json` version to `0.0.0` and
re-run — the `minor` changeset then lands it on `0.1.0`.

- [ ] **Step 9: Verify everything**

```bash
pnpm run build
pnpm run test
pnpm exec biome check --write ./packages
pnpm run check:skills
```

Expected: all pass. `check:skills` should report `PASS 27 file(s), 6 skill(s)` — one more file than
today's 26, for `json.md`. The skill count does not change; `json.md` joins the existing
`validation` skill.

Confirm nothing still references the deleted backlog file:

```bash
grep -rn "codec-canonicalize-nested-undefined" docs/ plugins/ README.md
```

Expected: matches only inside `docs/agents/plans/completed/` and `docs/superpowers/`, which are
historical records and must not be edited.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "docs: document @sozai/json across skills, READMEs and plans"
```

---

## Verification

Run from the repo root after Task 6:

```bash
pnpm run build
pnpm run test
pnpm exec biome check --write ./packages
pnpm run check:skills
```

The whole point of the work, checked by hand:

```bash
node --input-type=module -e '
import { canonicalStringify } from "./packages/codec/lib/index.js"
const out = canonicalStringify({ a: () => {}, b: 1 })
console.log(out, JSON.parse(out))
'
```

Expected: `{"b":1} { b: 1 }` — parseable, where `canonicalize@3.0.0` produced `{"a":undefined,"b":1}`.
