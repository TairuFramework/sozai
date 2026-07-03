# @sozai/patch RFC 6902 Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@sozai/patch`'s six standard ops RFC 6902/6901-correct and close the prototype-pollution hole, while keeping `set` and non-strict mode as documented extensions (Hybrid contract).

**Architecture:** All op behavior lives in `packages/patch/src/apply.ts` (path parsing + `setPath`/`deletePath`/`getPath` primitives + `applyPatches` dispatcher) and `packages/patch/src/create.ts` (the diff generator). Fixes are layered: path-level safety first (parsing), then per-op array/object correctness on the primitives, then dispatcher-level concerns (atomicity, empty-pointer), then the create side. Tests live in `packages/patch/test/`.

**Tech Stack:** TypeScript (strict, ES2025), Vitest, SWC. pnpm workspace.

## Global Constraints

- Conventions: `type` not `interface`; `Array<T>` not `T[]`; **never `any`**; capital `ID`/`HTTP`/`JWT`; ES `#fields`, never `private`/`readonly`. Do not edit `lib/` (generated).
- Tests: Vitest. Use `test` (not `it`). Import `{ describe, expect, test } from 'vitest'`.
- Package dir: all paths below are under `packages/patch/`.
- Run tests from repo root with `pnpm --filter @sozai/patch test:unit` (or `cd packages/patch && pnpm vitest run <file>`).
- Contract: `strict: true` ≡ RFC (targets must exist for replace/remove/copy-from/move-from/test); `strict: false` ≡ lenient. `add` is RFC in **both** modes (insert/replace, never asserts not-exist).
- Do **not** reverse `createPatches(to, from?)` — `from` is optional; order is intentional.
- Commit after each task with the exact message shown.

---

## File Structure

- `src/apply.ts` — modified: `parsePath` (proto guard, strict index, empty pointer, `-` sentinel), `assertValidPath`, new `deepEqual`/`sameValueZero`/`escape`-free helpers, `setPath` (options signature), `deletePath` (op-aware bounds), `getPath` (root), `applyPatches` (add insert, atomicity, empty-pointer, deep test).
- `src/create.ts` — modified: `escapeKey` helper, type-change guard, NaN/undefined handling, JSDoc arg-order note.
- `test/parse-path.test.ts` — **new**: parse-level security + index parsing.
- `test/lib.test.ts` — modified: rewrite the 3 conflicting cases; add insert/`-`/proto/bounds/clone/prefix/atomicity/empty-pointer cases.
- `test/create.test.ts` — modified: rewrite the 2 type-change cases; add escaping/NaN/undefined cases.
- `test/apply.test.ts` — unchanged (defaults preserve its low-level `setPath`/`deletePath` expectations).

---

## Task 1: Prototype-pollution guard + `Object.hasOwn`

**Files:**
- Modify: `src/apply.ts` (`parsePath`, `setPath`, `deletePath`)
- Test: `test/parse-path.test.ts` (create)

**Interfaces:**
- Produces: `parsePath(path: string): Array<string | number>` — now throws `PatchError('Forbidden path segment: <seg>', 'INVALID_PATH')` for any segment equal to `__proto__`, `constructor`, or `prototype`.

- [ ] **Step 1: Write the failing test**

Create `test/parse-path.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { applyPatches, PatchError } from '../src/index.js'
import { parsePath } from '../src/apply.js'

describe('parsePath() prototype-pollution guard', () => {
  test('rejects __proto__ segment', () => {
    expect(() => parsePath('/__proto__')).toThrow(PatchError)
    expect(() => parsePath('/__proto__/x')).toThrow('Forbidden path segment')
  })

  test('rejects constructor and prototype segments', () => {
    expect(() => parsePath('/constructor/prototype/x')).toThrow(PatchError)
    expect(() => parsePath('/a/prototype')).toThrow(PatchError)
  })

  test('does not pollute Object.prototype through apply', () => {
    const data: Record<string, unknown> = {}
    expect(() =>
      applyPatches(data, [{ op: 'add', path: '/__proto__/polluted', value: true }]),
    ).toThrow(PatchError)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/patch && pnpm vitest run test/parse-path.test.ts`
Expected: FAIL — the `add /__proto__/polluted` currently does not throw (and may pollute).

- [ ] **Step 3: Implement the guard in `parsePath`**

In `src/apply.ts`, add near the top (after `PatchError`):

```ts
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
```

Replace the body of `parsePath`'s `.map(...)` callback so the unescaped segment is checked before any index conversion:

