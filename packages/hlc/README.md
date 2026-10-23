# @sozai/hlc

Dependency-free hybrid logical clock with sortable timestamps.

## Installation

```sh
pnpm add @sozai/hlc
```

## Usage

```ts
import { HLC, type HLCTimestamp } from '@sozai/hlc'

const clock = new HLC({ nodeID: 'did:key:local' })
const local: HLCTimestamp = clock.now()
const encoded = HLC.serialize(local)
const remote = HLC.tryParse(encoded)
if (remote !== null) {
  clock.receive(remote)
}
```

`now()` mints a timestamp. `receive()` advances the clock past a remote timestamp and returns its updated timestamp.
`HLC.compare(a, b)` orders timestamps by wall time, then counter, then node ID.
The optional `beforeMint` hook runs before each `now()` call. Throwing vetoes that mint without changing clock state.
It does not gate `receive()`.

## Stack ordering format

The stack's serialised ordering format is ASCII only:

```text
<ISO wall time>:<zero-padded counter>:<nodeID>
2025-02-14T14:50:00.000Z:00000042:did:key:z6Mk123
```

`HLC.serialize()` uses `new Date(wallTime).toISOString()`, followed by a colon, an eight-digit decimal counter, another colon, and the node ID.
The counter is fixed-width and zero-padded, so lexicographic order equals numeric order.
The production clock emits counters from `00000000` through `99999999`.
At the ceiling of `100000000`, it advances wall time by one millisecond and resets the counter to zero.
The optional `counterCeiling` test seam can lower that ceiling.

For canonical timestamps with four-digit ISO years and ASCII node IDs, byte-wise lexicographic order equals the clock's causal ordering.
Concurrent events use node ID as a deterministic tie-breaker. A later timestamp alone does not prove a causal relationship.
Use byte-wise comparison rather than locale-sensitive collation.

Callers must supply ASCII node IDs. The implementation appends node IDs verbatim and does not enforce ASCII.
Node IDs may contain colons, as the example shows.
`serialize()` pads counters but does not validate arbitrary timestamp objects or truncate counters wider than eight digits.

`HLC.parse()` splits after the first `Z`, parses the counter before the next colon, and preserves the remaining node ID.
`HLC.tryParse()` returns `null` for non-finite wall times or counters, or an empty node ID.
It does not enforce canonical ISO spelling, counter width, counter range, or ASCII.
