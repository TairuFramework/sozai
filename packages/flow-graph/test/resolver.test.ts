import { expect, test } from 'vitest'

import type { FlowDefinition, RunState } from '../src/index.js'
import {
  createFlowGraph,
  createMapResolver,
  FlowDefinitionError,
  FlowReferenceError,
  FlowStateError,
  FlowVersionMismatchError,
} from '../src/index.js'

const inputDefinition = (version = 1): FlowDefinition => ({
  id: 'ask',
  name: 'Ask',
  version,
  start: 'ask',
  nodes: {
    ask: { kind: 'input', next: 'done' },
    done: { kind: 'end', output: { answer: { ref: ['results', 'ask'] } } },
  },
})

async function suspended(definition: FlowDefinition): Promise<RunState> {
  const first = await createFlowGraph().run({ definition })

  expect(first.status).toBe('suspended')

  return JSON.parse(JSON.stringify(first.runState))
}

async function drain(run: AsyncIterable<RunState>): Promise<void> {
  for await (const _state of run) {
    /* drain */
  }
}

test('createMapResolver returns the highest version when unversioned', async () => {
  const resolver = createMapResolver([inputDefinition(2), inputDefinition(3), inputDefinition(1)])

  expect((await resolver.resolve('ask')).version).toBe(3)
  expect((await resolver.resolve('ask', 2)).version).toBe(2)
})

test('createMapResolver throws FlowReferenceError on a miss', () => {
  const resolver = createMapResolver([inputDefinition(1)])

  expect(() => resolver.resolve('missing')).toThrow(FlowReferenceError)

  try {
    resolver.resolve('ask', 4)
  } catch (error) {
    expect(error).toBeInstanceOf(FlowReferenceError)
    expect((error as FlowReferenceError).id).toBe('ask')
    expect((error as FlowReferenceError).version).toBe(4)
  }
})

test('createMapResolver rejects duplicate id and version', () => {
  expect(() => createMapResolver([inputDefinition(1), inputDefinition(1)])).toThrow(TypeError)
})

test('resume without a resolver throws TypeError', async () => {
  const runState = await suspended(inputDefinition())

  expect(() => createFlowGraph().resume({ runState, event: { type: 'value', value: 1 } })).toThrow(
    TypeError,
  )
})

test('recover without a resolver throws TypeError', async () => {
  const runState = await suspended(inputDefinition())

  expect(() => createFlowGraph().recover({ runState })).toThrow(TypeError)
})

test('resume resolves the pinned root and continues', async () => {
  const definition = inputDefinition()
  const runState = await suspended(definition)
  const graph = createFlowGraph({ resolver: createMapResolver([definition]) })
  const run = graph.resume({ runState, event: { type: 'value', value: 42 } })

  await drain(run)

  expect(run.getState().status).toBe('ended')
  expect(run.getState().output).toEqual({ answer: 42 })
})

test('resume rejects next() with the resolver error when the definition is gone', async () => {
  const runState = await suspended(inputDefinition())
  const graph = createFlowGraph({ resolver: createMapResolver([]) })
  const run = graph.resume({ runState, event: { type: 'value', value: 42 } })

  await expect(run.next()).rejects.toBeInstanceOf(FlowReferenceError)
  expect(run.getState()).toEqual(runState)
})

test('resume rejects next() with FlowVersionMismatchError when the digest changed', async () => {
  const definition = inputDefinition()
  const runState = await suspended(definition)

  const edited = createFlowGraph({
    resolver: createMapResolver([{ ...definition, name: 'Edited' }]),
  }).resume({ runState, event: { type: 'value', value: 1 } })

  await expect(edited.next()).rejects.toBeInstanceOf(FlowVersionMismatchError)
  expect(edited.getState()).toEqual(runState)

  const invalid = createFlowGraph({
    resolver: createMapResolver([{ ...definition, start: 'missing' }]),
  }).resume({ runState, event: { type: 'value', value: 1 } })

  await expect(invalid.next()).rejects.toBeInstanceOf(FlowVersionMismatchError)
  expect(invalid.getState()).toEqual(runState)
})

