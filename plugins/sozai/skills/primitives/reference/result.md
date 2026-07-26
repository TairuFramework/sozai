# @sozai/result — Result

Sibling references: `reference/result-option.md` (Option), `reference/result-async.md` (AsyncResult).

`Result<V, E>` wraps a synchronous computation that either succeeded (`ok`) or failed (`error`).
It never throws — callers handle both branches explicitly.

### Exports

| Export | Kind | Description |
|---|---|---|
| `Result` | class | Typed success/failure wrapper |
| `Result.ok(value)` | static | Wrap a success value |
| `Result.error(error)` | static | Wrap an error |
| `Result.from(value)` | static | Coerce unknown to `Result` — an existing `Result` passes through, an `Error` becomes `error`, anything else becomes `ok` |
| `Result.is(value)` | static | Type guard — true when value is a `Result` |
| `Result.toError(cause, createError?)` | static | Build an error `Result`, wrapping a non-`Error` cause in a generic `Error` (or via `createError`) |
| `.isOK()` | method | Narrow to ok result |
| `.isError()` | method | Narrow to error result |
| `.error` | getter | Error instance or `null` |
| `.value` | getter | Success value; throws the error if not ok |
| `.optional` | getter | `Option<V>` — some on ok, none on error |
| `.orNull` | getter | Value or `null` |
| `.or(defaultValue)` | method | Value or fallback |
| `.map(fn)` | method | Transform ok value; pass errors through. An exception thrown by `fn` is caught and becomes an error `Result` |
| `.mapError(fn)` | method | Transform error; pass ok through. An exception thrown by `fn` is caught and becomes an error `Result` |

`OKResult`/`ErrorResult` are also exported directly — the concrete subtypes behind `Result` —
but callers normally construct through `Result.ok`/`Result.error`.

### Example

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
