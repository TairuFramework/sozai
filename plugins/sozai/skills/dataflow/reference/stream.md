# @sozai/stream

Web Streams utilities for building composable data pipelines.

## Exports

| Export | Kind | Description |
|---|---|---|
| `createReadable` | function | Create a `ReadableStream` and its `ReadableStreamDefaultController` |
| `createPipe` | function | Create a `ReadableWritablePair` that queues written values until read; accepts `{ highWaterMark }` to bound buffering |
| `createConnection` | function | Create a pair of `ReadableWritablePair`s connected to each other, one per direction |
| `writeTo` | function | Build a `WritableStream` from `write`/`close`/`abort` sink callbacks |
| `createArraySink` | function | Collect all stream chunks into an array; returns `[WritableStream, Promise<Array<T>>]` |
| `transform` | function | Create a `TransformStream` from a transform function |
| `map` | function | Synchronous value-mapping transform |
| `mapAsync` | function | Async value-mapping transform |
| `tap` | function | Side-effect transform (inspect without changing values) |
| `toJSONLines` | function | Encode objects as newline-delimited JSON (NDJSON) |
| `fromJSONLines` | function | Decode newline-delimited JSON chunks into typed objects |
| `JSONLinesError` | class | Thrown when NDJSON framing exceeds a configured size limit, or a value can't be stringified for encoding — decode failures instead go through `onInvalidJSON` (default: a console warning, not a throw) |

## Example: transformation pipeline

```typescript
import { createReadable, createArraySink, tap, map, mapAsync } from '@sozai/stream'

const [source, controller] = createReadable<number>()
const [sink, result] = createArraySink<string>()

source
  .pipeThrough(tap((n) => console.log('input:', n)))
  .pipeThrough(map((n) => n * 2))
  .pipeThrough(mapAsync(async (n) => `Value: ${n}`))
  .pipeTo(sink)

controller.enqueue(1)
controller.enqueue(2)
controller.enqueue(3)
controller.close()

// result resolves to ['Value: 2', 'Value: 4', 'Value: 6']
```

## Example: JSON Lines (NDJSON)

```typescript
import { createReadable, createArraySink, toJSONLines, fromJSONLines } from '@sozai/stream'

type Message = { id: number; text: string }

// Encode objects to NDJSON
const [source, controller] = createReadable<Message>()
const [sink, encoded] = createArraySink<string>()
source.pipeThrough(toJSONLines()).pipeTo(sink)

controller.enqueue({ id: 1, text: 'Hello' })
controller.enqueue({ id: 2, text: 'World' })
controller.close()
// encoded resolves to ['{"id":1,"text":"Hello"}\n', '{"id":2,"text":"World"}\n']

// Decode NDJSON back to objects
const [jsonSource, jsonController] = createReadable<string>()
const [objectSink, decoded] = createArraySink<Message>()
jsonSource.pipeThrough(fromJSONLines<Message>()).pipeTo(objectSink)

jsonController.enqueue('{"id":1,"text":"Hello"}\n{"id":2,"text":"World"}\n')
jsonController.close()
// decoded resolves to [{ id: 1, text: 'Hello' }, { id: 2, text: 'World' }]
```
