# @sozai/execution

Chainable, cancellable async execution with structured error handling.

## Installation

```sh
pnpm add @sozai/execution
```

## Usage

```ts
import { Execution } from '@sozai/execution'

// Wrap an async operation; the signal enables cancellation
const fetchUser = new Execution(async (signal) => {
  const res = await fetch('/api/user/42', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<{ id: number; name: string }>
})

// Chain steps: run the next only when the previous succeeded
const handled = fetchUser
  .ifOK((user) => async (signal) => {
    const res = await fetch(`/api/user/${user.id}/posts`, { signal })
    return res.json() as Promise<Array<{ title: string }>>
  })
  .ifError((err) => {
    console.error('failed:', err.message)
    return null // no recovery step; propagate the error result
  })

const result = await handled.execute()
if (result.isOK()) {
  console.log('posts:', result.value)
}

// Cancellation propagates across the whole chain
handled.cancel('user navigated away')
console.log(handled.isCanceled) // true
```

Also provides `next`, `generate`, `abort`, timeout/interruption introspection, and more — see [the dataflow reference](../../docs/reference/dataflow.md) for the full API.
