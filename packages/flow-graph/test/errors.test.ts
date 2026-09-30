import { expect, test, vi } from 'vitest'

import {
  assertRunState,
  createFlowGraph,
  createMapResolver,
  type FlowDefinition,
  FlowDefinitionError,
  FlowInputError,
  type FlowResumeError,
  FlowStateError,
} from '../src/index.js'
import { builtinKinds } from '../src/kinds.js'
import { unavailableReferences } from '../src/reference-kinds.js'
import type { NodeKind } from '../src/types.js'

const definition: FlowDefinition = {
  id: 'private-flow',
  name: 'Input',
  version: 1,
  start: 'ask',
  input: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
  nodes: {
    ask: { kind: 'input', next: 'done', schema: { type: 'number' } },
    done: { kind: 'end' },
  },
}

test('definition errors expose Standard Schema issues', () => {
  const graph = createFlowGraph()
  const invalid = { ...definition, start: 'missing' }

  expect(() => graph.start({ definition: invalid })).toThrow(FlowDefinitionError)

  try {
    graph.start({ definition: invalid })
  } catch (error) {
    expect((error as FlowDefinitionError).issues).toContainEqual(
      expect.objectContaining({ message: 'Start node is missing.', path: ['start'] }),
    )
  }
})

test('input errors expose JSON and schema issues', () => {
  const graph = createFlowGraph()

  expect(() => graph.start({ definition, input: Number.POSITIVE_INFINITY })).toThrow(FlowInputError)

  try {
    graph.start({ definition, input: Number.POSITIVE_INFINITY })
  } catch (error) {
    expect((error as FlowInputError).issues).toEqual([
      { message: 'Input must be a JSON value.', path: [] },
    ])
  }

  try {
    graph.start({ definition, input: {} })
  } catch (error) {
    expect((error as FlowInputError).issues).toEqual([
      expect.objectContaining({ message: expect.any(String), path: [] }),
    ])
  }
})

test('state errors locate the invariant without exposing payloads', async () => {
  const graph = createFlowGraph()
  const first = await graph.run({ definition, input: { answer: 'secret-input' } })
  const state = structuredClone(first.runState)

  delete state.pending

  try {
    assertRunState(state, { definitions: [definition], kinds: new Map() })
  } catch (error) {
    const issues = (error as FlowStateError).issues

    expect(issues).toEqual([{ message: 'Suspended run requires pending work.', path: ['pending'] }])
    expect(JSON.stringify(issues)).not.toContain('secret-input')
  }
})

test('state errors retain schema paths and locate missing nodes', async () => {
  const graph = createFlowGraph()
  const first = await graph.run({ definition, input: { answer: 'secret-input' } })
  const missingNode = structuredClone(first.runState)
  const frame = missingNode.frames[0]

  if (!frame) {
    throw new Error('Missing fixture frame')
  }

  frame.node = 'missing'

  if (missingNode.pending) {
    // Shape checks run first: keep pending on the active node so only the definition check fails.
    missingNode.pending.node = 'missing'
  }

  expect(() =>
    assertRunState(missingNode, { definitions: [definition], kinds: new Map() }),
  ).toThrow(FlowStateError)

  try {
    assertRunState(missingNode, { definitions: [definition], kinds: new Map() })
  } catch (error) {
    expect((error as FlowStateError).issues).toEqual([
      { message: 'Active frame node is missing from definition.', path: ['frames', 0, 'node'] },
    ])
  }

  const invalidSchema = { ...first.runState, revision: 'wrong' }

  try {
    assertRunState(invalidSchema, { definitions: [definition], kinds: new Map() })
  } catch (error) {
    expect((error as FlowStateError).issues).toEqual([
      expect.objectContaining({ message: expect.any(String), path: ['revision'] }),
    ])
  }
})

