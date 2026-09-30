import { createValidatorCache, type Schema, type ValidatorCache } from '@sozai/schema'
import { describe, expect, test } from 'vitest'

import {
  createFlowGraph,
  createMapResolver,
  defineNodeKind,
  type FlowDefinition,
  FlowGraphValidatorsError,
  type NodeResult,
  type RunState,
} from '../src/index.js'
import { failedIssues } from './check-result.js'

type Step = { kind: 'step'; next: string }

const stepSchema = {
  type: 'object',
  required: ['kind', 'next'],
  additionalProperties: false,
  properties: { kind: { const: 'step' }, next: { type: 'string' } },
} as const

/** A `step` kind whose `execute` is supplied by the test; resuming moves on to `next`. */
function stepKind(execute: (node: Step) => NodeResult) {
  return defineNodeKind<Step>({
    kind: 'step',
    schema: stepSchema,
    targets: (node) => [{ path: ['next'], id: node.next }],
    resultSchema: () => ({ type: 'object', properties: { answer: { type: 'string' } } }),
    execute,
    resume: (node) => ({ next: node.next }),
  })
}

function flow(
  id: string,
  nodes: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): FlowDefinition {
  return { id, name: id, version: 1, start: 'a', nodes, ...extra } as unknown as FlowDefinition
}

const stepFlow = (id = 'steps') =>
  flow(id, { a: { kind: 'step', next: 'end' }, end: { kind: 'end' } })

const objectInput = { type: 'object', properties: { n: { type: 'number' } } }

async function drain(run: AsyncIterable<RunState>): Promise<void> {
  for await (const _state of run) {
    /* drain */
  }
}

const roundTrip = (state: RunState): RunState => JSON.parse(JSON.stringify(state))

