import { expect, test } from 'vitest'

import type { FlowDefinition, FlowGraphOptions, FlowNode, RunState } from '../src/index.js'
import {
  createFlowGraph,
  createMapResolver,
  defineNodeKind,
  FlowNodeFailure,
  FlowRetryableError,
} from '../src/index.js'
import { assertStates, remember } from './state-check.js'

function makeGraph(definitions: Array<FlowDefinition>, options: FlowGraphOptions = {}) {
  definitions.forEach(remember)

  return createFlowGraph({ resolver: createMapResolver(definitions), ...options })
}

function flow(id: string, nodes: Record<string, FlowNode>) {
  return remember({
    id,
    name: id,
    version: 1,
    start: Object.keys(nodes)[0] as string,
    nodes,
  } as FlowDefinition)
}

async function collect(run: AsyncIterable<RunState>): Promise<Array<RunState>> {
  const states: Array<RunState> = []

  for await (const state of run) {
    states.push(state)
  }

  assertStates(states)

  return states
}

const roundTrip = (state: RunState): RunState => JSON.parse(JSON.stringify(state))

const worker = (retry: Record<string, unknown> = { maxAttempts: 1 }) =>
  flow('worker', {
    a: { kind: 'action', name: 'work', retry, next: 'done' },
    done: { kind: 'end', output: { value: { ref: ['results', 'a'] } } },
  })

const caller = (extra: Record<string, unknown> = {}) =>
  flow('caller', {
    c: { kind: 'call', flow: 'worker', next: 'done', ...extra },
    done: { kind: 'end', outcome: 'done' },
    failed: { kind: 'end', outcome: 'failed' },
  })

test('retryable callee failure re-pushes with the same call invocationID', async () => {
  const actionIDs: Array<string> = []
  const callIDs = new Set<string>()
  let calls = 0

  const graph = makeGraph([worker()], {
    actions: {
      work: ({ invocationID }) => {
        calls++
        actionIDs.push(invocationID)

        if (calls === 1) {
          throw new FlowRetryableError({ message: 'again' })
        }

        return 'ok'
      },
    },
  })

  const run = graph.start({ definition: caller({ retry: { maxAttempts: 2 } }) })
  const states = await collect(run)

  for (const state of states) {
    const id = state.frames[0]?.attempts.c?.invocationID

    if (id) {
      callIDs.add(id)
    }
  }

  const lengths = states.map((state) => state.frames.length)
  const collapsed = lengths.filter((length, index) => length !== lengths[index - 1])

  expect(run.getState().status).toBe('ended')
  expect(run.getState().frames[0]?.results.c).toEqual({ output: { value: 'ok' } })
  expect(calls).toBe(2)
  expect(collapsed).toEqual([1, 2, 1, 2, 1])
  expect(callIDs.size).toBe(1)
  expect(new Set(actionIDs).size).toBe(2)
  expect(actionIDs).not.toContain([...callIDs][0])
})

test('non_retryable callee failure is not retried', async () => {
  let calls = 0

  const graph = makeGraph([worker()], {
    actions: {
      work: () => {
        calls++

        throw new Error('private')
      },
    },
  })

  const run = graph.start({ definition: caller({ retry: { maxAttempts: 3 } }) })

  await collect(run)

  expect(calls).toBe(1)
  expect(run.getState().status).toBe('error')
  expect(run.getState().error).toMatchObject({
    code: 'node_failed',
    node: 'a',
    reason: 'non_retryable',
    flow: 'worker',
  })
})

test('retry delay above suspendAfterMs suspends on the caller', async () => {
  let clock = 1000
  let calls = 0

  const definition = caller({
    retry: { maxAttempts: 2, backoff: { initialMs: 100 }, suspendAfterMs: 10 },
  })

  const graph = makeGraph([worker(), definition], {
    now: () => clock,
    actions: {
      work: () => {
        calls++

        if (calls === 1) {
          throw new FlowRetryableError({ message: 'again' })
        }

        return 'ok'
      },
    },
  })

  const first = graph.start({ definition })

  await collect(first)

  const suspended = roundTrip(first.getState())

  expect(suspended.status).toBe('suspended')
  expect(suspended.frames).toHaveLength(1)
  expect(suspended.pending).toEqual({
    node: 'c',
    reason: 'retry',
    resumeAt: '1970-01-01T00:00:01.100Z',
  })
  expect(suspended.frames[0]?.attempts.c).toMatchObject({
    count: 1,
    retryAt: '1970-01-01T00:00:01.100Z',
    lastFailure: { type: 'FlowRetryableError' },
  })

  clock = 1100

  const resumed = graph.resume({ runState: suspended, event: { type: 'retry' } })

  await collect(resumed)

  expect(resumed.getState().status).toBe('ended')
  expect(resumed.getState().frames[0]?.results.c).toEqual({ output: { value: 'ok' } })
  expect(calls).toBe(2)
})