test('retry count issues point to the active node attempt', async () => {
  const actionDefinition: FlowDefinition = {
    id: 'retry-count',
    name: 'Retry count',
    version: 1,
    start: 'send',
    nodes: {
      send: { kind: 'action', name: 'send', next: 'done', retry: { maxAttempts: 2 } },
      done: { kind: 'end' },
    },
  }

  const graph = createFlowGraph({ actions: { send: async () => null } })
  const run = graph.start({ definition: actionDefinition })
  const state = structuredClone((await run.next()).value)
  const attempts = state.frames[0]?.attempts.send

  if (!attempts) {
    throw new Error('Missing fixture retry attempt')
  }

  attempts.count = 3

  const kinds = new Map(
    builtinKinds({ now: Date.now, references: unavailableReferences }).map((kind) => [
      kind.kind,
      kind as NodeKind,
    ]),
  )

  expect(() => assertRunState(state, { definitions: [actionDefinition], kinds: kinds })).toThrow(
    FlowStateError,
  )

  try {
    assertRunState(state, { definitions: [actionDefinition], kinds: kinds })
  } catch (error) {
    expect((error as FlowStateError).issues).toEqual([
      {
        message: 'Retry attempt count is outside policy bounds.',
        path: ['frames', 0, 'attempts', 'send', 'count'],
      },
    ])
  }

  for await (const _commit of run) {
    // Drain the original run to close its segment.
  }
})

test('resume errors name the reason and preserve schema issues', async () => {
  const graph = createFlowGraph({ now: () => 0, resolver: createMapResolver([definition]) })
  const first = await graph.run({ definition, input: { answer: 'secret-input' } })

  try {
    graph.resume({ runState: first.runState, event: { type: 'retry' } })
  } catch (error) {
    expect((error as FlowResumeError).issues).toEqual([
      { message: 'Resume event type does not match pending work.', path: ['event', 'type'] },
    ])
  }

  try {
    graph.resume({ runState: first.runState, event: { type: 'value', value: 'bad' } })
  } catch (error) {
    expect((error as FlowResumeError).issues).toEqual([
      expect.objectContaining({ message: expect.any(String), path: [] }),
    ])
  }
})

test('resume issues distinguish a completed run from an early timeout', async () => {
  const completedDefinition = {
    id: 'completed',
    name: 'Completed',
    version: 1,
    start: 'done',
    nodes: { done: { kind: 'end' } },
  }

  const timedDefinition = {
    ...definition,
    nodes: {
      ...definition.nodes,
      ask: {
        kind: 'input',
        next: 'done',
        schema: { type: 'number' },
        timeout: { afterMs: 100, to: 'done' },
      },
    },
  }

  const graph = createFlowGraph({
    now: () => 0,
    resolver: createMapResolver([completedDefinition, timedDefinition]),
  })

  const completed = await graph.run({ definition: completedDefinition })

  try {
    graph.resume({ runState: completed.runState, event: { type: 'value', value: null } })
  } catch (error) {
    expect((error as FlowResumeError).issues).toEqual([
      { message: 'Run is not suspended.', path: ['status'] },
    ])
  }

  const suspended = await graph.run({
    definition: timedDefinition,
    input: { answer: 'secret-input' },
  })

  try {
    graph.resume({ runState: suspended.runState, event: { type: 'timeout' } })
  } catch (error) {
    expect((error as FlowResumeError).issues).toEqual([
      { message: 'Input deadline has not arrived.', path: ['pending', 'deadline'] },
    ])
  }
})

test('logs run failures to console.error when logging is not set up', async () => {
  const actions: Record<string, () => Promise<null>> = { send: async () => null }
  const graph = createFlowGraph({ actions })
  const run = graph.start({
    definition: {
      id: 'log-flow',
      name: 'Log',
      version: 1,
      start: 'send',
      nodes: { send: { kind: 'action', name: 'send', next: 'done' }, done: { kind: 'end' } },
    },
  })

  delete actions.send

  for await (const _commit of run) {
    // Drain the run so the failure is recorded.
  }

  expect(vi.mocked(console.error)).toHaveBeenCalledWith(
    '[@sozai/flow-graph] Flow run failed',
    expect.any(Object),
  )
})