describe('shared validator cache', () => {
  test('shared cache serves two graphs and the host', () => {
    const host = createValidatorCache()
    const a = createFlowGraph({ validators: host })
    const b = createFlowGraph({ validators: host })
    const definition = (id: string) =>
      flow(id, { a: { kind: 'end' } }, { input: structuredClone(objectInput) })

    expect(a.check(definition('a')).issues).toBeUndefined()
    expect(b.check(definition('b')).issues).toBeUndefined()
    host.get(structuredClone(objectInput) as Schema)

    expect(host.stats().compiles).toBe(1)
  })

  test('data schemas go to the host cache', async () => {
    const withInput = createValidatorCache()
    createFlowGraph({ validators: withInput }).check(
      flow('input', { a: { kind: 'end' } }, { input: objectInput }),
    )
    expect(withInput.stats().compiles).toBe(1)

    const withNode = createValidatorCache()
    createFlowGraph({ validators: withNode }).check(
      flow('node', {
        a: { kind: 'input', next: 'end', schema: { type: 'string' } },
        end: { kind: 'end' },
      }),
    )
    expect(withNode.stats().compiles).toBe(1)

    const withSuspend = createValidatorCache()
    const definition = stepFlow()
    const graph = createFlowGraph({
      validators: withSuspend,
      kinds: [stepKind(() => ({ suspend: { schema: { type: 'number' } } }))],
      resolver: createMapResolver([definition]),
    })
    const first = await graph.run({ definition })

    expect(first.status).toBe('suspended')
    expect(withSuspend.stats().compiles).toBe(1)

    const resumed = graph.resume({
      runState: roundTrip(first.runState),
      event: { type: 'value', value: 1 },
    })
    await drain(resumed)

    expect(resumed.getState().status).toBe('ended')
    expect(withSuspend.stats().compiles).toBe(1)
  })

  test('internal schemas stay private', () => {
    const host = createValidatorCache()
    const graph = createFlowGraph({
      validators: host,
      kinds: [stepKind(() => ({ next: 'end' }))],
    })

    expect(graph.check(stepFlow()).issues).toBeUndefined()
    expect(host.stats()).toEqual({ generation: 0, compiles: 0, entries: 0 })
  })

  test('host options apply', () => {
    const definition = flow(
      'unknown',
      { a: { kind: 'end' } },
      { input: { type: 'object', unknownKeyword: true } },
    )

    const loose = createValidatorCache({ factory: { strict: false } })
    expect(createFlowGraph({ validators: loose }).check(definition).issues).toBeUndefined()

    const strict = createValidatorCache()
    const issues = failedIssues(createFlowGraph({ validators: strict }).check(definition))
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_schema', path: ['input'] }),
    )
  })

  test('bounded', () => {
    const host = createValidatorCache({ maxCompiles: 2 })
    const graphs = [createFlowGraph({ validators: host }), createFlowGraph({ validators: host })]

    for (let index = 0; index < 5; index++) {
      const definition = flow(
        `bounded-${index}`,
        { a: { kind: 'end' } },
        { input: { type: 'object', maxProperties: index + 1 } },
      )

      expect(graphs[index % 2]?.check(definition).issues).toBeUndefined()
    }

    expect(host.stats().generation).toBeGreaterThan(0)
  })

  test('graph never disposes the host cache', async () => {
    const host = createValidatorCache()
    const graph = createFlowGraph({ validators: host })
    const definition = flow('done', { a: { kind: 'end' } }, { input: objectInput })

    graph.check(definition)
    const result = await graph.run({ definition, input: { n: 1 } })

    expect(result.status).toBe('ended')
    expect(host.disposed).toBe(false)
    expect(() => host.get({ type: 'string' })).not.toThrow()
  })

  test('non-JSON kind schema throws up front', () => {
    const kind = defineNodeKind<Step>({
      ...stepKind(() => ({ next: 'end' })),
      schema: { ...stepSchema, description: undefined } as unknown as Schema,
    })

    expect(() => createFlowGraph({ validators: createValidatorCache(), kinds: [kind] })).toThrow(
      new TypeError('Kind step schema is not JSON'),
    )
  })

  test('non-JSON kind schema without validators', () => {
    const kind = defineNodeKind<Step>({
      ...stepKind(() => ({ next: 'end' })),
      schema: { ...stepSchema, description: undefined } as unknown as Schema,
    })

    const graph = createFlowGraph({ kinds: [kind] })

    expect(graph.check(stepFlow()).issues).toBeUndefined()
  })

  test('non-JSON result schema', () => {
    const kind = defineNodeKind<Step>({
      ...stepKind(() => ({ next: 'end' })),
      resultSchema: () => ({ type: 'object', description: undefined }) as unknown as Schema,
    })
    const graph = createFlowGraph({ validators: createValidatorCache(), kinds: [kind] })

    expect(failedIssues(graph.check(stepFlow()))).toContainEqual(
      expect.objectContaining({ code: 'invalid_schema', path: ['nodes', 'a'] }),
    )
  })

  test('non-JSON suspend schema', async () => {
    const kind = stepKind(() => ({
      suspend: { schema: { type: 'string', description: undefined } as unknown as Schema },
    }))
    const graph = createFlowGraph({ validators: createValidatorCache(), kinds: [kind] })

    const result = await graph.run({ definition: stepFlow() })

    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('invalid_value')
  })

  test('issue order follows sorted keys', () => {
    type Pair = { kind: 'pair'; zeta: string; alpha: string; next: string }

    const pair = defineNodeKind<Pair>({
      kind: 'pair',
      schema: {
        type: 'object',
        required: ['kind', 'zeta', 'alpha', 'next'],
        additionalProperties: false,
        properties: {
          kind: { const: 'pair' },
          zeta: { type: 'string' },
          alpha: { type: 'string' },
          next: { type: 'string' },
        },
      },
      targets: (node) => [{ path: ['next'], id: node.next }],
      execute: (node) => ({ next: node.next }),
    })
    const definition = flow('pair', {
      a: { kind: 'pair', zeta: 1, alpha: 2, next: 'end' },
      end: { kind: 'end' },
    })
    const paths = (validators?: ValidatorCache) =>
      failedIssues(createFlowGraph({ validators, kinds: [pair] }).check(definition))
        .map((issue) => issue.path.join('.'))
        .filter((path) => path === 'nodes.a.zeta' || path === 'nodes.a.alpha')

    expect(paths()).toEqual(['nodes.a.zeta', 'nodes.a.alpha'])
    expect(paths(createValidatorCache())).toEqual(['nodes.a.alpha', 'nodes.a.zeta'])
  })
})

