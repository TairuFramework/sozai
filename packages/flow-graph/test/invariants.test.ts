import { expect, test } from 'vitest'

import type { FlowDefinition, NodeKind, RunState } from '../src/index.js'
import {
  assertRunState,
  createFlowGraph,
  createMapResolver,
  FlowDefinitionError,
  FlowInputError,
  FlowResumeError,
  FlowStateError,
  FlowVersionMismatchError,
  toTimestamp,
} from '../src/index.js'
import { builtinKinds } from '../src/kinds.js'
import { unavailableReferences } from '../src/reference-kinds.js'
import { assertRunStateDefinitions, assertRunStateShape } from '../src/state.js'

const required = <Value>(value: Value | undefined): Value => {
  if (value === undefined) {
    throw new Error('Missing fixture value')
  }

  return value
}

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
  const graph = createFlowGraph({ now: () => clock, resolver: createMapResolver([definition]) })
  const first = await graph.run({ definition })

  expect(first.pending?.deadline).toBe('1970-01-01T00:00:00.100Z')
  expect(() => graph.resume({ runState: first.runState, event: { type: 'timeout' } })).toThrow(
    FlowResumeError,
  )
  expect(() =>
    graph.resume({ runState: first.runState, event: { type: 'value', value: 'wrong' } }),
  ).toThrow(FlowResumeError)

  clock = 200

  const late = graph.resume({ runState: first.runState, event: { type: 'value', value: 3 } })

  for await (const _state of late) {
    /* drain */
  }

  expect(late.getState().status).toBe('ended')

  const timed = graph.resume({ runState: first.runState, event: { type: 'timeout' } })

  for await (const _state of timed) {
    /* drain */
  }

  expect(timed.getState().outcome).toBe('timed-out')
})

test('resume rejects digest mismatch and malformed state without mutation', async () => {
  const first = await createFlowGraph().run({ definition })
  const state = JSON.parse(JSON.stringify(first.runState))

  const edited = createFlowGraph({
    resolver: createMapResolver([{ ...definition, name: 'Edited' }]),
  }).resume({ runState: state, event: { type: 'value', value: 1 } })

  await expect(edited.next()).rejects.toBeInstanceOf(FlowVersionMismatchError)

  const bumped = createFlowGraph({
    resolver: { resolve: () => ({ ...definition, version: 2 }) },
  }).resume({ runState: state, event: { type: 'value', value: 1 } })

  await expect(bumped.next()).rejects.toBeInstanceOf(FlowVersionMismatchError)

  const bad = { ...state, status: 'suspended', pending: undefined }
  const graph = createFlowGraph({ resolver: createMapResolver([definition]) })

  expect(() => graph.resume({ runState: bad, event: { type: 'value', value: 1 } })).toThrow(
    FlowStateError,
  )
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

  expect(() => assertRunState(state, { definitions: [definition], kinds: new Map() })).toThrow(
    FlowStateError,
  )
})

test('persisted pending schema that cannot compile is a FlowStateError', async () => {
  const graph = createFlowGraph({ resolver: createMapResolver([definition]) })
  const first = await graph.run({ definition })
  const state = JSON.parse(JSON.stringify(first.runState))

  state.pending.schema = { type: 'nope' }

  expect(() => graph.resume({ runState: state, event: { type: 'value', value: 1 } })).toThrow(
    FlowStateError,
  )
})

test('invocation counter is run-level and IDs use runID:n', async () => {
  const seen: Array<string> = []
  const graph = createFlowGraph({
    actions: {
      work: ({ invocationID }) => {
        seen.push(invocationID)

        return null
      },
    },
  })

  const result = await graph.run({
    runID: 'fixed',
    definition: {
      id: 'two',
      name: 'Two',
      version: 1,
      start: 'a',
      nodes: {
        a: { kind: 'action', name: 'work', next: 'b' },
        b: { kind: 'action', name: 'work', next: 'end' },
        end: { kind: 'end' },
      },
    },
  })

  expect(result.status).toBe('ended')
  expect(seen).toEqual(['fixed:1', 'fixed:2'])
  // Every node entry draws an invocation, so the closing `end` node takes the third one.
  expect(result.runState.invocation).toBe(3)

  for (const frame of result.runState.frames) {
    expect(Object.hasOwn(frame, 'invocation')).toBe(false)
  }
})

