---
name: dataflow
description: Use when working with Web Streams, async utilities, typed events, generators, state machines, or cancellable execution in sozai.
---

# Sozai dataflow

Streaming, async, events, generators, and stateful flow — Web Streams creation and
transformation, deferred promises and disposers, typed event emitters, async-generator state
machines, emitter and stream adapters, and chainable cancellable execution.

## Packages

- **@sozai/stream** — Web Streams creation, transformation, JSON Lines. → `reference/stream.md`
- **@sozai/async** — deferred promises, lazy evaluation, `Disposer`, interruptions. → `reference/async.md`
- **@sozai/event** — typed event emitter with stream bridging. → `reference/event.md`
- **@sozai/flow** — async-generator state machine. → `reference/flow.md`
- **@sozai/generator** — emitter/stream → async generator adapters. → `reference/generator.md`
- **@sozai/execution** — chainable, cancellable async execution with `Result`. → `reference/execution.md`

## Pick this when

- Building a data transformation pipeline on the Web Streams API, or encoding/decoding NDJSON →
  `@sozai/stream`
- Resolving a promise from outside its executor, running a one-time lazy async init, or wiring
  `await using` resource cleanup with structured cancellation/timeout → `@sozai/async`
- Doing type-safe pub/sub within a module, or bridging events to/from a `ReadableStream` →
  `@sozai/event`
- Modelling a multi-step state machine where each step can dispatch the next action, with typed
  state transitions → `@sozai/flow`
- Consuming an event channel or `ReadableStream` with `for await`, or driving an `AsyncIterator`
  to completion with a callback → `@sozai/generator`
- Chaining async steps with structured `Result` handling, a single abort/cancel/timeout control
  across the sequence, and introspection of which interruption fired → `@sozai/execution`

## Related

- `/sozai:primitives` — `@sozai/execution` returns `Result`.
- `/sozai:validation` — `@sozai/flow` builds on `@sozai/schema`.
- `/sozai:observability` — `@sozai/event` depends on `@sozai/log`.
