import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@opentelemetry/api'
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { LogRecord } from '@sozai/log'
import { getSozaiLogger, reset, setup } from '@sozai/log'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createFlowGraph, FlowRetryableError } from '../src/index.js'

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
const storage = new AsyncLocalStorage<Context>()
const manager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with<A extends Array<unknown>, F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return storage.run(ctx, () => fn.apply(thisArg, args))
  },
  bind: <T>(_ctx: Context, target: T) => target,
  enable() {
    return this
  },
  disable() {
    return this
  },
}
beforeAll(() => {
  expect(context.setGlobalContextManager(manager)).toBe(true)
  expect(trace.setGlobalTracerProvider(provider)).toBe(true)
})
afterAll(() => {
  trace.disable()
  context.disable()
})

test('spans form a parented tree and resume links to origin without payloads', async () => {
  exporter.reset()
  const host = provider.getTracer('host').startSpan('host')
  const definition = {
    id: 'trace',
    name: 'Trace',
    version: 1,
    start: 'ask',
    nodes: {
      ask: { kind: 'input', prompt: { value: 'secret prompt' }, next: 'done' },
      done: { kind: 'end' },
    },
  }
  const graph = createFlowGraph()
  const first = await context.with(trace.setSpan(context.active(), host), () =>
    graph.run({ definition, input: 'secret input' }),
  )
  host.end()
  expect(first.status).toBe('suspended')
  expect(first.runState.origin?.traceparent).toBeTruthy()
  const resumed = graph.resume({
    definition,
    runState: first.runState,
    event: { type: 'value', value: 'secret answer' },
  })
  for await (const _state of resumed) {
    /* drain */
  }
  const spans = exporter.getFinishedSpans()
  const firstSegment = spans.find(
    (span) => span.name === 'flow.segment' && span.attributes['flow.segment.kind'] === 'start',
  )
  const secondSegment = spans.find(
    (span) => span.name === 'flow.segment' && span.attributes['flow.segment.kind'] === 'resume',
  )
  expect(firstSegment?.parentSpanContext?.spanId).toBe(host.spanContext().spanId)
  expect(secondSegment?.links[0]?.context.spanId).toBe(firstSegment?.spanContext().spanId)
  expect(secondSegment?.links[0]?.context.traceId).toBe(firstSegment?.spanContext().traceId)
  expect(secondSegment?.links[0]?.context.isRemote).toBe(true)
  const nodes = spans.filter((span) => span.name === 'flow.node')
  expect(nodes).toHaveLength(3)
  expect(nodes.map((span) => span.parentSpanContext?.spanId)).toEqual([
    firstSegment?.spanContext().spanId,
    secondSegment?.spanContext().spanId,
    secondSegment?.spanContext().spanId,
  ])
  expect(firstSegment?.attributes).toMatchObject({
    'flow.id': 'trace',
    'flow.version': 1,
    'flow.segment.kind': 'start',
    'flow.status': 'suspended',
    'flow.steps': 1,
  })
  expect(nodes.map((span) => span.attributes['flow.node.kind'])).toEqual(['input', 'input', 'end'])
  expect(spans.every((span) => span.events.every((event) => event.name !== 'exception'))).toBe(true)
  expect(
    JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    ),
  ).not.toContain('secret')
})

test('retry span records a safe event without exception text', async () => {
  exporter.reset()
  let count = 0
  const graph = createFlowGraph({
    actions: {
      work: async () => {
        count++
        if (count === 1) throw new FlowRetryableError({ message: 'secret backend' })
        return 1
      },
    },
  })
  await graph.run({
    definition: {
      id: 'retry',
      name: 'Retry',
      version: 1,
      start: 'a',
      nodes: {
        a: { kind: 'action', name: 'work', next: 'end', retry: { maxAttempts: 2 } },
        end: { kind: 'end' },
      },
    },
  })
  const spans = exporter.getFinishedSpans()
  expect(
    spans.some(
      (span) =>
        span.name === 'flow.node' && span.events.some((event) => event.name === 'flow.retry'),
    ),
  ).toBe(true)
  expect(
    JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    ),
  ).not.toContain('secret backend')
})

test('an action creates host spans beneath its node span', async () => {
  exporter.reset()
  const graph = createFlowGraph({
    actions: {
      work: async () => {
        const span = provider.getTracer('host').startSpan('host.action')
        span.end()
        return 1
      },
    },
  })
  await graph.run({
    definition: {
      id: 'nested',
      name: 'Nested',
      version: 1,
      start: 'work',
      nodes: { work: { kind: 'action', name: 'work', next: 'end' }, end: { kind: 'end' } },
    },
  })
  const spans = exporter.getFinishedSpans()
  const action = spans.find(
    (span) => span.name === 'flow.node' && span.attributes['flow.node.kind'] === 'action',
  )
  const host = spans.find((span) => span.name === 'host.action')
  expect(host?.parentSpanContext?.spanId).toBe(action?.spanContext().spanId)
  expect(action?.attributes['flow.action.name']).toBe('work')
})

test('configured logging emits one record per retry and terminal failure with trace IDs', async () => {
  const records: Array<LogRecord> = []
  setup({
    sinks: {
      memory: (record: LogRecord) => {
        records.push(record)
      },
    },
    loggers: [
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
      { category: ['sozai'], lowestLevel: 'debug', sinks: ['memory'] },
    ],
  })
  try {
    const graph = createFlowGraph({
      logger: getSozaiLogger('flow-graph'),
      actions: {
        work: async () => {
          throw new FlowRetryableError({ message: 'backend private' })
        },
      },
    })
    const result = await graph.run({
      definition: {
        id: 'log',
        name: 'Log',
        version: 1,
        start: 'a',
        nodes: {
          a: { kind: 'action', name: 'work', next: 'end', retry: { maxAttempts: 2 } },
          end: { kind: 'end' },
        },
      },
    })
    expect(result.status).toBe('error')
    expect(records.map((record) => record.level)).toEqual(['warning', 'error'])
    expect(records.every((record) => typeof record.properties.traceID === 'string')).toBe(true)
    expect(
      records.every((record) =>
        Object.values(record.properties).every((value) => !(value instanceof Error)),
      ),
    ).toBe(true)
    expect(
      JSON.stringify(
        records.map((record) => ({ message: record.rawMessage, properties: record.properties })),
      ),
    ).not.toContain('backend private')
  } finally {
    reset()
  }
})

