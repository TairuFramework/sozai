import { createValidator, ValidationError } from '@sozai/schema'
import { expect, test, vi } from 'vitest'

import { createFlowGraph, createMapResolver } from '../src/index.js'

vi.mock('@sozai/schema', async (importOriginal) => {
  const original = await importOriginal<typeof import('@sozai/schema')>()

  return { ...original, createValidator: vi.fn(original.createValidator) }
})

const graph = createFlowGraph()

const base = {
  id: 'schema',
  name: 'Schema',
  version: 1,
  start: 'start',
  nodes: { start: { kind: 'end' } },
}

test('authoring schema documents each direct definition and built-in node field', () => {
  const root = graph.authoringSchema as unknown as {
    properties: Record<
      string,
      {
        description?: string
        additionalProperties?: {
          oneOf?: Array<{ properties: Record<string, { description?: string }> }>
        }
      }
    >
    examples?: Array<unknown>
  }

  for (const field of Object.values(root.properties)) {
    expect((field as { description?: string }).description).toBeTruthy()
  }

  const nodes = root.properties.nodes?.additionalProperties?.oneOf ?? []

  for (const node of nodes) {
    for (const field of Object.values(node.properties)) {
      expect((field as { description?: string }).description).toBeTruthy()
    }
  }

  expect(root.examples?.length).toBeGreaterThan(0)
})

test('graph exposes no storageSchema', () => {
  expect(Object.hasOwn(graph, 'storageSchema')).toBe(false)
})

test('authoring schema accepts call, goto and flow body shapes', () => {
  const authoring = graph.authoringSchema

  const call = {
    ...base,
    nodes: {
      start: { kind: 'call', flow: 'other', version: 1, input: { a: { value: 1 } }, next: 'end' },
      end: { kind: 'end' },
    },
  }

  const goto = { ...base, nodes: { start: { kind: 'goto', flow: 'other' } } }

  const loop = {
    ...base,
    nodes: {
      start: {
        kind: 'loop',
        maxIterations: 2,
        while: { path: ['input'], is: { isNull: false } },
        body: { flow: 'other', input: { a: { ref: ['input'] } } },
        exit: 'end',
      },
      end: { kind: 'end' },
    },
  }

  for (const definition of [call, goto, loop]) {
    expect(createValidator(authoring)(definition)).not.toBeInstanceOf(ValidationError)
  }

  expect(
    createValidator(authoring)({
      ...loop,
      nodes: { ...loop.nodes, start: { ...loop.nodes.start, body: { flow: 'other', extra: 1 } } },
    }),
  ).toBeInstanceOf(ValidationError)
})

test('a suspend schema compiles once across suspend and a round-tripped resume', async () => {
  const schema = { type: 'number', title: 'compile-once-marker' }

  const definition = {
    id: 'compile',
    name: 'Compile',
    version: 1,
    start: 'ask',
    nodes: { ask: { kind: 'input', schema, next: 'done' }, done: { kind: 'end' } },
  }

  const compiles = () =>
    vi
      .mocked(createValidator)
      .mock.calls.filter(([compiled]) => JSON.stringify(compiled) === JSON.stringify(schema)).length

  const counting = createFlowGraph({ resolver: createMapResolver([definition]) })
  const first = await counting.run({ definition })

  expect(first.status).toBe('suspended')

  const resumed = counting.resume({
    runState: JSON.parse(JSON.stringify(first.runState)),
    event: { type: 'value', value: 1 },
  })

  for await (const _state of resumed) {
    /* drain */
  }

  expect(resumed.getState().status).toBe('ended')
  expect(compiles()).toBe(1)
})

test('authoring schema compiles under default strict mode without warnings', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const strictGraph = createFlowGraph({ actions: { ok: async () => 1 } })

  const validate = createValidator(strictGraph.authoringSchema)

  expect(validate(base)).toEqual({ value: base })
  expect(warn).not.toHaveBeenCalled()
  expect(log).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
})

test('authoring schema limits end outcomes to literal strings or references', () => {
  const validate = createValidator(graph.authoringSchema)

  for (const outcome of ['ok', { ref: ['results', 'inner', 'outcome'] }]) {
    const definition = { ...base, nodes: { start: { kind: 'end', outcome } } }

    expect(validate(definition)).toEqual({ value: definition })
  }

  for (const outcome of [
    42,
    { value: 'ok' },
    { object: { outcome: { value: 'ok' } } },
    { array: [{ value: 'ok' }] },
    { ref: [] },
    { ref: ['input', '__proto__'] },
    { ref: ['input'], extra: true },
  ]) {
    expect(validate({ ...base, nodes: { start: { kind: 'end', outcome } } })).toBeInstanceOf(
      ValidationError,
    )
  }
})
