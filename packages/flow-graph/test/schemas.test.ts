import { createValidator, ValidationError } from '@sozai/schema'
import { expect, test } from 'vitest'

import { createFlowGraph } from '../src/index.js'

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
  for (const field of Object.values(root.properties))
    expect((field as { description?: string }).description).toBeTruthy()
  const nodes = root.properties.nodes?.additionalProperties?.oneOf ?? []
  for (const node of nodes)
    for (const field of Object.values(node.properties))
      expect((field as { description?: string }).description).toBeTruthy()
  expect(root.examples?.length).toBeGreaterThan(0)
})

test('storage schema accepts reserved call and flow body shapes, authoring rejects them', () => {
  const storage = graph.storageSchema
  const call = {
    ...base,
    nodes: { start: { kind: 'call', flow: 'other', next: 'end' }, end: { kind: 'end' } },
  }
  const loop = {
    ...base,
    nodes: {
      start: {
        kind: 'loop',
        maxIterations: 2,
        while: { path: ['input'], is: { isNull: false } },
        body: { flow: 'other' },
        exit: 'end',
      },
      end: { kind: 'end' },
    },
  }
  expect(createValidator(storage)(call)).not.toBeInstanceOf(ValidationError)
  expect(createValidator(storage)(loop)).not.toBeInstanceOf(ValidationError)
  expect(graph.check(call).issues.map((i) => i.code)).toContain('unsupported')
  expect(graph.check(loop).issues.map((i) => i.code)).toContain('unsupported')
})