test('totalTimeoutMs stops re-push', async () => {
  let clock = 1000
  let calls = 0

  const graph = makeGraph([worker()], {
    now: () => clock,
    actions: {
      work: () => {
        calls++

        throw new FlowRetryableError({ message: 'again' })
      },
    },
  })

  const definition = caller({
    retry: { maxAttempts: 3, totalTimeoutMs: 100 },
    onError: 'failed',
  })

  // The deadline passes between scheduling the retry and the re-push.
  const delayed = graph.start({ definition })

  delayed.events.on('retry', () => {
    clock += 1000
  })

  await collect(delayed)

  expect(calls).toBe(1)
  expect(delayed.getState().outcome).toBe('failed')
  expect(delayed.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'total_timeout', attempts: 1 },
  })

  // The deadline has already passed when the callee fails.
  calls = 0

  const late = makeGraph([worker()], {
    now: () => clock,
    actions: {
      work: () => {
        calls++
        clock += 1000

        throw new FlowRetryableError({ message: 'again' })
      },
    },
  }).start({ definition })

  await collect(late)

  expect(calls).toBe(1)
  expect(late.getState().outcome).toBe('failed')
  expect(late.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'total_timeout', attempts: 1 },
  })
})

test('totalTimeoutMs does not interrupt a suspended callee', async () => {
  let clock = 1000

  const ask = flow('worker', {
    ask: { kind: 'input', next: 'done' },
    done: { kind: 'end', output: { answer: { ref: ['results', 'ask'] } } },
  })

  const definition = caller({ retry: { maxAttempts: 2, totalTimeoutMs: 100 }, onError: 'failed' })
  const graph = makeGraph([ask, definition], { now: () => clock })
  const first = graph.start({ definition })

  await collect(first)

  expect(first.getState().status).toBe('suspended')
  expect(first.getState().frames).toHaveLength(2)

  clock += 10_000

  const resumed = graph.resume({
    runState: roundTrip(first.getState()),
    event: { type: 'value', value: 'yes' },
  })

  await collect(resumed)

  expect(resumed.getState().status).toBe('ended')
  expect(resumed.getState().outcome).toBe('done')
  expect(resumed.getState().frames[0]?.results.c).toEqual({ output: { answer: 'yes' } })
})

test('onError receives FlowCallError', async () => {
  const graph = makeGraph([worker()], {
    actions: {
      work: () => {
        throw new Error('private')
      },
    },
  })

  const run = graph.start({ definition: caller({ onError: 'failed' }) })

  await collect(run)

  expect(run.getState().status).toBe('ended')
  expect(run.getState().outcome).toBe('failed')
  expect(run.getState().frames).toHaveLength(1)
  expect(run.getState().frames[0]?.attempts).toEqual({})
  expect(run.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'non_retryable', attempts: 1 },
  })
})

test('callee reference failures enter the walk', async () => {
  const inner = flow('worker', {
    c: { kind: 'call', flow: 'nope', next: 'done' },
    done: { kind: 'end' },
  })

  // The preflight sees a `nope` flow; it is gone by the time the worker calls it.
  const preflight = createMapResolver([inner, flow('nope', { done: { kind: 'end' } })])
  const runtime = createMapResolver([inner])
  let lookups = 0

  const graph = createFlowGraph({
    resolver: {
      resolve: (id, version) => {
        lookups += 1

        // The preflight resolves `worker` and `nope` once each, breadth first.
        return (lookups <= 2 ? preflight : runtime).resolve(id, version)
      },
    },
  })

  const run = graph.start({ definition: caller({ onError: 'failed' }) })

  await collect(run)

  expect(run.getState().outcome).toBe('failed')
  expect(run.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'missing_flow', reason: 'non_retryable', attempts: 1 },
  })
})

const threeLevels = (rootExtra: Record<string, unknown> = {}) => {
  const leaf = flow('leaf', {
    a: { kind: 'action', name: 'work', next: 'done' },
    done: { kind: 'end' },
  })

  const middle = flow('middle', {
    c: { kind: 'call', flow: 'leaf', next: 'done' },
    done: { kind: 'end' },
  })

  const root = flow('root', {
    c: { kind: 'call', flow: 'middle', next: 'done', ...rootExtra },
    done: { kind: 'end', outcome: 'done' },
    failed: { kind: 'end', outcome: 'failed' },
  })

  const graph = makeGraph([leaf, middle], {
    actions: {
      work: () => {
        throw new Error('private')
      },
    },
  })

  return { graph, root }
}