test('resume phase 1 errors throw synchronously', async () => {
  const definition = inputDefinition()
  const runState = await suspended(definition)
  const graph = createFlowGraph({ resolver: createMapResolver([definition]) })

  expect(() =>
    graph.resume({
      runState: { ...runState, frames: [] },
      event: { type: 'value', value: 1 },
    }),
  ).toThrow(FlowStateError)
})

test('start runs a snapshot, not the caller object', async () => {
  const definition: FlowDefinition = {
    id: 'snap',
    name: 'Snap',
    version: 1,
    start: 'a',
    nodes: {
      a: { kind: 'set', assign: [{ path: ['state', 'x'], value: { value: 1 } }], next: 'done' },
      done: { kind: 'end', outcome: 'original' },
    },
  }

  const graph = createFlowGraph()
  const run = graph.start({ definition })

  definition.nodes.done = { kind: 'end', outcome: 'mutated' }
  definition.nodes.a = { kind: 'end', outcome: 'mutated' }

  await drain(run)

  expect(run.getState().outcome).toBe('original')
})

test('start with a non-JSON definition throws FlowDefinitionError', () => {
  const definition = {
    ...inputDefinition(),
    nodes: { ...inputDefinition().nodes, extra: { kind: 'end', fn: () => 1 } },
  } as unknown as FlowDefinition

  expect(() => createFlowGraph().start({ definition })).toThrow(FlowDefinitionError)

  try {
    createFlowGraph().start({ definition })
  } catch (error) {
    expect((error as FlowDefinitionError).issues.map((issue) => issue.code)).toEqual(['schema'])
  }
})

test('resume rejects next() with FlowStateError when a definition invariant fails', async () => {
  const definition = inputDefinition()
  const runState = await suspended(definition)
  const frame = runState.frames[0]

  if (frame) {
    frame.loops.ask = 1
  }

  const run = createFlowGraph({ resolver: createMapResolver([definition]) }).resume({
    runState,
    event: { type: 'value', value: 1 },
  })

  await expect(run.next()).rejects.toBeInstanceOf(FlowStateError)
  expect(run.getState()).toEqual(runState)
})

test('maxDepth must be an integer of at least 1', () => {
  expect(() => createFlowGraph({ maxDepth: 0 })).toThrow(RangeError)
  expect(() => createFlowGraph({ maxDepth: 1.5 })).toThrow(RangeError)
  expect(() => createFlowGraph({ maxDepth: 1 })).not.toThrow()
})

test('resume checks the stack against the configured maxDepth', async () => {
  const definition = inputDefinition()
  const runState = await suspended(definition)
  const root = runState.frames[0]

  if (!root) {
    throw new Error('Missing root frame')
  }

  const stacked: RunState = {
    ...runState,
    frames: [
      { ...root, node: 'done', attempts: {} },
      { ...root, continuation: { kind: 'call', callerNode: 'done', returnTo: 'done' } },
    ],
  }

  const shallow = createFlowGraph({ maxDepth: 1, resolver: createMapResolver([definition]) })

  expect(() => shallow.resume({ runState: stacked, event: { type: 'value', value: 1 } })).toThrow(
    FlowStateError,
  )

  try {
    shallow.resume({ runState: stacked, event: { type: 'value', value: 1 } })
  } catch (error) {
    expect((error as FlowStateError).issues[0]?.message).toBe(
      'Run state exceeds the maximum frame depth.',
    )
  }
})

test('a rejected phase 2 retries on the next call instead of finishing the run', async () => {
  const definition = inputDefinition()
  const runState = await suspended(definition)
  let calls = 0

  const graph = createFlowGraph({
    resolver: {
      resolve: async (id, version) => {
        calls++

        if (calls === 1) {
          throw new Error('transient')
        }

        return createMapResolver([definition]).resolve(id, version)
      },
    },
  })

  const run = graph.resume({ runState, event: { type: 'value', value: 42 } })

  await expect(run.next()).rejects.toThrow('transient')
  expect(run.getState()).toEqual(runState)

  const second = await run.next()

  expect(second.done).toBe(false)
  expect(second.value.revision).toBe(runState.revision + 1)

  await drain(run)

  expect(run.getState().status).toBe('ended')
  expect(run.getState().output).toEqual({ answer: 42 })
})

