# @sozai/stream

Web Streams creation, transformation, and JSON Lines encoding.

## Installation

```sh
pnpm add @sozai/stream
```

## Usage

```ts
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
controller.close()

// result resolves to ['Value: 2', 'Value: 4']
```

Also provides `createPipe`, `createConnection`, `writeTo`, `transform`, `toJSONLines`, `fromJSONLines`, and `JSONLinesError` — see [the dataflow reference](../../docs/reference/dataflow.md) for the full API.