test('failure propagates through frames and unwinds in one commit', async () => {
  const { graph, root } = threeLevels({ onError: 'failed' })
  const run = graph.start({ definition: root })
  const states = await collect(run)
  const transitions = states
    .slice(1)
    .map((state, index) => [states[index]?.frames.length, state.frames.length])

  expect(transitions.filter(([from, to]) => from === 3 && to === 1)).toHaveLength(1)
  expect(transitions.filter(([from, to]) => from === 3 && to === 2)).toHaveLength(0)
  expect(run.getState().outcome).toBe('failed')
  expect(run.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'non_retryable', attempts: 1 },
  })
})

test('unhandled callee failure keeps the stack and sets RunError.flow', async () => {
  const { graph, root } = threeLevels()
  const run = graph.start({ definition: root })

  await collect(run)

  const state = run.getState()

  expect(state.status).toBe('error')
  expect(state.frames.map((frame) => frame.flow.id)).toEqual(['root', 'middle', 'leaf'])
  expect(state.error).toMatchObject({
    code: 'node_failed',
    node: 'a',
    reason: 'non_retryable',
    flow: 'leaf',
  })
})

test('invalid_suspend in a callee ends the run despite caller onError', async () => {
  const ask = flow('worker', {
    ask: { kind: 'input', next: 'done' },
    done: { kind: 'end' },
  })

  const definition = caller({ onError: 'failed' })
  const graph = makeGraph([ask, definition])
  const first = graph.start({ definition })

  await collect(first)

  const declined = graph.resume({
    runState: roundTrip(first.getState()),
    event: { type: 'decline' },
  })

  await collect(declined)

  expect(declined.getState().status).toBe('error')
  expect(declined.getState().error).toMatchObject({ code: 'invalid_suspend', flow: 'worker' })
  expect(declined.getState().frames).toHaveLength(2)
})

test('flow-body loop callers pass failures down the walk', async () => {
  const leaf = flow('leaf', {
    a: { kind: 'action', name: 'work', next: 'done' },
    done: { kind: 'end' },
  })

  const middle = flow('middle', {
    l: {
      kind: 'loop',
      while: { path: ['input'], is: { isNull: false } },
      maxIterations: 2,
      body: { flow: 'leaf' },
      exit: 'done',
    },
    done: { kind: 'end' },
  })

  const root = flow('root', {
    c: { kind: 'call', flow: 'middle', next: 'done', onError: 'failed' },
    done: { kind: 'end', outcome: 'done' },
    failed: { kind: 'end', outcome: 'failed' },
  })

  const graph = makeGraph([leaf, middle], {
    actions: {
      work: () => {
        throw new Error('private')
      },
    },
  })

  const run = graph.start({ definition: root })

  await collect(run)

  expect(run.getState().outcome).toBe('failed')
  expect(run.getState().frames).toHaveLength(1)
  expect(run.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'non_retryable', attempts: 1 },
  })
})

test('call node recovery interruptions keep the default error shape', async () => {
  const callee = flow('worker', { done: { kind: 'end' } })
  const definition = caller({ retry: { maxAttempts: 2 }, onError: 'failed' })
  const graph = makeGraph([callee, definition])
  const run = graph.start({ definition })
  let checkpoint: RunState | undefined

  for await (const state of run) {
    if (state.inFlight?.node === 'c') {
      checkpoint = roundTrip(state)
      break
    }
  }

  const interrupted = roundTrip(checkpoint as RunState)
  const attempt = interrupted.frames[0]?.attempts.c

  if (attempt) {
    attempt.interruptions = 3
  }

  const recovered = graph.recover({ runState: interrupted })

  await collect(recovered)

  const result = recovered.getState().frames[0]?.results.c

  expect(recovered.getState().outcome).toBe('failed')
  expect(result).not.toMatchObject({ error: { type: 'FlowCallError' } })
  expect(result).toEqual({ error: { type: 'Error', reason: 'interrupted', attempts: 1 } })
})