```ts
export function parsePath(path: string): Array<string | number> {
  assertValidPath(path)
  return path
    .slice(1)
    .split('/')
    .map((key) => {
      const unescaped = key.replace(/~1/g, '/').replace(/~0/g, '~')
      if (FORBIDDEN_SEGMENTS.has(unescaped)) {
        throw new PatchError(`Forbidden path segment: ${unescaped}`, 'INVALID_PATH')
      }
      if (unescaped === '') {
        return unescaped
      }
      const index = Number(unescaped)
      return Number.isNaN(index) ? unescaped : index
    })
}
```

Then replace the two object-existence checks that use `in` with `Object.hasOwn`:
- In `setPath`, change `if (shouldExist && !(lastKey in target))` → `if (shouldExist && !Object.hasOwn(target as object, lastKey as string))`.
- In `deletePath`, change `if (!(lastKey in target) && strict)` → `if (!Object.hasOwn(target as object, lastKey as string) && strict)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/patch && pnpm vitest run test/parse-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite (regression check)**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS (no existing test uses forbidden segments).

- [ ] **Step 6: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/parse-path.test.ts
git commit -m "fix(patch): block prototype-pollution via patch paths"
```

---

## Task 2: Strict array-index parsing

**Files:**
- Modify: `src/apply.ts` (`parsePath`)
- Test: `test/parse-path.test.ts`

**Interfaces:**
- Produces: `parsePath` returns a `number` for a segment **only** when it matches `/^(0|[1-9]\d*)$/`; every other segment stays a `string` (so `'01'`, `' '`, `'1e2'`, `'0x10'`, `'1.5'`, `'-1'` are string keys). The literal `'-'` stays the string `'-'` (array-append sentinel, handled in Task 3).

- [ ] **Step 1: Write the failing test**

Append to `test/parse-path.test.ts`:

```ts
describe('parsePath() strict index parsing', () => {
  test('parses real indices as numbers', () => {
    expect(parsePath('/foo/0')).toEqual(['foo', 0])
    expect(parsePath('/foo/12/bar')).toEqual(['foo', 12, 'bar'])
  })

  test('keeps non-canonical numerics as string keys', () => {
    expect(parsePath('/01')).toEqual(['01'])
    expect(parsePath('/1e2')).toEqual(['1e2'])
    expect(parsePath('/0x10')).toEqual(['0x10'])
    expect(parsePath('/1.5')).toEqual(['1.5'])
    expect(parsePath('/ ')).toEqual([' '])
    expect(parsePath('/-1')).toEqual(['-1'])
  })

  test('keeps the append sentinel as a string', () => {
    expect(parsePath('/arr/-')).toEqual(['arr', '-'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/patch && pnpm vitest run test/parse-path.test.ts`
Expected: FAIL — `Number('01')` is `1`, `Number(' ')` is `0`, etc., so these currently coerce to numbers.

- [ ] **Step 3: Implement strict parsing**

In `src/apply.ts`, add the constant:

```ts
const ARRAY_INDEX_RE = /^(0|[1-9]\d*)$/
```

Replace the tail of the `parsePath` `.map` callback (the empty-string + `Number(...)` block) with:

```ts
      if (unescaped === '' || unescaped === '-') {
        return unescaped
      }
      return ARRAY_INDEX_RE.test(unescaped) ? Number(unescaped) : unescaped
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/patch && pnpm vitest run test/parse-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS. (`test/apply.test.ts` only asserts `parsePath('/foo/0') → ['foo', 0]` and `'/foo/1/bar' → ['foo', 1, 'bar']`, both still numeric.)

- [ ] **Step 6: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/parse-path.test.ts
git commit -m "fix(patch): parse only canonical integers as array indices"
```

---

## Task 3: `add` insert semantics, `-` append, drop not-exists assertion

**Files:**
- Modify: `src/apply.ts` (`setPath` signature + array branch, `applyPatches` `add`/`set`/`replace` cases, remove `assertPathDoesNotExist`)
- Test: `test/lib.test.ts`

**Interfaces:**
- Produces: `setPath(obj, path, value, opts?)` where
  `opts: { shouldExist?: boolean; insert?: boolean; allowAppend?: boolean }`
  (defaults `shouldExist=false`, `insert=false`, `allowAppend=true`).
  - `insert: true` → `splice(index, 0, value)` (RFC `add`).
  - `allowAppend: false` → index `=== length` throws `INVALID_INDEX` (used by `replace`).
  - array segment `'-'` → append when `allowAppend`, else `INVALID_INDEX`.
- Consumes: `parsePath` (Tasks 1–2).

- [ ] **Step 1: Rewrite the conflicting tests + add new ones**

In `test/lib.test.ts`:

**(a) Replace** the test `should throw on existing paths for add` (currently lines ~88–93) with:

