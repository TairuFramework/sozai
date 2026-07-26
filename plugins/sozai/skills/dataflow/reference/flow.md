# @sozai/flow

Async-generator state machine. Define typed handler functions and iterate through state transitions.

## Exports

| Export | Kind | Description |
|---|---|---|
| `createFlow` | function | Create a flow factory from a handlers record |
| `createGenerator` | function | Lower-level: create an async generator from an initial action and handlers |
| `FlowGenerator` | type | The async generator returned by a flow factory; also exposes `.events` (an `EventEmitter` of handler-emitted events) and `.getState()` (a frozen snapshot of the current state) |
| `FlowAction` | type | `{ name: string; params?: unknown }` — an action to dispatch |
| `Handler` | type | `(ctx) => GeneratorValue<S> \| Promise<GeneratorValue<S>>` |
| `HandlersRecord` | type | Map of action name → `Handler` |
| `HandlerExecutionContext` | type | `{ state: S; params: P; emit; signal? }` passed to each handler — `emit` fires flow events, `signal` reflects the flow's and the current step's abort state |
| `GeneratorValue` | type | A non-terminal value yielded by the flow |
| `GeneratorDoneValue` | type | The terminal value yielded when `status: 'end'` (or `'aborted'` / `'error'`) |
| `MissingHandlerError` | class | Thrown when an action name has no registered handler |

Each handler returns `{ status: 'state' | 'action' | 'end', state, action?, params? }`. The
generator implements `AsyncDisposable`, so `await using` also works for cleanup.

## Example: state machine with `createFlow`

```typescript
import { createFlow } from '@sozai/flow'
import type { HandlerExecutionContext, HandlersRecord } from '@sozai/flow'

type AppState = { count: number; status: 'idle' | 'processing' | 'complete' }
type IncrementParams = { amount: number }

const handlers = {
  increment: ({ state, params }: HandlerExecutionContext<AppState, IncrementParams>) => {
    const newCount = state.count + params.amount
    if (newCount >= 10) {
      return {
        status: 'action' as const,
        state: { ...state, count: newCount, status: 'processing' as const },
        action: 'complete',
        params: { final: true },
      }
    }
    return { status: 'state' as const, state: { ...state, count: newCount } }
  },
  complete: ({ state }: HandlerExecutionContext<AppState, { final: boolean }>) => ({
    status: 'end' as const,
    state: { ...state, status: 'complete' as const },
  }),
} satisfies HandlersRecord<AppState>

// The explicit type arguments are needed here: TS can't infer `AppState` from a
// handlers record alone when each handler's context type is spelled out inline.
const generateFlow = createFlow<AppState, typeof handlers>({ handlers })

const flow = generateFlow({
  state: { count: 0, status: 'idle' },
  action: { name: 'increment', params: { amount: 5 } },
})

for await (const value of flow) {
  if (value.status === 'state') {
    // dispatch next action
    await flow.next({ action: { name: 'increment', params: { amount: 6 } } })
  }
}
// terminal value: { status: 'end', state: { count: 11, status: 'complete' } }
```
