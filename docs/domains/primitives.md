# Primitives

Pure data primitives: `Option`/`Result`/`AsyncResult` and JSON-patch apply/create.

## Packages

| Package | Purpose |
|---|---|
| `@sozai/result` | Typed success/failure wrappers — `Option`, `Result`, `AsyncResult` |
| `@sozai/patch` | JSON-patch diff and apply for plain objects |

---

## @sozai/result

### Result

`Result<V, E>` wraps a synchronous computation that either succeeded (`ok`) or failed (`error`). It never throws — callers handle both branches explicitly.

#### Exports

| Export | Kind | Description |
|---|---|---|
| `Result` | class | Typed success/failure wrapper |
| `Result.ok(value)` | static | Wrap a success value |
| `Result.error(error)` | static | Wrap an error |
| `Result.from(value)` | static | Coerce unknown to `Result` (Error → error, other → ok) |
| `Result.is(value)` | static | Type guard — true when value is a `Result` |
| `Result.toError(cause, createError?)` | static | Coerce unknown to a `Result` error, wrapping non-Error causes |
| `.isOK()` | method | Narrow to ok result |
| `.isError()` | method | Narrow to error result |
| `.error` | getter | Error instance or `null` |
| `.value` | getter | Success value; throws the error if not ok |
| `.optional` | getter | `Option<V>` — some on ok, none on error |
| `.orNull` | getter | Value or `null` |
| `.or(defaultValue)` | method | Value or fallback |
| `.map(fn)` | method | Transform ok value; pass errors through |
| `.mapError(fn)` | method | Transform error; pass ok through |

#### Example

```typescript
import { Result } from '@sozai/result'

function divide(a: number, b: number): Result<number> {
  if (b === 0) return Result.error(new Error('Division by zero'))
  return Result.ok(a / b)
}

const result = divide(10, 2).map((n) => n * 100)

if (result.isOK()) {
  console.log(result.value) // 500
} else {
  console.log(result.error?.message)
}

// Chain safely — errors pass through untouched
const chained = divide(10, 0)
  .map((n) => n * 2)
  .mapError((e) => new RangeError(e.message))

console.log(chained.orNull) // null
```

---

### Option

`Option<V>` represents a value that may or may not be present — `some(value)` or `none`. It replaces `null`/`undefined` sentinel patterns.

#### Exports

| Export | Kind | Description |
|---|---|---|
| `Option` | class | Optional value wrapper |
| `Option.none()` | static | Empty option |
| `Option.some(value)` | static | Wrap a value |
| `Option.of(value?)` | static | `none` if `null`/`undefined`, else `some` |
| `Option.is(value)` | static | Type guard |
| `Option.from(value)` | static | Coerce unknown — wraps existing `Option` or calls `Option.of` |
| `.isSome()` | method | Narrow to some |
| `.isNone()` | method | Narrow to none |
| `.orNull` | getter | Value or `null` |
| `.orThrow` | getter | Value or throws |
| `.or(defaultValue)` | method | Value or fallback |
| `.map(fn)` | method | Transform value if some; pass none through |

#### Example

```typescript
import { Option } from '@sozai/result'

type User = { name: string; score: number }

function findUser(id: string): Option<User> {
  const db = new Map([['1', { name: 'Alice', score: 42 }]])
  return Option.of(db.get(id))
}

const name = findUser('1')
  .map((u) => u.name)
  .or('unknown')

console.log(name) // 'Alice'
console.log(findUser('99').orNull) // null
```

---

### AsyncResult

`AsyncResult<V, E>` wraps an async computation with `Result` semantics. It implements `PromiseLike<Result<V, E>>` and can be `await`-ed directly.

#### Exports

| Export | Kind | Description |
|---|---|---|
| `AsyncResult` | class | Async result wrapper (`PromiseLike<Result<V, E>>`) |
| `AsyncResult.all(values)` | static | Settle all iterables; returns `AsyncResult<Array<Result<V, E>>, never>` |
| `AsyncResult.ok(value)` | static | Resolved ok |
| `AsyncResult.error(error)` | static | Resolved error |
| `AsyncResult.resolve(value)` | static | Wrap a `Promise` or plain value; catches rejections |
| `AsyncResult.is(value)` | static | Type guard |
| `AsyncResult.from(value)` | static | Coerce unknown to `AsyncResult` |
| `.value` | getter | `Promise<V>` — rejects if error |
| `.optional` | getter | `Promise<Option<V>>` |
| `.orNull` | getter | `Promise<V \| null>` |
| `.or(defaultValue)` | method | `Promise<V>` — fallback on error |
| `.map(fn)` | method | Transform ok value asynchronously; returns new `AsyncResult` |
| `.mapError(fn)` | method | Transform error asynchronously; pass ok through |
| `.then(onfulfilled, onrejected)` | method | `PromiseLike` — enables `await` |