```ts
  test('should replace on existing object key for add (RFC)', () => {
    const data: Record<string, unknown> = { foo: { bar: 1 } }
    applyPatches(data, [{ op: 'add', path: '/foo/bar', value: 2 }])
    expect(data).toEqual({ foo: { bar: 2 } })
  })
```

**(b) Replace** the test `should throw PatchError with correct code for path exists` (currently lines ~418–426) with:

```ts
    test('add on existing object key replaces without error', () => {
      const data: Record<string, unknown> = { foo: 1 }
      applyPatches(data, [{ op: 'add', path: '/foo', value: 2 }])
      expect(data.foo).toBe(2)
    })
```

**(c) Add** a new `describe` block for RFC array insert:

```ts
  describe('add insert semantics', () => {
    test('inserts before an existing index', () => {
      const data: Record<string, unknown> = { items: [1, 2, 3] }
      applyPatches(data, [{ op: 'add', path: '/items/1', value: 99 }])
      expect(data.items).toEqual([1, 99, 2, 3])
    })

    test('appends with the - token', () => {
      const data: Record<string, unknown> = { items: [1, 2, 3] }
      applyPatches(data, [{ op: 'add', path: '/items/-', value: 4 }])
      expect(data.items).toEqual([1, 2, 3, 4])
    })

    test('append at index === length still works', () => {
      const data: Record<string, unknown> = { items: [1, 2, 3] }
      applyPatches(data, [{ op: 'add', path: '/items/3', value: 4 }])
      expect(data.items).toEqual([1, 2, 3, 4])
    })

    test('set overwrites an index (no insert)', () => {
      const data: Record<string, unknown> = { items: [1, 2, 3] }
      applyPatches(data, [{ op: 'set', path: '/items/1', value: 99 }])
      expect(data.items).toEqual([1, 99, 3])
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts`
Expected: FAIL — `add /items/1` currently overwrites (`[1, 99, 3]`), `add /items/-` throws, and `add` on existing key currently throws.

- [ ] **Step 3: Implement the `setPath` options signature + array branch**

In `src/apply.ts`, replace `setPath` with:

```ts
export function setPath(
  obj: Record<string, unknown> | Array<unknown>,
  path: string,
  value: unknown,
  opts: { shouldExist?: boolean; insert?: boolean; allowAppend?: boolean } = {},
): void {
  const { shouldExist = false, insert = false, allowAppend = true } = opts
  const keys = parsePath(path)
  const lastKey = keys.pop()
  if (lastKey === undefined) {
    return
  }
  const target = keys.reduce((acc, key) => {
    if (acc === undefined) {
      throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
    }
    // @ts-expect-error unknown object
    return acc[key]
  }, obj)

  if (target === undefined) {
    throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
  }

  if (Array.isArray(target)) {
    if (lastKey === '-') {
      if (!allowAppend) {
        throw new PatchError('Append token not allowed here', 'INVALID_INDEX')
      }
      target.push(value)
      return
    }
    if (typeof lastKey !== 'number') {
      throw new PatchError('Array index must be a number', 'INVALID_INDEX')
    }
    const max = allowAppend ? target.length : target.length - 1
    if (lastKey < 0 || lastKey > max) {
      throw new PatchError(
        `Array index ${lastKey} out of bounds (length: ${target.length})`,
        'INVALID_INDEX',
      )
    }
    if (insert) {
      target.splice(lastKey, 0, value)
    } else if (lastKey === target.length) {
      target.push(value)
    } else {
      target[lastKey] = value
    }
  } else {
    if (shouldExist && !Object.hasOwn(target as object, lastKey as string)) {
      throw new PatchError(`Path ${path} does not exist`, 'PATH_NOT_FOUND')
    }
    const targetObj = target as Record<string, unknown>
    targetObj[lastKey as string] = value
  }
}
```

- [ ] **Step 4: Update `applyPatches` `add`/`replace` cases and remove `assertPathDoesNotExist`**

In `applyPatches`, change the `add`, `replace`, and `set` cases to:

```ts
      case 'add':
        setPath(data, patch.path, patch.value, { insert: true, allowAppend: true })
        break
      case 'replace':
        if (strict) {
          assertPathExists(data, patch.path)
        }
        setPath(data, patch.path, patch.value, { shouldExist: strict, allowAppend: false })
        break
      case 'set':
        setPath(data, patch.path, patch.value, { allowAppend: true })
        break
```

Delete the now-unused `assertPathDoesNotExist` function.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS. `test/apply.test.ts`'s `setPath(arr, '/3', 4)` append and `setPath(arr, '/5', 4)`/`'/-1'` throws still hold under the new defaults (`allowAppend=true`).

