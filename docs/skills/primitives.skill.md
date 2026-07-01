---
name: sozai:primitives
description: Option/Result/AsyncResult typed wrappers and JSON-patch diff/apply primitives
---

# Sozai Primitives

## Packages in This Domain

**Typed wrappers**: `@sozai/result` — `Option`, `Result`, `AsyncResult`

**JSON patch**: `@sozai/patch` — `createPatches`, `applyPatches`

## Key Patterns

### Pattern 1: Typed success/failure with Result, Option, and AsyncResult

Use `Result` for synchronous operations that can fail. Chain `.map` and `.mapError` to transform values without nested `try`/`catch`.

```typescript
import { Result, Option, AsyncResult } from '@sozai/result'

// Result — synchronous, typed error
type ParsedConfig = { host: string; port: number }

function parseConfig(raw: unknown): Result<ParsedConfig> {
  if (typeof raw !== 'object' || raw === null) {
    return Result.error(new TypeError('Expected object'))
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj['host'] !== 'string') {
    return Result.error(new TypeError('host must be a string'))
  }
  return Result.ok({ host: obj['host'], port: Number(obj['port']) ?? 8080 })
}

const config = parseConfig({ host: 'localhost', port: '3000' })
  .map((c) => ({ ...c, port: c.port || 8080 }))

console.log(config.orNull) // { host: 'localhost', port: 3000 }

// Option — present or absent
function getEnv(key: string): Option<string> {
  return Option.of(process.env[key])
}

const logLevel = getEnv('LOG_LEVEL').or('info')

// AsyncResult — async with automatic rejection capture
const userData = AsyncResult.resolve(
  fetch('/api/user/42').then((r) => r.json() as Promise<{ name: string }>),
)

const userName = userData.map((u) => u.name)
const result = await userName
console.log(result.isOK() ? result.value : 'anonymous')
```

**Key points**:
- `Result.ok` / `Result.error` — construct typed results; never throw
- `.map(fn)` — transform the ok value; errors pass through unchanged
- `.mapError(fn)` — transform the error; ok values pass through unchanged
- `Option.of(x)` — `none` when `x` is `null`/`undefined`, `some` otherwise
- `AsyncResult.resolve(promise)` — captures rejections as error Results
- `AsyncResult.all(iterable)` — settles all in parallel; each element is independently `ok` or `error`

### Pattern 2: Diff and apply JSON state with patch

Use `createPatches` to compute the minimal operations to move from one object state to another, then `applyPatches` to replay those operations.

```typescript
import { createPatches, applyPatches, PatchError } from '@sozai/patch'
import type { PatchOperation } from '@sozai/patch'

type SessionState = {
  userID: string
  score: number
  tags: Array<string>
  metadata: Record<string, unknown>
}

const previous: SessionState = {
  userID: 'u1',
  score: 10,
  tags: ['beta'],
  metadata: { version: 1 },
}

const next: SessionState = {
  userID: 'u1',
  score: 25,
  tags: ['beta', 'winner'],
  metadata: { version: 2 },
}

// createPatches(target, source) — target is first argument
const patches: Array<PatchOperation> = createPatches(next, previous)
// [
//   { op: 'replace', path: '/score',           value: 25 },
//   { op: 'add',     path: '/tags/1',           value: 'winner' },
//   { op: 'replace', path: '/metadata/version', value: 2 },
// ]

// Apply — mutates the object in place, returns void
const current = structuredClone(previous)
try {
  applyPatches(current, patches)
} catch (e) {
  if (e instanceof PatchError) {
    // e.code: 'INVALID_PATH' | 'PATH_NOT_FOUND' | 'PATH_EXISTS' | 'INVALID_INDEX' | 'TEST_FAILED' | 'INVALID_OPERATION'
    console.error(`Patch failed [${e.code}]: ${e.message}`)
  }
}
```

**Key points**:
- `createPatches(to, from)` — target state is the **first** argument, source is the second
- `applyPatches` mutates `data` in place; wrap in `try`/`catch` when operations may conflict
- `strict` (default `true`) — when `false`, skips existence checks for `add`/`replace`/`remove`
- `patchOperationSchema` validates the union of all operations; individual schemas (`patchAddOperationSchema`, `patchSetOperationSchema`, `patchRemoveOperationSchema`, `patchReplaceOperationSchema`, `patchMoveOperationSchema`, `patchCopyOperationSchema`, `patchTestOperationSchema`) validate specific ops
- `PatchOperation` type covers all operations: `add`, `set`, `remove`, `replace`, `move`, `copy`, `test`

## Reference

Full export tables and additional examples: [`docs/reference/primitives.md`](../reference/primitives.md)
