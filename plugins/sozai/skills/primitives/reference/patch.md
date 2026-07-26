# @sozai/patch

JSON-patch: compute and apply diffs between plain objects.

## Exports

| Export | Kind | Description |
|---|---|---|
| `createPatches(to, from?)` | function | Compute operations to transform `from` → `to`; `from` defaults to `{}` |
| `applyPatches(data, patches, strict?)` | function | Apply patches to `data`; throws `PatchError` on failure |
| `PatchError` | class | Error with `code: string` from a failed patch operation |
| `patchAddOperationSchema` | const | JSON Schema for `add` — insert into an array (shifting later elements right) or upsert an object key |
| `patchSetOperationSchema` | const | JSON Schema for `set` — upsert an object key, or overwrite an array element in place (append if the index equals the array length) |
| `patchRemoveOperationSchema` | const | JSON Schema for `remove` |
| `patchReplaceOperationSchema` | const | JSON Schema for `replace` (path must already exist in strict mode) |
| `patchMoveOperationSchema` | const | JSON Schema for `move` (`from` + `path`) |
| `patchCopyOperationSchema` | const | JSON Schema for `copy` (`from` + `path`) |
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

Notes:
- `createPatches` signature is `(to, from)` — target state first, source second.
- `applyPatches` applies every operation to an internal clone of `data`, then writes the result
  onto `data`'s own keys only once all operations succeed — a failure partway through leaves
  `data` untouched. In `strict` mode (the default) only `replace`, `remove`, and `move`/`copy`
  (checking `from`) require the path to already exist; `test` always requires it; `add` and `set`
  never check existence, strict or not.
- `PatchError.code` is one of `INVALID_PATH`, `PATH_NOT_FOUND`, `INVALID_INDEX`, `TEST_FAILED`,
  `INVALID_OPERATION`.

## Example

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

// Apply — mutates in place once every operation succeeds
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