test('handled node failure emits one safe warning in the active node span', async () => {
  exporter.reset()
  const records: Array<LogRecord> = []
  setup({
    sinks: {
      memory: (record: LogRecord) => {
        records.push(record)
      },
    },
    loggers: [
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
      { category: ['sozai'], lowestLevel: 'debug', sinks: ['memory'] },
    ],
  })
  try {
    const result = await createFlowGraph({
      actions: {
        work: async () => {
          throw new Error('sensitive failure')
        },
      },
    }).run({
      definition: {
        id: 'handled',
        name: 'Handled',
        version: 1,
        start: 'work',
        nodes: {
          work: { kind: 'action', name: 'work', next: 'end', onError: 'end' },
          end: { kind: 'end' },
        },
      },
    })
    expect(result.status).toBe('ended')
    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe('warning')
    expect(records[0]?.properties.traceID).toBeTruthy()
    expect(records[0]?.properties.spanID).toBeTruthy()
    const handled = exporter
      .getFinishedSpans()
      .find((span) => span.events.some((event) => event.name === 'flow.error.handled'))
    expect(handled?.spanContext().spanId).toBe(records[0]?.properties.spanID)
    expect(
      Object.values(records[0]?.properties ?? {}).every((value) => !(value instanceof Error)),
    ).toBe(true)
    expect(JSON.stringify(records[0]?.properties)).not.toContain('sensitive failure')
  } finally {
    reset()
  }
})

test('definition, version and state validation each log once', async () => {
  const records: Array<LogRecord> = []
  setup({
    sinks: {
      memory: (record: LogRecord) => {
        records.push(record)
      },
    },
    loggers: [
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
      { category: ['sozai'], lowestLevel: 'debug', sinks: ['memory'] },
    ],
  })
  try {
    const graph = createFlowGraph()
    const definition = {
      id: 'validate',
      name: 'Validate',
      version: 1,
      start: 'ask',
      nodes: { ask: { kind: 'input', next: 'end' }, end: { kind: 'end' } },
    }
    expect(() => graph.start({ definition: { ...definition, version: Number.NaN } })).toThrow()
    const first = await graph.run({ definition })
    expect(() =>
      graph.resume({
        definition: { ...definition, version: 2 },
        runState: first.runState,
        event: { type: 'value', value: 1 },
      }),
    ).toThrow()
    expect(() =>
      graph.resume({
        definition,
        runState: { ...first.runState, pending: undefined },
        event: { type: 'value', value: 1 },
      }),
    ).toThrow()
    expect(records.map((record) => record.properties.code)).toEqual([
      'invalid_definition',
      'version_mismatch',
      'invalid_state',
    ])
    expect(records.every((record) => record.level === 'error')).toBe(true)
    expect(
      records.every((record) =>
        Object.values(record.properties).every((value) => !(value instanceof Error)),
      ),
    ).toBe(true)
  } finally {
    reset()
  }
})

test('segment span ends when a single next call yields suspension', async () => {
  exporter.reset()
  const graph = createFlowGraph()
  const run = graph.start({
    definition: {
      id: 'single',
      name: 'Single',
      version: 1,
      start: 'ask',
      nodes: { ask: { kind: 'input', next: 'end' }, end: { kind: 'end' } },
    },
  })
  const commit = await run.next()
  expect(commit.value.status).toBe('suspended')
  expect(exporter.getFinishedSpans().filter((span) => span.name === 'flow.segment')).toHaveLength(1)
})

test('an unhandled failure marks the exported segment as an error', async () => {
  exporter.reset()
  const graph = createFlowGraph({
    actions: {
      fail: async () => {
        throw new Error('private')
      },
    },
  })
  const result = await graph.run({
    definition: {
      id: 'error',
      name: 'Error',
      version: 1,
      start: 'a',
      nodes: { a: { kind: 'action', name: 'fail', next: 'end' }, end: { kind: 'end' } },
    },
  })
  expect(result.status).toBe('error')
  const segment = exporter.getFinishedSpans().find((span) => span.name === 'flow.segment')
  expect(segment?.status.code).toBe(SpanStatusCode.ERROR)
  expect(segment?.attributes['flow.error.code']).toBe('node_failed')
})

test('recorded handled and retried failures leave node spans without error status', async () => {
  exporter.reset()
  let attempts = 0
  const graph = createFlowGraph({
    recordErrorMessages: true,
    actions: {
      work: async () => {
        attempts++
        if (attempts === 1) throw new FlowRetryableError({ message: 'retry' })
        throw new Error('handled')
      },
    },
  })
  const result = await graph.run({
    definition: {
      id: 'handled-retry',
      name: 'Handled retry',
      version: 1,
      start: 'work',
      nodes: {
        work: {
          kind: 'action',
          name: 'work',
          next: 'end',
          onError: 'end',
          retry: { maxAttempts: 2 },
        },
        end: { kind: 'end' },
      },
    },
  })
  expect(result.status).toBe('ended')
  expect(
    exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'flow.node')
      .map((span) => span.status.code),
  ).not.toContain(SpanStatusCode.ERROR)
})