const twoFrames = (): RunState => ({
  runID: 'run',
  revision: 1,
  status: 'running',
  steps: 2,
  invocation: 2,
  frames: [
    {
      flow: { id: 'root', version: 1, digest: 'root-digest' },
      node: 'call',
      input: null,
      state: {},
      results: {},
      loops: {},
      attempts: {
        call: { invocationID: 'run:1', policy: { maxAttempts: 2 }, count: 1, interruptions: 0 },
      },
    },
    {
      flow: { id: 'child', version: 1, digest: 'child-digest' },
      node: 'work',
      input: {},
      state: {},
      results: {},
      loops: {},
      attempts: {
        work: { invocationID: 'run:2', policy: { maxAttempts: 1 }, count: 0, interruptions: 0 },
      },
      continuation: { kind: 'call', callerNode: 'call', returnTo: 'end' },
    },
  ],
})

const rootDefinition = {
  id: 'root',
  name: 'Root',
  version: 1,
  start: 'call',
  nodes: { call: { kind: 'call', flow: 'child', next: 'end' }, end: { kind: 'end' } },
} as FlowDefinition

const childDefinition = {
  id: 'child',
  name: 'Child',
  version: 1,
  start: 'work',
  nodes: { work: { kind: 'action', name: 'work', next: 'end' }, end: { kind: 'end' } },
} as FlowDefinition

const stackKinds = new Map<string, NodeKind>([
  ...builtinKinds({ now: Date.now, references: unavailableReferences }).map(
    (kind) => [kind.kind, kind as never] as const,
  ),
])

test('accepts a well-formed two-frame state', () => {
  expect(() => assertRunStateShape(twoFrames(), { maxDepth: 16 })).not.toThrow()
  expect(() =>
    assertRunState(twoFrames(), {
      definitions: [rootDefinition, childDefinition],
      kinds: stackKinds,
    }),
  ).not.toThrow()
})

const issuePaths = (assert: () => void): Array<Array<string | number>> => {
  try {
    assert()
  } catch (error) {
    expect(error).toBeInstanceOf(FlowStateError)

    return (error as FlowStateError).issues.map((issue) => [...(issue.path ?? [])] as never)
  }

  throw new Error('Expected a FlowStateError')
}

const shapePaths = (state: RunState, maxDepth = 16) =>
  issuePaths(() => assertRunStateShape(state, { maxDepth }))

const definitionPaths = (state: RunState, definitions: Array<FlowDefinition>) =>
  issuePaths(() => assertRunStateDefinitions({ state, definitions, kinds: stackKinds }))

test('rejects duplicate invocation IDs across frames', () => {
  const state = twoFrames()

  required(state.frames[1]?.attempts.work).invocationID = 'run:1'

  expect(shapePaths(state)).toEqual([['frames', 1, 'attempts', 'work', 'invocationID']])
})

test('rejects invocation ID above the counter', () => {
  const state = twoFrames()

  state.invocation = 1

  expect(shapePaths(state)).toEqual([['frames', 1, 'attempts', 'work', 'invocationID']])
})

test('rejects a malformed invocation ID', () => {
  const state = twoFrames()

  required(state.frames[1]?.attempts.work).invocationID = 'other:2'

  expect(shapePaths(state)).toEqual([['frames', 1, 'attempts', 'work', 'invocationID']])
})

test('rejects a lower frame with retryAt', () => {
  const state = twoFrames()

  required(state.frames[0]?.attempts.call).retryAt = '1970-01-01T00:00:00.100Z'

  expect(shapePaths(state)).toEqual([['frames', 0, 'attempts', 'call', 'retryAt']])
})

