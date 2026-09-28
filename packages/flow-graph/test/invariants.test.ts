import { expect, test } from 'vitest'

import {
  assertRunState,
  createFlowGraph,
  FlowDefinitionError,
  FlowInputError,
  FlowResumeError,
  FlowStateError,
  FlowVersionMismatchError,
  toTimestamp,
} from '../src/index.js'

const definition = {
  id: 's',
  name: 'State',
  version: 1,
  start: 'ask',
  nodes: {
    ask: {
      kind: 'input',
      next: 'end',
      schema: { type: 'number' },
      timeout: { afterMs: 100, to: 'timeout' },
    },
    end: { kind: 'end' },
    timeout: { kind: 'end', outcome: 'timed-out' },
  },
}

test('toTimestamp emits only the four-digit canonical UTC form', () => {
  expect(toTimestamp(0)).toBe('1970-01-01T00:00:00.000Z')
  expect(() => toTimestamp(Date.UTC(10000, 0, 1))).toThrow(RangeError)
})

test('start rejects non-JSON and schema-invalid input before any commit', () => {
  const graph = createFlowGraph()

  expect(() => graph.start({ definition, input: Number.POSITIVE_INFINITY })).toThrow(FlowInputError)
  expect(() =>
    graph.start({ definition: { ...definition, input: { type: 'string' } }, input: 1 }),
  ).toThrow(FlowInputError)
  expect(() => graph.start({ definition: { ...definition, version: Number.NaN } })).toThrow(
    FlowDefinitionError,
  )
})

test('input timeout follows the injected clock and late value wins', async () => {
  let clock = 0
  const graph = createFlowGraph({ now: () => clock })
  const first = await graph.run({ definition })

  expect(first.pending?.deadline).toBe('1970-01-01T00:00:00.100Z')
  expect(() =>
    graph.resume({ definition, runState: first.runState, event: { type: 'timeout' } }),
  ).toThrow(FlowResumeError)
  expect(() =>
    graph.resume({
      definition,
      runState: first.runState,
      event: { type: 'value', value: 'wrong' },
    }),
  ).toThrow(FlowResumeError)

  clock = 200

  const late = graph.resume({
    definition,
    runState: first.runState,
    event: { type: 'value', value: 3 },
  })

  for await (const _state of late) {
    /* drain */
  }

  expect(late.getState().status).toBe('ended')

  const timed = graph.resume({ definition, runState: first.runState, event: { type: 'timeout' } })

  for await (const _state of timed) {
    /* drain */
  }

  expect(timed.getState().outcome).toBe('timed-out')
})

test('resume rejects digest mismatch and malformed state without mutation', async () => {
  const graph = createFlowGraph()
  const first = await graph.run({ definition })
  const state = JSON.parse(JSON.stringify(first.runState))

  expect(() =>
    graph.resume({
      definition: { ...definition, name: 'Edited' },
      runState: state,
      event: { type: 'value', value: 1 },
    }),
  ).toThrow(FlowVersionMismatchError)
  expect(() =>
    graph.resume({
      definition: { ...definition, version: 2 },
      runState: state,
      event: { type: 'value', value: 1 },
    }),
  ).toThrow(FlowVersionMismatchError)

  const bad = { ...state, status: 'suspended', pending: undefined }

  expect(() =>
    graph.resume({ definition, runState: bad, event: { type: 'value', value: 1 } }),
  ).toThrow(FlowStateError)
  expect(state).toEqual(first.runState)
})

type MutableState = {
  status: string
  pending?: { deadline?: string }
  frames: Array<{ loops: Record<string, number> }>
}

test.each([
  [
    'running with pending',
    (state: MutableState) => {
      state.status = 'running'
    },
  ],
  [
    'suspended without pending',
    (state: MutableState) => {
      delete state.pending
    },
  ],
  [
    'error without error',
    (state: MutableState) => {
      state.status = 'error'
      delete state.pending
    },
  ],
  [
    'ended with pending',
    (state: MutableState) => {
      state.status = 'ended'
    },
  ],
  [
    'aborted with pending',
    (state: MutableState) => {
      state.status = 'aborted'
    },
  ],
  [
    'non-canonical deadline',
    (state: MutableState) => {
      if (state.pending) {
        state.pending.deadline = '1970-01-01T00:00:00+00:00'
      }
    },
  ],
  [
    'invalid loop counter',
    (state: MutableState) => {
      const frame = state.frames[0]

      if (frame) {
        frame.loops.ask = 1
      }
    },
  ],
])('%s violates run state invariants', async (_label, mutate) => {
  const first = await createFlowGraph().run({ definition })
  const state = JSON.parse(JSON.stringify(first.runState))

  mutate(state)

  expect(() => assertRunState(state, definition, new Map())).toThrow(FlowStateError)
})
