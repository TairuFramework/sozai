---
name: discover
description: Use when exploring sozai capabilities - progressive discovery of this repo's domain skills.
---

# Sozai capability discovery

Sozai (素材 — "raw material") is the core-utilities layer of the stack: stable,
environment-agnostic packages that everything else depends on downward. One exception,
`@sozai/lock`, is filesystem-based. 15 packages across 5 domains.

## By domain

- **Dataflow** — streaming, async, events, generators, stateful flow. Web Streams creation and
  transformation, deferred promises and disposers, typed event emitters, async-generator state
  machines, emitter and stream adapters, chainable cancellable execution. → `/sozai:dataflow`
- **Validation** — JSON Schema with compile-time type generation (`FromSchema`), plus message
  encoding and decoding. → `/sozai:validation`
- **Runtime** — environment-agnostic `fetch` and randomness via `createRuntime`, the Expo /
  React Native binding, and a filesystem-based cross-process mutex. → `/sozai:runtime`
- **Observability** — LogTape-based namespaced loggers, and OpenTelemetry tracing with W3C
  context propagation and baggage. → `/sozai:observability`
- **Primitives** — `Option`, `Result`, and `AsyncResult` for explicit success and failure, plus
  JSON-patch diff and apply. → `/sozai:primitives`

## By use case

- **Moving framed data over a transport** — `@sozai/stream` for JSON Lines framing, `@sozai/codec`
  for the payload. `/sozai:dataflow` + `/sozai:validation`.
- **Making failure explicit instead of thrown** — `Result` from `@sozai/result`, produced by
  `@sozai/execution` chains. `/sozai:primitives` + `/sozai:dataflow`.
- **Instrumenting a request path** — `@sozai/otel` for the span, `@sozai/log` for the record,
  the bridge to correlate them. `/sozai:observability`.
- **Writing library code portable across Node, browsers, and workers** — `@sozai/runtime`'s
  `createRuntime` for `fetch` and randomness. `/sozai:runtime`.
- **Targeting Expo or React Native specifically** — `@sozai/runtime-expo`'s `polyfill()` for the
  `crypto` shim, layered on `@sozai/runtime`'s `Runtime` shape. `/sozai:runtime`.
- **Serialising work across processes** — `@sozai/lock`, semantics file first. `/sozai:runtime`.

## Packages

**Dataflow** — `@sozai/stream`, `@sozai/async`, `@sozai/event`, `@sozai/flow`,
`@sozai/generator`, `@sozai/execution`

**Validation** — `@sozai/schema`, `@sozai/codec`

**Runtime** — `@sozai/runtime`, `@sozai/runtime-expo`, `@sozai/lock`

**Observability** — `@sozai/log`, `@sozai/otel`

**Primitives** — `@sozai/result`, `@sozai/patch`

## Conventions

This repo follows the shared stack conventions — see the `kigu:conventions` skill. Packages here
ossify: consumers depend on published `^` ranges, never `workspace:`, and versions move
per-package via changesets.

Sozai is the bottom of the stack and depends on no sibling repo. Consumers live upstream; the
`kigu:stack-map` skill navigates there.
