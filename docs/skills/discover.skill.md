---
name: sozai:discover
description: Explore sozai core-utility capabilities by domain
---

# Sozai Utilities Discovery

Sozai (素材 — "raw material") is the core-utilities layer of the stack: stable,
environment-agnostic packages (with one Node-only exception, `@sozai/lock`) that everything else
depends on downward. 15 packages grouped into 5 domains. Use the sections below to find the right
skill or package for your task.

## By Domain

### Dataflow

Streaming, async, events, generators, and stateful flow. Web Streams creation and
transformation, deferred promises and disposers, typed event emitters, async-generator
state machines, emitter/stream → generator adapters, and chainable cancellable execution.

→ `/sozai:dataflow`

### Validation

Schema validation and encoding. JSON Schema with compile-time type generation
(`FromSchema`), plus message encoding/decoding.

→ `/sozai:validation`

### Runtime

Platform runtime abstraction. Environment-agnostic `fetch` and randomness via
`createRuntime`, plus the Expo / React Native binding. Plus a Node-only cross-process file mutex.

→ `/sozai:runtime`

### Observability

Structured logging and tracing. LogTape-based namespaced loggers and OpenTelemetry
tracing with context propagation and baggage.

→ `/sozai:observability`

### Primitives

Typed wrappers and JSON patching. `Option`/`Result`/`AsyncResult` for explicit
success/failure, and JSON-patch diff/apply.

→ `/sozai:primitives`

## Package Overview

- **@sozai/stream** — Web Streams creation, transformation, JSON Lines framing.
- **@sozai/async** — Deferred promises, lazy evaluation, `Disposer`, interruptions.
- **@sozai/event** — Typed event emitter with stream bridging.
- **@sozai/flow** — Async-generator state machine.
- **@sozai/generator** — Emitter/stream → async-generator adapters.
- **@sozai/execution** — Chainable, cancellable async execution returning `Result`.
- **@sozai/schema** — JSON Schema validation with type generation (`Schema`, `FromSchema`).
- **@sozai/codec** — Encoding/decoding primitives.
- **@sozai/runtime** — Platform runtime abstraction (`fetch`, randomness) via `createRuntime`.
- **@sozai/runtime-expo** — Expo / React Native runtime binding.
- **@sozai/lock** — Cross-process file mutex; Node-only.
- **@sozai/log** — Structured logging (LogTape wrapper): `setup`, `getLogger`, console sink.
- **@sozai/otel** — OpenTelemetry tracing, context propagation, baggage.
- **@sozai/result** — `Option`, `Result`, `AsyncResult` typed wrappers.
- **@sozai/patch** — JSON patch: `createPatches`, `applyPatches`.
