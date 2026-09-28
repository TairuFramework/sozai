import { expect, test } from 'vitest'

import type { FlowNode } from '../src/index.js'
import { createFlowGraph, FlowRetryableError } from '../src/index.js'

const definition = (nodes: Record<string, FlowNode>, start = 'start') => ({
  id: 'test',
  name: 'Test',
  version: 1,
  start,
  nodes,
})

test('runs set, branch and end with ordered writes', async () => {
  const graph = createFlowGraph()

  const result = await graph.run({
    definition: definition({
      start: {
        kind: 'set',
        assign: [
          { path: ['state', 'x'], value: { value: 1 } },
          { path: ['state', 'y'], value: { ref: ['state', 'x'] } },
        ],
        next: 'branch',
      },
      branch: {
        kind: 'branch',
        cases: [{ when: { path: ['state', 'y'], is: { equalTo: 1 } }, to: 'yes' }],
        default: 'no',
      },
      yes: { kind: 'end', outcome: 'yes', output: { value: { ref: ['state', 'y'] } } },
      no: { kind: 'end', outcome: 'no' },
    }),
  })

  expect(result.status).toBe('ended')
  expect(result.output).toEqual({ value: 1 })
  expect(result.outcome).toBe('yes')
})

test('yields durable entry, checkpoint and transition commits', async () => {
  const graph = createFlowGraph({ actions: { ok: async () => 1 } })

  const run = graph.start({
    definition: definition({
      start: { kind: 'action', name: 'ok', next: 'end' },
      end: { kind: 'end' },
    }),
  })

  const states = []

  for await (const state of run) {
    states.push(state)
  }

  expect(
    states.map((state) => [
      state.revision,
      state.steps,
      state.frames[0]?.invocation,
      state.frames[0]?.attempts.start?.count,
      state.inFlight?.attempt,
    ]),
  ).toEqual([
    [1, 1, 1, 0, undefined],
    [2, 1, 1, 1, 1],
    [3, 1, 1, undefined, undefined],
    [4, 2, 2, undefined, undefined],
  ])
})

test('suspends input and resumes from JSON in a fresh graph', async () => {
  const def = definition({
    start: { kind: 'input', prompt: { value: 'answer' }, next: 'end' },
    end: { kind: 'end', output: { answer: { ref: ['results', 'start'] } } },
  })

  const first = await createFlowGraph().run({ definition: def })

  expect(first.status).toBe('suspended')

  const second = createFlowGraph().resume({
    definition: def,
    runState: JSON.parse(JSON.stringify(first.runState)),
    event: { type: 'value', value: 42 },
  })

  for await (const _state of second) {
    /* consume */
  }

  expect(second.getState().output).toEqual({ answer: 42 })
})

test('retries with a stable invocation id', async () => {
  const seen: Array<string> = []

  const graph = createFlowGraph({
    actions: {
      flaky: async ({ invocationID }) => {
        seen.push(invocationID)

        if (seen.length === 1) {
          throw new FlowRetryableError({ message: 'secret' })
        }

        return 1
      },
    },
  })

  const result = await graph.run({
    definition: definition({
      start: { kind: 'action', name: 'flaky', retry: { maxAttempts: 2 }, next: 'end' },
      end: { kind: 'end' },
    }),
  })

  expect(result.status).toBe('ended')
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe(seen[1])
})
