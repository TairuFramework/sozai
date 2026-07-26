# @sozai/result — Option

Sibling references: `reference/result.md` (Result), `reference/result-async.md` (AsyncResult).

`Option<V>` represents a value that may or may not be present — `some(value)` or `none`. It
replaces `null`/`undefined` sentinel patterns.

### Exports

| Export | Kind | Description |
|---|---|---|
| `Option` | class | Optional value wrapper |
| `Option.none()` | static | Empty option |
| `Option.some(value)` | static | Wrap a value |
| `Option.of(value?)` | static | `none` if `null`/`undefined`, else `some` |
| `Option.is(value)` | static | Type guard |
| `Option.from(value)` | static | Coerce unknown — wraps an existing `Option` or calls `Option.of` |
| `.isSome()` | method | Narrow to some |
| `.isNone()` | method | Narrow to none |
| `.orNull` | getter | Value or `null` |
| `.orThrow` | getter | Value, or throws `Error('Option is none')` |
| `.or(defaultValue)` | method | Value or fallback |
| `.map(fn)` | method | Transform value if some; pass none through. Unlike `Result.map`, an exception thrown by `fn` is **not** caught — it propagates |

### Example

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