- [ ] **Step 7: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/lib.test.ts
git commit -m "fix(patch): RFC add inserts on arrays; support - append; add may replace"
```

---

## Task 4: Op-aware bounds for `remove` and `replace`

**Files:**
- Modify: `src/apply.ts` (`deletePath` array bounds)
- Test: `test/lib.test.ts`

**Interfaces:**
- Consumes: `setPath` `allowAppend: false` (Task 3) is already wired for `replace`; this task fixes `deletePath`.
- Produces: `remove` / `replace` at `index === length` throw `INVALID_INDEX` instead of silently no-op/append.

- [ ] **Step 1: Write the failing tests**

Add to `test/lib.test.ts` inside a new `describe('op-aware array bounds', ...)`:

```ts
  describe('op-aware array bounds', () => {
    test('remove at index === length throws', () => {
      const data: Record<string, unknown> = { items: [1, 2, 3] }
      expect(() => applyPatches(data, [{ op: 'remove', path: '/items/3' }])).toThrow(PatchError)
      expect(data.items).toEqual([1, 2, 3])
    })

    test('replace at index === length throws (does not append)', () => {
      const data: Record<string, unknown> = { items: [1, 2, 3] }
      expect(() =>
        applyPatches(data, [{ op: 'replace', path: '/items/3', value: 9 }], false),
      ).toThrow(PatchError)
      expect(data.items).toEqual([1, 2, 3])
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "op-aware array bounds"`
Expected: FAIL — `remove /items/3` currently no-ops (bounds allow `index === length`); non-strict `replace /items/3` currently appends.

- [ ] **Step 3: Implement stricter delete bounds**

In `src/apply.ts` `deletePath`, replace the array branch's `assertValidArrayIndex(target, lastKey)` call with an inline bound that excludes `length`:

```ts
    if (Array.isArray(target)) {
      if (typeof lastKey !== 'number') {
        throw new PatchError('Array index must be a number', 'INVALID_INDEX')
      }
      if (lastKey < 0 || lastKey >= target.length) {
        throw new PatchError(
          `Array index ${lastKey} out of bounds (length: ${target.length})`,
          'INVALID_INDEX',
        )
      }
      target.splice(lastKey, 1)
    } else {
```

(The `replace` at-length case is already handled by `allowAppend: false` from Task 3.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "op-aware array bounds"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS. (`assertValidArrayIndex` may now be unused — if so, delete it; if any caller remains, leave it.)

- [ ] **Step 6: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/lib.test.ts
git commit -m "fix(patch): remove/replace reject index === length"
```

---

## Task 5: `test` op deep structural equality

**Files:**
- Modify: `src/apply.ts` (new `sameValueZero` + `deepEqual`; `test` case)
- Test: `test/lib.test.ts`

**Interfaces:**
- Produces: `deepEqual(a: unknown, b: unknown): boolean` — structural JSON equality with SameValueZero leaves (`NaN` equals `NaN`; `+0` equals `-0`).

- [ ] **Step 1: Rewrite the conflicting test + add compound tests**

In `test/lib.test.ts`:

**(a) Replace** `should distinguish between +0 and -0` (currently ~180–186) with:

```ts
    test('treats +0 and -0 as equal (JSON equality)', () => {
      const data: Record<string, unknown> = { foo: +0 }
      expect(() => applyPatches(data, [{ op: 'test', path: '/foo', value: +0 }])).not.toThrow()
      expect(() => applyPatches(data, [{ op: 'test', path: '/foo', value: -0 }])).not.toThrow()
    })
```

**(b) Add** compound-value tests to the `test operations` describe:

```ts
    test('passes on deep-equal objects and arrays', () => {
      const data: Record<string, unknown> = { a: { x: [1, 2], y: 'z' } }
      expect(() =>
        applyPatches(data, [{ op: 'test', path: '/a', value: { x: [1, 2], y: 'z' } }]),
      ).not.toThrow()
    })

    test('fails on deep-unequal objects', () => {
      const data: Record<string, unknown> = { a: { x: [1, 2] } }
      expect(() =>
        applyPatches(data, [{ op: 'test', path: '/a', value: { x: [1, 3] } }]),
      ).toThrow(PatchError)
    })
```

(The existing `should handle NaN values correctly` test stays green: `deepEqual(NaN, NaN)` is `true`, `deepEqual(NaN, 0)` is `false`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "test operations"`
Expected: FAIL — `Object.is(+0, -0)` is `false` (old test expected a throw), and `Object.is` never matches distinct object references.

- [ ] **Step 3: Implement `deepEqual`**

Add to `src/apply.ts`:

```ts
function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (sameValueZero(a, b)) {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aArray = Array.isArray(a)
  if (aArray !== Array.isArray(b)) {
    return false
  }
  if (aArray) {
    const aArr = a as Array<unknown>
    const bArr = b as Array<unknown>
    return aArr.length === bArr.length && aArr.every((v, i) => deepEqual(v, bArr[i]))
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  return (
    aKeys.length === Object.keys(bObj).length &&
    aKeys.every((k) => Object.hasOwn(bObj, k) && deepEqual(aObj[k], bObj[k]))
  )
}
```

Change the `test` case comparison from `if (!Object.is(value, patch.value))` to `if (!deepEqual(value, patch.value))`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "test operations"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/lib.test.ts
git commit -m "fix(patch): test op uses deep JSON equality"
```

---

## Task 6: `copy` deep-clone + `move` prefix check

**Files:**
- Modify: `src/apply.ts` (`applyPatches` `copy`/`move` cases)
- Test: `test/lib.test.ts`

**Interfaces:**
- Consumes: `setPath(..., { insert: true, allowAppend: true })` for the destination (matches existing copy/move-between-arrays tests).
- Produces: `copy` inserts a `structuredClone` of the source; `move` throws `INVALID_PATH` when `from` is a proper prefix of `path`.

- [ ] **Step 1: Write the failing tests**

Add to `test/lib.test.ts`:

```ts
  describe('copy/move reference safety', () => {
    test('copy produces an independent subtree', () => {
      const data: Record<string, unknown> = { src: { n: 1 }, dst: {} }
      applyPatches(data, [{ op: 'copy', from: '/src', path: '/dst/copied' }])
      applyPatches(data, [{ op: 'replace', path: '/src/n', value: 2 }])
      expect((data.dst as Record<string, Record<string, unknown>>).copied.n).toBe(1)
    })

    test('move rejects moving into own descendant', () => {
      const data: Record<string, unknown> = { a: { b: { c: 1 } } }
      expect(() =>
        applyPatches(data, [{ op: 'move', from: '/a', path: '/a/b/moved' }]),
      ).toThrow(PatchError)
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "copy/move reference safety"`
Expected: FAIL — copy shares a live reference (copied `n` becomes 2), and move has no prefix check.

- [ ] **Step 3: Implement clone + prefix check**

Add a helper to `src/apply.ts`:

```ts
function isProperPrefix(from: string, path: string): boolean {
  return path === from || path.startsWith(`${from}/`)
}
```

In `applyPatches`, update the `copy` and `move` cases:

```ts
      case 'copy': {
        assertPathExists(data, patch.from)
        const value = getPath(data, patch.from)
        if (value === undefined) {
          throw new PatchError(`Source path ${patch.from} does not exist`, 'PATH_NOT_FOUND')
        }
        setPath(data, patch.path, structuredClone(value), { insert: true, allowAppend: true })
        break
      }
      case 'move': {
        if (isProperPrefix(patch.from, patch.path)) {
          throw new PatchError(
            `Cannot move ${patch.from} into its own descendant ${patch.path}`,
            'INVALID_PATH',
          )
        }
        assertPathExists(data, patch.from)
        const value = getPath(data, patch.from)
        if (value === undefined) {
          throw new PatchError(`Source path ${patch.from} does not exist`, 'PATH_NOT_FOUND')
        }
        deletePath(data, patch.from)
        setPath(data, patch.path, value, { insert: true, allowAppend: true })
        break
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "copy/move reference safety"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS. Existing `should copy between arrays` (`/items/0 → /items/3`) and `should move between arrays` (`/items/0 → /items/2`) still produce `[1,2,3,1]` and `[2,3,1]` under insert semantics.

- [ ] **Step 6: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/lib.test.ts
git commit -m "fix(patch): copy deep-clones; move rejects descendant target"
```

---

## Task 7: `applyPatches` atomicity

**Files:**
- Modify: `src/apply.ts` (`applyPatches` wrapper)
- Test: `test/lib.test.ts`

**Interfaces:**
- Produces: `applyPatches` applies the sequence to a `structuredClone` of `data`; on full success it swaps the result back into `data` (clear own keys, `Object.assign`); on any throw, `data` is untouched. Signature (void, in-place) unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/lib.test.ts`:

```ts
  describe('atomicity', () => {
    test('mutation before a later failure leaves input unchanged', () => {
      const data: Record<string, unknown> = { foo: 1, bar: 2 }
      expect(() =>
        applyPatches(data, [
          { op: 'replace', path: '/foo', value: 99 },
          { op: 'test', path: '/bar', value: 3 }, // fails
        ]),
      ).toThrow(PatchError)
      expect(data).toEqual({ foo: 1, bar: 2 })
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "atomicity"`
Expected: FAIL — the `replace` mutates in place before the `test` throws, so `data.foo` is `99`.

- [ ] **Step 3: Implement clone-and-swap**

In `src/apply.ts`, wrap the existing loop. Rename the current `applyPatches` body's loop to operate on a `working` clone, then swap:

```ts
export function applyPatches(
  data: Record<string, unknown>,
  patches: Array<PatchOperation>,
  strict = true,
): void {
  const working = structuredClone(data)
  for (const patch of patches) {
    // ... existing switch, but referencing `working` instead of `data` ...
  }
  for (const key of Object.keys(data)) {
    delete data[key]
  }
  Object.assign(data, working)
}
```

Concretely: change every `data` reference **inside the for-loop switch** (the `assertPathExists(data, ...)`, `setPath(data, ...)`, `getPath(data, ...)`, `deletePath(data, ...)` calls) to `working`. Leave the function parameter named `data`; only the loop body uses `working`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "atomicity"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS. (Existing `should abort entire patch on test failure` still passes; in-place round-trip tests still see mutations applied on success.)

- [ ] **Step 6: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/lib.test.ts
git commit -m "fix(patch): applyPatches is atomic (clone-and-swap)"
```

---

## Task 8: Empty-pointer read-only support

**Files:**
- Modify: `src/apply.ts` (`assertValidPath`, `getPath`, `setPath`, `deletePath`, `applyPatches` `test`)
- Test: `test/lib.test.ts`

**Interfaces:**
- Consumes: `deepEqual` (Task 5), `working` clone (Task 7).
- Produces: `getPath(obj, '')` returns the root; the `test` op accepts `''` (whole-document deep-equality); `add`/`replace`/`set`/`remove` at `''` throw `PatchError('Root mutation unsupported', 'INVALID_PATH')`.

- [ ] **Step 1: Rewrite the root-path test + add cases**

In `test/lib.test.ts`, **replace** the `root path operations` describe block (currently ~202–214) with:

```ts
  describe('root path operations', () => {
    test('test on the whole document (empty pointer) passes on match', () => {
      const data: Record<string, unknown> = { original: 'value' }
      expect(() =>
        applyPatches(data, [{ op: 'test', path: '', value: { original: 'value' } }]),
      ).not.toThrow()
    })

    test('test on the whole document fails on mismatch', () => {
      const data: Record<string, unknown> = { original: 'value' }
      expect(() =>
        applyPatches(data, [{ op: 'test', path: '', value: { original: 'other' } }]),
      ).toThrow(PatchError)
    })

    test('mutating the root is rejected clearly', () => {
      const data: Record<string, unknown> = { a: 1 }
      expect(() =>
        applyPatches(data, [{ op: 'replace', path: '', value: { b: 2 } }]),
      ).toThrow('Root mutation unsupported')
      expect(data).toEqual({ a: 1 })
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "root path operations"`
Expected: FAIL — `parsePath('')` currently throws `INVALID_PATH` (fails `startsWith('/')`), so even `test ''` throws the wrong error.

- [ ] **Step 3: Allow the empty pointer at parse; guard mutation at the primitives**

In `src/apply.ts`:

Change `assertValidPath` to accept `''`:

```ts
function assertValidPath(path: string): void {
  if (path !== '' && !path.startsWith('/')) {
    throw new PatchError('Path must start with /', 'INVALID_PATH')
  }
}
```

`parsePath('')` now returns `[]` (the `.slice(1).split('/')` of `''` yields `['']`; guard it): add at the top of `parsePath`, after `assertValidPath(path)`:

```ts
  if (path === '') {
    return []
  }
```

`getPath` already returns `obj` for `keys = []` (the reduce seed). No change needed.

In `setPath`, replace the early `if (lastKey === undefined) { return }` with a hard error (empty pointer = root mutation):

```ts
  const lastKey = keys.pop()
  if (lastKey === undefined) {
    throw new PatchError('Root mutation unsupported', 'INVALID_PATH')
  }
```

In `deletePath`, add the same guard right after `const lastKey = keys.pop()`:

```ts
  const lastKey = keys.pop()
  if (lastKey === undefined) {
    throw new PatchError('Root mutation unsupported', 'INVALID_PATH')
  }
```

- [ ] **Step 4: Ensure the `test` op reads the root**

The `test` case already calls `assertPathExists(working, patch.path)` then `getPath(working, patch.path)`. For `path === ''`, `getPath` returns the root object (never `undefined` here), so `assertPathExists` passes and `deepEqual` compares the whole document. No code change required beyond Steps 3 — but verify `assertPathExists` does not misfire on a root whose value is defined (it won't; the root object is defined).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/patch && pnpm vitest run test/lib.test.ts -t "root path operations"`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `cd packages/patch && pnpm vitest run`
Expected: PASS. (`empty string property keys` tests use `'/'`, which parses to key `''` — unaffected by the `''` empty-pointer handling.)

- [ ] **Step 7: Commit**

```bash
git add packages/patch/src/apply.ts packages/patch/test/lib.test.ts
git commit -m "feat(patch): read-only whole-document pointer; reject root mutation"
```

---

## Task 9: `create.ts` — escaping, type-change, NaN/undefined, arg-order doc

**Files:**
- Modify: `src/create.ts`
- Test: `test/create.test.ts`

**Interfaces:**
- Produces: `createPatches(to, from?)` emits escaped pointers, a single `replace` on object↔array type changes, no spurious `replace` for equal `NaN`, and no `undefined` values in patches.

- [ ] **Step 1: Rewrite the type-change tests + add escaping/NaN/undefined tests**

In `test/create.test.ts`:

**(a) Replace** `should handle type change from object to array` (currently ~211–223) with:

```ts
  test('should handle type change from object to array as a single replace', () => {
    const from = { data: { foo: 'bar' } }
    const to = { data: [1, 2, 3] }
    const patches = createPatches(to, from)
    expect(patches).toEqual([{ op: 'replace', path: '/data', value: [1, 2, 3] }])
  })
```

**(b) Replace** `should handle type change from array to object` (currently ~225–237) with:

```ts
  test('should handle type change from array to object as a single replace', () => {
    const from = { data: [1, 2, 3] }
    const to = { data: { foo: 'bar' } }
    const patches = createPatches(to, from)
    expect(patches).toEqual([{ op: 'replace', path: '/data', value: { foo: 'bar' } }])
  })
```

**(c) Add** new tests:

```ts
  test('escapes ~ and / in emitted paths (round-trips)', () => {
    const from = { 'a/b': 1, 'c~d': 2 }
    const to = { 'a/b': 9, 'c~d': 2 }
    const patches = createPatches(to, from)
    expect(patches).toEqual([{ op: 'replace', path: '/a~1b', value: 9 }])

    const result = structuredClone(from)
    applyPatches(result, patches)
    expect(result).toEqual(to)
  })

  test('does not emit a replace for equal NaN', () => {
    const from = { n: Number.NaN }
    const to = { n: Number.NaN }
    expect(createPatches(to, from)).toEqual([])
  })

  test('does not emit undefined values', () => {
    const from = { a: 1 }
    const to = { a: undefined } as unknown as Record<string, unknown>
    const patches = createPatches(to, from)
    expect(patches).toEqual([{ op: 'remove', path: '/a' }])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/patch && pnpm vitest run test/create.test.ts`
Expected: FAIL — type changes emit member-wise ops, keys aren't escaped, `NaN !== NaN` emits a spurious `replace`, and `undefined` leaks into a `replace` value.

- [ ] **Step 3: Implement the create-side fixes**

In `src/create.ts`:

Add helpers at the top of the module (inside the file, above `createPatches`):

```ts
function escapeKey(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b)
}
```

In `compareObjects`, build object-key paths with escaping — change both
`const currentPath = \`${path}/${key}\`` occurrences (the `fromKeys` loop and the `additionalKeys` loop) to:

```ts
      const currentPath = `${path}/${escapeKey(key)}`
```

Change the "values differ" guard from `if (toValue !== fromValue)` to `if (!sameValueZero(toValue, fromValue))` (both in `compareObjects` and `compareArrays`) so equal `NaN` does not diff.

Add the type-change guard as the **first** branch inside each differ block (before the `Array.isArray && Array.isArray` and `typeof object` branches), in **both** `compareObjects` and `compareArrays`:

```ts
        if (toValue === null) {
          patches.push({ op: 'replace', path: currentPath, value: null })
        } else if (fromValue === null) {
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        } else if (Array.isArray(toValue) !== Array.isArray(fromValue)) {
          patches.push({ op: 'replace', path: currentPath, value: toValue })
        } else if (Array.isArray(toValue) && Array.isArray(fromValue)) {
          // ... existing arrays branch ...
```

Handle `undefined` target values in `compareObjects`: at the top of the `fromKeys` loop body, treat an `undefined` `toValue` on an existing `from` key as a removal — replace the existing `if (!(key in toObj))` removal check with:

```ts
      if (!(key in toObj) || toObj[key] === undefined) {
        patches.push({ op: 'remove', path: `${path}/${escapeKey(key)}` })
        continue
      }
```

And skip `undefined` in the `additionalKeys` loop:

```ts
    for (const key of additionalKeys) {
      const toValue = toObj[key]
      if (toValue === undefined) {
        continue
      }
      const currentPath = `${path}/${escapeKey(key)}`
      patches.push({ op: 'add', path: currentPath, value: toValue })
    }
```

- [ ] **Step 4: Document the argument order**

Update the `createPatches` JSDoc: add a line under `@param from` noting the order is intentional and reversed from typical `(from, to)` diff APIs because `from` is optional:

```ts
 * @param to - Target object state
 * @param from - Source object state (defaults to empty object). NOTE: `to` comes first
 *   (reversed from typical diff APIs) so `from` can be optional — `createPatches(to)`
 *   diffs against an empty object.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/patch && pnpm vitest run test/create.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite + type check**

Run: `cd packages/patch && pnpm vitest run && pnpm run test:types`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add packages/patch/src/create.ts packages/patch/test/create.test.ts
git commit -m "fix(patch): create escapes keys, single replace on type change, handles NaN/undefined"
```

---

## Task 10: README usage + final verification

**Files:**
- Modify: `packages/patch/README.md`
- Test: full package suite

**Interfaces:** none (docs + verification only).

- [ ] **Step 1: Add a usage example to the README**

Replace the install-only stub `packages/patch/README.md` with an install section plus one example covering the Hybrid contract (RFC ops + `set` extension + strict flag):

```md
# @sozai/patch

JSON Patch (RFC 6902) utilities with a small pragmatic superset.

## Installation

​```sh
pnpm add @sozai/patch
​```

## Usage

​```ts
import { applyPatches, createPatches } from '@sozai/patch'

const from = { items: [1, 2, 3] }
const to = { items: [1, 9, 2, 3] }

const patches = createPatches(to, from)
// [{ op: 'add', path: '/items/1', value: 9 }]  // RFC insert-before

const data = structuredClone(from)
applyPatches(data, patches)      // atomic; throws PatchError on failure
// data → { items: [1, 9, 2, 3] }

// Extensions: `set` overwrites (never inserts); strict:false tolerates missing paths.
applyPatches(data, [{ op: 'set', path: '/items/0', value: 0 }])
​```

Standard ops (`add`/`remove`/`replace`/`copy`/`move`/`test`) follow RFC 6902/6901.
`set` (assign/overwrite) and the non-strict mode are documented non-standard extensions.
```

(Remove the placeholder zero-width joiner marks around the code fences — they are only here to escape nested fences.)

- [ ] **Step 2: Run the entire package suite (types + unit)**

Run: `cd packages/patch && pnpm run test`
Expected: PASS — both `test:types` and `test:unit`.

- [ ] **Step 3: Build the package (verify SWC + tsc emit cleanly)**

Run: `pnpm --filter @sozai/patch run build`
Expected: build succeeds; `lib/` regenerated (do not hand-edit).

- [ ] **Step 4: Commit**

```bash
git add packages/patch/README.md
git commit -m "docs(patch): add usage example for the Hybrid contract"
```

---

## Self-Review

**Spec coverage:**
- Security / prototype pollution → Task 1. ✅
- RFC 6901 index parsing → Task 2. ✅
- `-` append token → Task 3. ✅
- `add` insert + drop not-exists assertion → Task 3. ✅
- Op-aware bounds (remove/replace at length) → Task 4. ✅
- `test` deep equality → Task 5. ✅
- `copy` clone + `move` prefix check → Task 6. ✅
- `applyPatches` atomicity → Task 7. ✅
- Empty-pointer read-only → Task 8. ✅
- create: escaping, type-change, NaN/undefined → Task 9. ✅
- `createPatches` arg order (keep + document) → Task 9 Step 4. ✅
- `set` + non-strict as documented extensions → README (Task 10) + behavior preserved throughout. ✅
- Rewrite tests that enshrine broken behavior → Tasks 3 (add-exists), 5 (+0/-0), 8 (root), 9 (type-change). ✅

**Type consistency:** `setPath` options `{ shouldExist?, insert?, allowAppend? }` defined in Task 3 and consumed with the same keys in Tasks 6/8. `deepEqual` defined in Task 5, consumed in Task 8. `working` clone introduced in Task 7 and referenced by Task 8's `test`-op note. `escapeKey`/`sameValueZero` are file-local to `create.ts` (Task 9), independent of the same-named `sameValueZero` in `apply.ts` (Task 5) — duplicated intentionally to keep the modules decoupled; both are three-line pure helpers.

**Placeholder scan:** none — every step has concrete code and exact commands.

**Note on ordering:** Tasks 3, 4, 6, 7, 8 all edit `applyPatches`/`setPath` in `src/apply.ts`; execute in order so each builds on the prior signature. Task 7 (atomicity) changes `data`→`working` inside the loop; Task 8 adds the `test`-op root read against that same `working`.
