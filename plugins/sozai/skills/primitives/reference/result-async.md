# @sozai/result — AsyncResult

Sibling references: `reference/result.md` (Result), `reference/result-option.md` (Option).

`AsyncResult<V, E>` wraps an async computation with `Result` semantics. It implements
`PromiseLike<Result<V, E>>` and can be `await`-ed directly.

### Exports

| Export | Kind | Description |
|---|---|---|
| `AsyncResult` | class | Async result wrapper (`PromiseLike<Result<V, E>>`) |
| `AsyncResult.all(values)` | static | Settle all iterables in parallel; returns `AsyncResult<Array<Result<V, E>>, never>` |
| `AsyncResult.ok(value)` | static | Resolved ok |
| `AsyncResult.error(error)` | static | Resolved error |
| `AsyncResult.resolve(value)` | static | Wrap a `Promise` or plain value; catches rejections |
| `AsyncResult.is(value)` | static | Type guard |
| `AsyncResult.from(value)` | static | Coerce unknown — an existing `AsyncResult` passes through, an `Error` becomes `error`, anything else goes through `.resolve` |
| `.value` | getter | `Promise<V>` — rejects if error |
| `.optional` | getter | `Promise<Option<V>>` |
| `.orNull` | getter | `Promise<V \| null>` |
| `.or(defaultValue)` | method | `Promise<V>` — fallback on error |
| `.map(fn)` | method | Transform ok value asynchronously; returns a new `AsyncResult`. Both a thrown exception and a rejected promise from `fn` become an error result |
| `.mapError(fn)` | method | Transform error asynchronously; pass ok through. `fn` may itself return a `Result`, a promise of one, or an `AsyncResult` |
| `.then(onfulfilled, onrejected)` | method | `PromiseLike` — enables `await` |

### Example

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
const scores = batch.value // awaiting AsyncResult.all yields a sync Result — .value is synchronous
// scores: Array<Result<number>>
for (const s of scores) {
  console.log(s.orNull)
}
```