#### Example

```typescript
import { AsyncResult } from '@sozai/result'

// Wrap a promise — rejections become error Results automatically
const score = AsyncResult.resolve(
  fetch('/api/score/42').then((r) => r.json() as Promise<number>),
)

const doubled = score.map((n) => n * 2)
const final = await doubled
console.log(final.isOK() ? final.value : final.error?.message)

// Settle multiple operations — each result is independently ok or error
const batch = await AsyncResult.all([
  fetch('/api/score/1').then((r) => r.json() as Promise<number>),
  fetch('/api/score/2').then((r) => r.json() as Promise<number>),
])
const scores = batch.value // AsyncResult.all settled to a sync Result — .value is synchronous
// scores: Array<Result<number>>
for (const s of scores) {
  console.log(s.orNull)
}
```

---

## @sozai/patch

JSON-patch: compute and apply diffs between plain objects.

### Exports

| Export | Kind | Description |
|---|---|---|
| `createPatches(to, from?)` | function | Compute operations to transform `from` → `to`; `from` defaults to `{}` |
| `applyPatches(data, patches, strict?)` | function | Apply patches in-place on `data`; throws `PatchError` on failure |
| `PatchError` | class | Error with `code: string` from failed patch operations |
| `patchAddOperationSchema` | const | JSON Schema for `add` (path must not exist in strict mode) |
| `patchSetOperationSchema` | const | JSON Schema for `set` (add or overwrite; no existence check) |
| `patchRemoveOperationSchema` | const | JSON Schema for `remove` |
| `patchReplaceOperationSchema` | const | JSON Schema for `replace` (path must exist in strict mode) |
| `patchMoveOperationSchema` | const | JSON Schema for `move` (from + path) |
| `patchCopyOperationSchema` | const | JSON Schema for `copy` (from + path) |
| `patchTestOperationSchema` | const | JSON Schema for `test` (assert value at path) |
| `patchOperationSchema` | const | Union schema of all operations |
| `PatchAddOperation` | type | Inferred type for `add` |
| `PatchSetOperation` | type | Inferred type for `set` |
| `PatchRemoveOperation` | type | Inferred type for `remove` |
| `PatchReplaceOperation` | type | Inferred type for `replace` |
| `PatchMoveOperation` | type | Inferred type for `move` |
| `PatchCopyOperation` | type | Inferred type for `copy` |
| `PatchTestOperation` | type | Inferred type for `test` |
| `PatchOperation` | type | Union of all operation types |

Note: `createPatches` signature is `(to, from)` — target state first, source second.
`applyPatches` mutates `data` in place and returns `void`.

### Example

```typescript
import { createPatches, applyPatches, PatchError } from '@sozai/patch'

const before = { name: 'Alice', score: 10, tags: ['a'] }
const after  = { name: 'Alice', score: 20, tags: ['a', 'b'] }

// Diff — first argument is the target state
const patches = createPatches(after, before)
// [
//   { op: 'replace', path: '/score', value: 20 },
//   { op: 'add',     path: '/tags/1', value: 'b' }
// ]

// Apply — mutates in place
const current = structuredClone(before)
try {
  applyPatches(current, patches)
  // current: { name: 'Alice', score: 20, tags: ['a', 'b'] }
} catch (e) {
  if (e instanceof PatchError) {
    console.error(e.message, e.code) // e.g. 'PATH_NOT_FOUND'
  }
}
```

Using operation schemas for runtime validation:

```typescript
import type { PatchOperation } from '@sozai/patch'
import { patchOperationSchema } from '@sozai/patch'
import { createValidator } from '@sozai/schema'

const validateOp = createValidator<typeof patchOperationSchema, PatchOperation>(patchOperationSchema)
```

---

## When to use

**`@sozai/result`** — use `Result` when a synchronous function can fail and you want callers to handle both outcomes without `try`/`catch`. Use `Option` when a value may be absent (`Map.get`, nullable config). Use `AsyncResult` when wrapping async operations — it composes like `Result` but stays awaitable and catches promise rejections automatically.

**`@sozai/patch`** — use when you need to diff two JSON-serialisable objects (`createPatches`) or apply a stored set of operations to an object (`applyPatches`). Suitable for optimistic state updates, event-sourcing deltas, and syncing state across process boundaries.