test('call retries add attempts, not steps', async () => {
  let fail = true

  const graph = makeGraph([worker()], {
    actions: {
      work: () => {
        if (fail) {
          fail = false

          throw new FlowRetryableError({ message: 'again' })
        }

        return 'ok'
      },
    },
  })

  const definition = caller({ retry: { maxAttempts: 2 } })
  const retried = graph.start({ definition })
  const states = await collect(retried)

  fail = false

  const clean = graph.start({ definition })

  await collect(clean)

  // Caller entry, callee `a`, callee `done` and caller `done` are four steps; the retry only
  // re-enters callee `a` (one more callee step) and adds none for the call's second attempt.
  expect(clean.getState().steps).toBe(4)
  expect(retried.getState().steps).toBe(5)

  const scheduled = states.findIndex((state) => state.frames[0]?.attempts.c?.retryAt)
  const repushed = states.findIndex(
    (state, index) => index > scheduled && state.frames.length === 2,
  )

  expect(scheduled).toBeGreaterThan(0)
  expect(states[scheduled]?.frames).toHaveLength(1)
  expect(states[repushed]?.steps).toBe(states[scheduled]?.steps)
  expect(states[repushed]?.frames[0]?.attempts.c?.count).toBe(2)
})

test('a custom kind failing with a reference code is an ordinary node failure', async () => {
  const boom = defineNodeKind<{ kind: 'boom'; next: string }>({
    kind: 'boom',
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      additionalProperties: false,
      properties: { kind: { const: 'boom' }, next: { type: 'string' } },
    },
    targets: (node) => [{ path: ['next'], id: node.next }],
    execute: () => {
      throw new FlowNodeFailure({ code: 'missing_flow' })
    },
  })

  const failing = flow('worker', { b: { kind: 'boom', next: 'done' }, done: { kind: 'end' } })
  const graph = makeGraph([failing], { kinds: [boom] })
  const root = graph.start({ definition: failing })

  await collect(root)

  expect(root.getState().error).toMatchObject({ code: 'node_failed', reason: 'non_retryable' })

  const called = graph.start({ definition: caller({ onError: 'failed' }) })

  await collect(called)

  expect(called.getState().outcome).toBe('failed')
  expect(called.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'non_retryable', attempts: 1 },
  })
})

test('an exhausted caller call without onError passes the failure down', async () => {
  let calls = 0

  const middle = flow('middle', {
    c: { kind: 'call', flow: 'worker', version: 1, retry: { maxAttempts: 2 }, next: 'done' },
    done: { kind: 'end' },
  })

  const root = (extra: Record<string, unknown> = {}) =>
    flow('root', {
      c: {
        kind: 'call',
        flow: 'middle',
        version: 1,
        retry: { maxAttempts: 1 },
        next: 'done',
        ...extra,
      },
      done: { kind: 'end', outcome: 'done' },
      failed: { kind: 'end', outcome: 'failed' },
    })

  const graph = makeGraph([worker(), middle], {
    actions: {
      work: () => {
        calls++

        throw new FlowRetryableError({ message: 'again' })
      },
    },
  })

  const handled = graph.start({ definition: root({ onError: 'failed' }) })

  await collect(handled)

  // The middle call retries once, then the root call's onError takes the failure.
  expect(calls).toBe(2)
  expect(handled.getState().outcome).toBe('failed')
  expect(handled.getState().frames).toHaveLength(1)
  expect(handled.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'attempts', attempts: 1 },
  })

  calls = 0

  const unhandled = graph.start({ definition: root() })

  await collect(unhandled)

  expect(calls).toBe(2)
  expect(unhandled.getState().status).toBe('error')
  expect(unhandled.getState().frames.map((frame) => frame.flow.id)).toEqual([
    'root',
    'middle',
    'worker',
  ])
  expect(unhandled.getState().error).toMatchObject({
    code: 'node_failed',
    node: 'a',
    reason: 'attempts',
    flow: 'worker',
  })
})

test('a call retry that would start past the deadline routes to onError', async () => {
  let calls = 0

  const graph = makeGraph([worker()], {
    now: () => 1000,
    actions: {
      work: () => {
        calls++

        throw new FlowRetryableError({ message: 'again' })
      },
    },
  })

  // The deadline has not passed at failure time, but the next retry would start after it.
  const definition = caller({
    retry: { maxAttempts: 3, backoff: { initialMs: 500 }, totalTimeoutMs: 100 },
    onError: 'failed',
  })

  const run = graph.start({ definition })
  const states = await collect(run)

  expect(calls).toBe(1)
  expect(states.some((state) => state.frames[0]?.attempts.c?.retryAt)).toBe(false)
  expect(run.getState().outcome).toBe('failed')
  expect(run.getState().frames[0]?.results.c).toEqual({
    error: { type: 'FlowCallError', code: 'node_failed', reason: 'total_timeout', attempts: 1 },
  })
})