test('a persistently failing phase 2 keeps rejecting', async () => {
  const runState = await suspended(inputDefinition())
  const run = createFlowGraph({ resolver: createMapResolver([]) }).resume({
    runState,
    event: { type: 'value', value: 42 },
  })

  await expect(run.next()).rejects.toBeInstanceOf(FlowReferenceError)
  await expect(run.next()).rejects.toBeInstanceOf(FlowReferenceError)
  expect(run.getState()).toEqual(runState)
})

test('resume with a pre-aborted signal commits aborted without resolving', async () => {
  const runState = await suspended(inputDefinition())
  let calls = 0

  const graph = createFlowGraph({
    resolver: {
      resolve: () => {
        calls++

        throw new Error('unexpected')
      },
    },
  })

  const controller = new AbortController()

  controller.abort()

  const run = graph.resume({
    runState,
    event: { type: 'value', value: 1 },
    signal: controller.signal,
  })

  const commit = await run.next()

  expect(commit.value.status).toBe('aborted')
  expect(commit.value.revision).toBe(runState.revision + 1)
  expect(commit.value.pending).toBeUndefined()
  expect(calls).toBe(0)
  expect((await run.next()).done).toBe(true)
})

test('recover with a pre-aborted signal commits aborted without resolving', async () => {
  const definition: FlowDefinition = {
    id: 'work',
    name: 'Work',
    version: 1,
    start: 'a',
    nodes: { a: { kind: 'action', name: 'work', next: 'done' }, done: { kind: 'end' } },
  }

  const started = createFlowGraph({ actions: { work: () => 1 } }).start({ definition })
  const entered = await started.next()

  expect(entered.value.status).toBe('running')

  let calls = 0
  const controller = new AbortController()

  controller.abort()

  const run = createFlowGraph({
    actions: { work: () => 1 },
    resolver: {
      resolve: () => {
        calls++

        throw new Error('unexpected')
      },
    },
  }).recover({ runState: JSON.parse(JSON.stringify(entered.value)), signal: controller.signal })

  const commit = await run.next()

  expect(commit.value.status).toBe('aborted')
  expect(calls).toBe(0)
})

test('an abort during an async resolver commits aborted instead of rejecting', async () => {
  const runState = await suspended(inputDefinition())
  const controller = new AbortController()
  const signals: Array<AbortSignal | undefined> = []

  const graph = createFlowGraph({
    resolver: {
      resolve: (_id, _version, options) => {
        signals.push(options?.signal)

        return new Promise<FlowDefinition>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted lookup')))

          controller.abort()
        })
      },
    },
  })

  const run = graph.resume({
    runState,
    event: { type: 'value', value: 1 },
    signal: controller.signal,
  })

  const commit = await run.next()

  expect(signals).toEqual([controller.signal])
  expect(commit.value.status).toBe('aborted')
  expect(commit.value.frames).toEqual(runState.frames)
})

test('the resolver receives the run signal at preflight, push and resume', async () => {
  const callee: FlowDefinition = {
    id: 'callee',
    name: 'Callee',
    version: 1,
    start: 'ask',
    nodes: { ask: { kind: 'input', next: 'done' }, done: { kind: 'end' } },
  }

  const caller: FlowDefinition = {
    id: 'caller',
    name: 'Caller',
    version: 1,
    start: 'c',
    nodes: { c: { kind: 'call', flow: 'callee', version: 1, next: 'done' }, done: { kind: 'end' } },
  }

  const map = createMapResolver([caller, callee])
  const seen: Array<[string, AbortSignal | undefined]> = []

  const graph = createFlowGraph({
    resolver: {
      resolve: async (id, version, options) => {
        seen.push([id, options?.signal])

        return map.resolve(id, version)
      },
    },
  })

  const first = new AbortController()
  const started = graph.start({ definition: caller, signal: first.signal })

  await drain(started)

  expect(started.getState().status).toBe('suspended')
  expect(seen).toEqual([
    ['callee', first.signal],
    ['callee', first.signal],
  ])

  seen.length = 0

  const second = new AbortController()

  const resumed = graph.resume({
    runState: JSON.parse(JSON.stringify(started.getState())),
    event: { type: 'value', value: 1 },
    signal: second.signal,
  })

  await drain(resumed)

  expect(resumed.getState().status).toBe('ended')
  expect(seen).toEqual([
    ['caller', second.signal],
    ['callee', second.signal],
  ])
})
