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
import { createValidatorCache } from '@sozai/schema'
import { afterAll, beforeAll, expect, test } from 'vitest'

import {
  createFlowGraph,
  createMapResolver,
  defineNodeKind,
  FlowGraphValidatorsError,
  FlowRetryableError,
} from '../src/index.js'

const exporter = new InMemorySpanExporter()

const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })

const storage = new AsyncLocalStorage<Context>()

const manager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with<
    Arguments extends Array<unknown>,
    Callback extends (...args: Arguments) => ReturnType<Callback>,
  >(
    ctx: Context,
    fn: Callback,
    thisArg?: ThisParameterType<Callback>,
    ...args: Arguments
  ): ReturnType<Callback> {
    return storage.run(ctx, () => fn.apply(thisArg, args))
  },
  bind: <Target>(_ctx: Context, target: Target) => target,
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

  const graph = createFlowGraph({ resolver: createMapResolver([definition]) })

  const first = await context.with(trace.setSpan(context.active(), host), () =>
    graph.run({ definition, input: 'secret input' }),
  )

  host.end()

  expect(first.status).toBe('suspended')
  expect(first.runState.origin?.traceparent).toBeTruthy()

  const resumed = graph.resume({
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

        if (count === 1) {
          throw new FlowRetryableError({ message: 'secret backend' })
        }

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
    const definition = {
      id: 'validate',
      name: 'Validate',
      version: 1,
      start: 'ask',
      nodes: { ask: { kind: 'input', next: 'end' }, end: { kind: 'end' } },
    }

    const graph = createFlowGraph({
      resolver: { resolve: () => ({ ...definition, name: 'Edited' }) },
    })

    expect(() => graph.start({ definition: { ...definition, version: Number.NaN } })).toThrow()

    const first = await graph.run({ definition })

    await expect(
      graph.resume({ runState: first.runState, event: { type: 'value', value: 1 } }).next(),
    ).rejects.toThrow()
    expect(() =>
      graph.resume({
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

        if (attempts === 1) {
          throw new FlowRetryableError({ message: 'retry' })
        }

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

test('node spans carry flow.id and flow.depth', async () => {
  exporter.reset()

  const callee = {
    id: 'callee',
    name: 'Callee',
    version: 1,
    start: 'work',
    nodes: { work: { kind: 'action', name: 'work', next: 'done' }, done: { kind: 'end' } },
  }

  const caller = {
    id: 'caller',
    name: 'Caller',
    version: 1,
    start: 'c',
    nodes: { c: { kind: 'call', flow: 'callee', next: 'done' }, done: { kind: 'end' } },
  }

  const result = await createFlowGraph({
    resolver: createMapResolver([callee]),
    actions: { work: () => 1 },
  }).run({ definition: caller })

  expect(result.status).toBe('ended')

  const nodes = exporter
    .getFinishedSpans()
    .filter((span) => span.name === 'flow.node')
    .map((span) => [
      span.attributes['flow.node.id'],
      span.attributes['flow.id'],
      span.attributes['flow.depth'],
    ])

  expect(nodes).toEqual([
    ['c', 'caller', 0],
    ['work', 'callee', 1],
    ['done', 'callee', 1],
    ['done', 'caller', 0],
  ])
})

test('a root goto repins the segment span flow attributes', async () => {
  exporter.reset()

  const target = {
    id: 'target',
    name: 'Target',
    version: 2,
    start: 'done',
    nodes: { done: { kind: 'end' } },
  }

  const origin = {
    id: 'origin',
    name: 'Origin',
    version: 1,
    start: 'g',
    nodes: { g: { kind: 'goto', flow: 'target' } },
  }

  const result = await createFlowGraph({ resolver: createMapResolver([target]) }).run({
    definition: origin,
  })

  expect(result.status).toBe('ended')

  const spans = exporter.getFinishedSpans()
  const segment = spans.find((span) => span.name === 'flow.segment')

  expect(segment?.attributes).toMatchObject({ 'flow.id': 'target', 'flow.version': 2 })
  expect(
    spans
      .filter((span) => span.name === 'flow.node')
      .map((span) => [span.attributes['flow.node.id'], span.attributes['flow.id']]),
  ).toEqual([
    ['g', 'origin'],
    ['done', 'target'],
  ])
})

test('failure log records carry the flow.id of the frame that owns the logged node', async () => {
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

  const callee = {
    id: 'callee',
    name: 'Callee',
    version: 1,
    start: 'work',
    nodes: { work: { kind: 'action', name: 'work', next: 'done' }, done: { kind: 'end' } },
  }

  const caller = (onError?: string) => ({
    id: 'caller',
    name: 'Caller',
    version: 1,
    start: 'c',
    nodes: {
      c: { kind: 'call', flow: 'callee', next: 'done', ...(onError ? { onError } : {}) },
      done: { kind: 'end' },
    },
  })

  try {
    const graph = createFlowGraph({
      logger: getSozaiLogger('flow-graph'),
      resolver: createMapResolver([callee]),
      actions: {
        work: async () => {
          throw new Error('private')
        },
      },
    })

    const handled = await graph.run({ definition: caller('done') })

    expect(handled.status).toBe('ended')
    expect(records.map((record) => [record.level, record.properties['flow.id']])).toEqual([
      ['warning', 'caller'],
    ])

    records.length = 0

    const failed = await graph.run({ definition: caller() })

    expect(failed.status).toBe('error')
    expect(records.map((record) => [record.level, record.properties['flow.id']])).toEqual([
      ['error', 'callee'],
    ])
  } finally {
    reset()
  }
})

const askDefinition = {
  id: 'ask',
  name: 'Ask',
  version: 1,
  start: 'ask',
  nodes: { ask: { kind: 'input', next: 'done' }, done: { kind: 'end' } },
}

async function suspendedAsk() {
  const first = await createFlowGraph().run({ definition: askDefinition })

  expect(first.status).toBe('suspended')

  return JSON.parse(JSON.stringify(first.runState))
}

const resumeSegments = () =>
  exporter
    .getFinishedSpans()
    .filter(
      (span) => span.name === 'flow.segment' && span.attributes['flow.segment.kind'] === 'resume',
    )

test('a failed prepare keeps the segment open; return() ends it as ERROR with error.type', async () => {
  const runState = await suspendedAsk()

  exporter.reset()

  const run = createFlowGraph({ resolver: createMapResolver([]) }).resume({
    runState,
    event: { type: 'value', value: 1 },
  })

  await expect(run.next()).rejects.toThrow()
  expect(resumeSegments()).toHaveLength(0)

  const closed = await run.return()

  expect(closed).toEqual({ done: true, value: runState })

  const [segment] = resumeSegments()

  expect(resumeSegments()).toHaveLength(1)
  expect(segment?.status.code).toBe(SpanStatusCode.ERROR)
  expect(segment?.attributes['error.type']).toBe('FlowReferenceError')
  // Like node spans, the exception itself is recorded only with recordErrorMessages.
  expect(segment?.events).toEqual([])
  expect(run.getState()).toEqual(runState)
})

test('with recordErrorMessages a failed prepare records the exception on the segment', async () => {
  const runState = await suspendedAsk()

  exporter.reset()

  const run = createFlowGraph({
    resolver: createMapResolver([]),
    recordErrorMessages: true,
  }).resume({ runState, event: { type: 'value', value: 1 } })

  await expect(run.next()).rejects.toThrow()
  await run.return()

  const [segment] = resumeSegments()

  expect(segment?.status.code).toBe(SpanStatusCode.ERROR)
  expect(segment?.events.map((event) => event.name)).toEqual(['exception'])
  expect(segment?.events[0]?.attributes?.['exception.type']).toBe('FlowReferenceError')
})

test('graph.run() ends the segment as ERROR when the start preflight rejects', async () => {
  exporter.reset()

  const graph = createFlowGraph({ resolver: createMapResolver([]) })

  await expect(
    graph.run({
      definition: {
        id: 'caller',
        name: 'Caller',
        version: 1,
        start: 'c',
        nodes: {
          c: { kind: 'call', flow: 'gone', version: 1, next: 'done' },
          done: { kind: 'end' },
        },
      },
    }),
  ).rejects.toThrow()

  const segments = exporter.getFinishedSpans().filter((span) => span.name === 'flow.segment')

  expect(segments).toHaveLength(1)
  expect(segments[0]?.status.code).toBe(SpanStatusCode.ERROR)
  expect(segments[0]?.attributes['error.type']).toBe('FlowDefinitionError')
})

test('a later successful prepare clears the prepare failure', async () => {
  const runState = await suspendedAsk()
  let calls = 0

  exporter.reset()

  const run = createFlowGraph({
    resolver: {
      resolve: async (id, version) => {
        calls++

        if (calls === 1) {
          throw new Error('transient')
        }

        return createMapResolver([askDefinition]).resolve(id, version)
      },
    },
  }).resume({ runState, event: { type: 'value', value: 1 } })

  await expect(run.next()).rejects.toThrow('transient')

  const commit = await run.next()

  expect(commit.done).toBe(false)

  await run.return()

  const [segment] = resumeSegments()

  expect(segment?.status.code).not.toBe(SpanStatusCode.ERROR)
  expect(segment?.attributes['error.type']).toBeUndefined()
  expect(segment?.events).toEqual([])
})

test('return() on a fresh run ends the segment without committing', async () => {
  exporter.reset()

  const run = createFlowGraph().start({ definition: askDefinition, runID: 'fresh' })
  const initial = run.getState()

  const closed = await run.return()

  expect(closed).toEqual({ done: true, value: initial })
  expect(run.getState()).toEqual(initial)
  expect(run.getState().revision).toBe(0)

  const segments = exporter.getFinishedSpans().filter((span) => span.name === 'flow.segment')

  expect(segments).toHaveLength(1)
  expect(segments[0]?.status.code).not.toBe(SpanStatusCode.ERROR)

  expect(await run.next()).toEqual({ done: true, value: initial })
  expect(await run.return()).toEqual({ done: true, value: initial })
  expect(exporter.getFinishedSpans().filter((span) => span.name === 'flow.segment')).toHaveLength(1)
})

test('return() after completion is idempotent and next() stays done', async () => {
  exporter.reset()

  const run = createFlowGraph().start({ definition: askDefinition })
  const commit = await run.next()

  expect(commit.value.status).toBe('suspended')
  expect(await run.return()).toEqual({ done: true, value: commit.value })
  expect(await run.next()).toEqual({ done: true, value: commit.value })
  expect(exporter.getFinishedSpans().filter((span) => span.name === 'flow.segment')).toHaveLength(1)
})

test('return() while next() is pending rejects', async () => {
  const run = createFlowGraph().start({ definition: askDefinition })
  const pending = run.next()

  await expect(run.return()).rejects.toThrow('FlowRun.return() called concurrently')
  expect((await pending).value.status).toBe('suspended')
})

test('a disposed validator cache mid-run closes the node span and can be recovered', async () => {
  exporter.reset()

  type Step = { kind: 'step'; next: string }

  let host = createValidatorCache()
  let calls = 0

  const step = defineNodeKind<Step>({
    kind: 'step',
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      additionalProperties: false,
      properties: { kind: { const: 'step' }, next: { type: 'string' } },
    },
    targets: (node) => [{ path: ['next'], id: node.next }],
    execute: (node) => {
      calls++

      if (calls === 1) {
        host.dispose()

        return { suspend: { schema: { type: 'string' } } }
      }

      return { next: node.next }
    },
    resume: (node) => ({ next: node.next }),
  })

  const definition = {
    id: 'disposed',
    name: 'Disposed',
    version: 1,
    start: 'a',
    nodes: { a: { kind: 'step', next: 'end' }, end: { kind: 'end' } },
  }
  const resolver = createMapResolver([definition])

  const run = createFlowGraph({ validators: host, kinds: [step], resolver }).start({ definition })

  await expect(
    (async () => {
      for await (const _state of run) {
        /* drain */
      }
    })(),
  ).rejects.toThrow(FlowGraphValidatorsError)

  const state = run.getState()

  expect(state.status).toBe('running')

  const spans = exporter.getFinishedSpans()
  const node = spans.find(
    (span) => span.name === 'flow.node' && span.attributes['flow.node.kind'] === 'step',
  )
  const segment = spans.find((span) => span.name === 'flow.segment')

  expect(node?.status.code).toBe(SpanStatusCode.ERROR)
  expect(node?.attributes['error.type']).toBe('FlowGraphValidatorsError')
  expect(segment?.status.code).toBe(SpanStatusCode.ERROR)
  expect(segment?.attributes['error.type']).toBe('FlowGraphValidatorsError')
  expect(segment?.attributes['flow.status']).toBe('running')

  host = createValidatorCache()

  const recovered = createFlowGraph({ validators: host, kinds: [step], resolver }).recover({
    runState: JSON.parse(JSON.stringify(state)),
  })

  for await (const _state of recovered) {
    /* drain */
  }

  expect(recovered.getState().status).toBe('ended')
})

test.each([
  { value: null, type: 'null' },
  { value: 42, type: 'number' },
  { value: true, type: 'boolean' },
  { value: [], type: 'array' },
  { value: {}, type: 'object' },
])('invalid end outcome reports the resolved $type type', async ({ value, type }) => {
  exporter.reset()

  const graph = createFlowGraph({ recordErrorMessages: true })
  const result = await graph.run({
    definition: {
      id: 'invalid-outcome',
      name: 'Invalid outcome',
      version: 1,
      start: 'done',
      nodes: { done: { kind: 'end', outcome: { ref: ['input', 'outcome'] } } },
    },
    input: { outcome: value },
  })

  expect(result.status).toBe('error')

  const node = exporter.getFinishedSpans().find((span) => span.name === 'flow.node')
  const exception = node?.events.find((event) => event.name === 'exception')

  expect(exception?.attributes?.['exception.type']).toBe('invalid_value')
  expect(exception?.attributes?.['exception.message']).toBe(
    `End outcome must resolve to a string; received ${type}.`,
  )
})
