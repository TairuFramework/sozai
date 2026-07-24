# @sozai/flow

Async-generator state machine execution: define typed handlers and iterate through state transitions.

## Installation

```sh
pnpm add @sozai/flow
```

## Usage

```ts
import { createFlow } from '@sozai/flow'
import type { HandlerExecutionContext } from '@sozai/flow'

type State = { count: number }

const generate = createFlow({
  handlers: {
    increment: ({ state, params }: HandlerExecutionContext<State, { amount: number }>) => {
      const count = state.count + params.amount
      return count >= 10
        ? { status: 'end' as const, state: { count } }
        : { status: 'state' as const, state: { count } }
    },
  },
})

const flow = generate({
  state: { count: 0 },
  action: { name: 'increment', params: { amount: 3 } },
})

for await (const value of flow) {
  if (value.status === 'state') {
    await flow.next({ action: { name: 'increment', params: { amount: 4 } } })
  }
}
```

Also provides `createGenerator`, `MissingHandlerError`, and the `FlowGenerator`/`FlowAction`/`Handler` types — see [the dataflow reference](../../docs/reference/dataflow.md) for the full API.