describe('disposed host cache', () => {
  test('error name', () => {
    const error = new FlowGraphValidatorsError()

    expect(error.name).toBe('FlowGraphValidatorsError')
    expect(error.message).toBe('Flow graph validator cache is disposed')
  })

  test('entry points throw', async () => {
    const host = createValidatorCache()
    const definition = stepFlow()
    let suspend = true
    const graph = createFlowGraph({
      validators: host,
      kinds: [
        stepKind(() => (suspend ? { suspend: { schema: { type: 'number' } } } : { next: 'end' })),
      ],
      resolver: createMapResolver([definition]),
    })

    const suspended = (await graph.run({ definition })).runState

    suspend = false
    const running = graph.start({ definition })
    await running.next()
    const runningState = roundTrip(running.getState())
    await running.return()

    expect(runningState.status).toBe('running')

    host.dispose()

    expect(() => graph.check(definition)).toThrow(FlowGraphValidatorsError)
    expect(() => graph.start({ definition })).toThrow(FlowGraphValidatorsError)
    expect(() =>
      graph.resume({ runState: roundTrip(suspended), event: { type: 'value', value: 1 } }),
    ).toThrow(FlowGraphValidatorsError)
    expect(() => graph.recover({ runState: runningState })).toThrow(FlowGraphValidatorsError)
    await expect(graph.checkFlows(definition)).rejects.toThrow(FlowGraphValidatorsError)
  })

  test('entry guard covers data-free definitions', () => {
    const host = createValidatorCache()
    const graph = createFlowGraph({ validators: host })

    host.dispose()

    expect(() => graph.check(flow('free', { a: { kind: 'end' } }))).toThrow(
      FlowGraphValidatorsError,
    )
  })

  test('cached callee result does not bypass the guard', async () => {
    const host = createValidatorCache()
    const callee = flow('callee', { a: { kind: 'end' } }, { input: objectInput })
    const caller = flow('caller', {
      a: { kind: 'call', flow: 'callee', next: 'end' },
      end: { kind: 'end' },
    })
    const graph = createFlowGraph({ validators: host, resolver: createMapResolver([callee]) })

    expect((await graph.checkFlows(caller)).issues).toBeUndefined()

    host.dispose()

    await expect(graph.checkFlows(caller)).rejects.toThrow(FlowGraphValidatorsError)
  })

  test('mid-run call to a callee with input', async () => {
    const host = createValidatorCache()
    const callee = flow('callee', { a: { kind: 'end' } }, { input: objectInput })
    const caller = flow('caller', {
      a: { kind: 'step', next: 'call' },
      call: { kind: 'call', flow: 'callee', next: 'end' },
      end: { kind: 'end' },
    })
    const graph = createFlowGraph({
      validators: host,
      kinds: [
        stepKind((node) => {
          host.dispose()

          return { next: node.next }
        }),
      ],
      resolver: createMapResolver([callee]),
    })

    await expect(drain(graph.start({ definition: caller }))).rejects.toThrow(
      FlowGraphValidatorsError,
    )
  })

  test('abort wins', async () => {
    const host = createValidatorCache()
    const controller = new AbortController()
    const graph = createFlowGraph({
      validators: host,
      kinds: [
        stepKind(() => {
          host.dispose()
          controller.abort()

          return { suspend: { schema: { type: 'number' } } }
        }),
      ],
    })

    const run = graph.start({ definition: stepFlow(), signal: controller.signal })
    await drain(run)

    expect(run.getState().status).toBe('aborted')
  })
})