test('rejects a non-root frame without continuation', () => {
  const state = twoFrames()

  delete required(state.frames[1]).continuation

  expect(shapePaths(state)).toEqual([['frames', 1, 'continuation']])
})

test('rejects a root frame with continuation', () => {
  const state = twoFrames()

  required(state.frames[0]).continuation = { kind: 'call', callerNode: 'x', returnTo: 'y' }

  expect(shapePaths(state)).toEqual([['frames', 0, 'continuation']])
})

test('rejects more frames than maxDepth', () => {
  expect(shapePaths(twoFrames(), 1)).toEqual([['frames']])
})

const loopRootDefinition = {
  id: 'root',
  name: 'Root',
  version: 1,
  start: 'loop',
  nodes: {
    loop: {
      kind: 'loop',
      maxIterations: 2,
      while: { path: ['input'], is: { isNull: true } },
      body: { flow: 'child' },
      exit: 'end',
    },
    call: { kind: 'call', flow: 'child', next: 'end' },
    end: { kind: 'end' },
  },
} as FlowDefinition

const loopBodyFrames = (): RunState => {
  const state = twoFrames()
  const root = required(state.frames[0])

  root.node = 'loop'
  root.attempts = {}
  root.loops = { loop: 1 }
  required(state.frames[1]).continuation = {
    kind: 'loopBody',
    callerNode: 'loop',
    returnTo: 'loop',
  }

  return state
}

test('accepts a lower frame parked on a flow-body loop', () => {
  const state = loopBodyFrames()

  expect(() => assertRunStateShape(state, { maxDepth: 16 })).not.toThrow()
  expect(() =>
    assertRunStateDefinitions({
      state,
      definitions: [loopRootDefinition, childDefinition],
      kinds: stackKinds,
    }),
  ).not.toThrow()
})

test('rejects a lower frame not parked on a call or flow-body loop', () => {
  const state = twoFrames()

  required(state.frames[0]).attempts = {}

  const definitions = [
    { ...rootDefinition, nodes: { ...rootDefinition.nodes, call: { kind: 'end' } } },
    childDefinition,
  ]

  expect(definitionPaths(state, definitions)).toEqual([['frames', 0, 'node']])
})

test('rejects a lower loop frame whose body is not a flow', () => {
  const state = loopBodyFrames()
  const loop = required(loopRootDefinition.nodes.loop)
  const definitions = [
    {
      ...loopRootDefinition,
      nodes: { ...loopRootDefinition.nodes, loop: { ...loop, body: 'end' } },
    },
    childDefinition,
  ]

  expect(definitionPaths(state, definitions)).toEqual([['frames', 0, 'node']])
})

test('rejects a loopBody continuation over a call node', () => {
  const state = twoFrames()

  required(required(state.frames[1]).continuation).kind = 'loopBody'

  expect(definitionPaths(state, [rootDefinition, childDefinition])).toEqual([['frames', 0, 'node']])
})

test('rejects a call continuation over a flow-body loop node', () => {
  const state = loopBodyFrames()

  required(required(state.frames[1]).continuation).kind = 'call'

  expect(definitionPaths(state, [loopRootDefinition, childDefinition])).toEqual([
    ['frames', 0, 'node'],
  ])
})

test('rejects a lower frame whose node differs from the callerNode above', () => {
  const state = twoFrames()
  const continuation = required(required(state.frames[1]).continuation)

  continuation.callerNode = 'end'

  expect(definitionPaths(state, [rootDefinition, childDefinition])).toEqual([['frames', 0, 'node']])
})

test('rejects definitions that do not match the frame count', () => {
  const state = twoFrames()

  expect(definitionPaths(state, [rootDefinition])).toEqual([['frames']])
  expect(definitionPaths(state, [rootDefinition, childDefinition, childDefinition])).toEqual([
    ['frames'],
  ])
})
