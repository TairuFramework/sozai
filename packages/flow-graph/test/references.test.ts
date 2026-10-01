import type { JSONValue } from '@sozai/json'
import { expect, test } from 'vitest'

import type {
  FlowDefinition,
  FlowGraphOptions,
  FlowNode,
  FlowResolver,
  RunState,
} from '../src/index.js'
import {
  createFlowGraph,
  createMapResolver,
  defineNodeKind,
  digestDefinition,
  FlowStateError,
  FlowVersionMismatchError,
} from '../src/index.js'
import type { AssertStatesOptions } from './state-check.js'
import { assertStates, remember } from './state-check.js'

function makeGraph(definitions: Array<FlowDefinition>, options: FlowGraphOptions = {}) {
  definitions.forEach(remember)

  return createFlowGraph({ resolver: createMapResolver(definitions), ...options })
}

function flow(id: string, nodes: Record<string, FlowNode>, extra: Partial<FlowDefinition> = {}) {
  return remember({
    id,
    name: id,
    version: 1,
    start: Object.keys(nodes)[0] as string,
    nodes,
    ...extra,
  } as FlowDefinition)
}

/**
 * Resolver whose first lookup of each reference (the start preflight) reads `preflight`; later
 * lookups (push time) go to `runtime`, as if the flow set changed after the preflight.
 */
function drift(preflight: Array<FlowDefinition>, runtime: FlowResolver): FlowResolver {
  const before = createMapResolver(preflight)
  const seen = new Set<string>()

  return {
    resolve(id, version) {
      const key = JSON.stringify([id, version ?? null])

      if (seen.has(key)) {
        return runtime.resolve(id, version)
      }

      seen.add(key)

      return before.resolve(id, version)
    },
  }
}

const empty = createMapResolver([])

const placeholder = (id: string) => flow(id, { done: { kind: 'end' } })

async function collect(
  run: AsyncIterable<RunState>,
  options: AssertStatesOptions = {},
): Promise<Array<RunState>> {
  const states: Array<RunState> = []

  for await (const state of run) {
    states.push(state)
  }

  assertStates(states, options)

  return states
}

const roundTrip = (state: RunState): RunState => JSON.parse(JSON.stringify(state))

const caller = (target: string, extra: Record<string, unknown> = {}) =>
  flow('caller', {
    c: { kind: 'call', flow: target, next: 'done', ...extra },
    done: { kind: 'end', output: { got: { ref: ['results', 'c'] } } },
  })

test('call returns callee output and outcome to the caller', async () => {
  const callee = flow(
    'sum',
    {
      add: {
        kind: 'action',
        name: 'sum',
        args: { a: { ref: ['input', 'a'] }, b: { ref: ['input', 'b'] } },
        next: 'done',
      },
      done: { kind: 'end', outcome: 'ok', output: { total: { ref: ['results', 'add'] } } },
    },
    { input: { type: 'object', required: ['a', 'b'] } },
  )

  const root = flow('root', {
    c: {
      kind: 'call',
      flow: 'sum',
      version: 1,
      input: { a: { value: 1 }, b: { ref: ['input', 'b'] } },
      next: 'done',
    },
    done: {
      kind: 'end',
      outcome: 'root',
      output: { total: { ref: ['results', 'c', 'output', 'total'] } },
    },
  })

  const graph = makeGraph([callee], {
    actions: { sum: ({ args }) => (args.a as number) + (args.b as number) },
  })

  const run = graph.start({ definition: root, input: { b: 2 } })

  await collect(run)

  const state = run.getState()

  expect(state.status).toBe('ended')
  expect(state.frames).toHaveLength(1)
  expect(state.frames[0]?.results.c).toEqual({ output: { total: 3 }, outcome: 'ok' })
  expect(state.outcome).toBe('root')
  expect(state.output).toEqual({ total: 3 })
})

test('call to a callee without output yields output {}', async () => {
  const callee = flow('empty', { done: { kind: 'end' } })
  const run = makeGraph([callee]).start({ definition: caller('empty') })

  await collect(run)

  expect(run.getState().status).toBe('ended')
  expect(run.getState().frames[0]?.results.c).toEqual({ output: {} })
  expect(run.getState().output).toEqual({ got: { output: {} } })
})

test('nested calls unwind one frame at a time', async () => {
  const inner = flow('inner', {
    s: { kind: 'set', assign: [{ path: ['state', 'x'], value: { value: 1 } }], next: 'done' },
    done: { kind: 'end', output: { depth: { value: 3 } } },
  })

  const middle = flow('middle', {
    c: { kind: 'call', flow: 'inner', next: 'done' },
    done: { kind: 'end', output: { inner: { ref: ['results', 'c', 'output'] } } },
  })

  const run = makeGraph([inner, middle]).start({ definition: caller('middle') })
  const states = await collect(run)
  const lengths = states.map((state) => state.frames.length)
  const collapsed = lengths.filter((length, index) => length !== lengths[index - 1])

  expect(collapsed).toEqual([1, 2, 3, 2, 1])

  for (let index = 1; index < lengths.length; index++) {
    expect(Math.abs((lengths[index] as number) - (lengths[index - 1] as number))).toBeLessThan(2)
  }

  expect(run.getState().status).toBe('ended')
  expect(run.getState().output).toEqual({ got: { output: { inner: { depth: 3 } } } })
})

test('the same flow called twice gets fresh frames and invocation IDs', async () => {
  const seen: Array<string> = []

  const callee = flow('counter', {
    read: { kind: 'action', name: 'record', next: 'mark' },
    mark: {
      kind: 'set',
      assign: [{ path: ['state', 'seen'], value: { value: true } }],
      next: 'done',
    },
    done: { kind: 'end', output: { invocation: { ref: ['results', 'read'] } } },
  })

  const root = flow('root', {
    first: { kind: 'call', flow: 'counter', next: 'second' },
    second: { kind: 'call', flow: 'counter', next: 'done' },
    done: { kind: 'end' },
  })

  const graph = makeGraph([callee], {
    actions: {
      record: ({ invocationID }) => {
        seen.push(invocationID)

        return invocationID
      },
    },
  })

  const run = graph.start({ definition: root })
  const states = await collect(run)

  const pushes = states.filter(
    (state, index) => state.frames.length === 2 && states[index - 1]?.frames.length === 1,
  )

  expect(pushes).toHaveLength(2)

  for (const pushed of pushes) {
    const frame = pushed.frames[1]

    expect(frame?.state).toEqual({})
    expect(frame?.results).toEqual({})
    expect(frame?.attempts).toEqual({})
  }

  expect(seen).toHaveLength(2)
  expect(seen[0]).not.toBe(seen[1])

  const results = run.getState().frames[0]?.results

  expect(results?.first).toEqual({ output: { invocation: seen[0] } })
  expect(results?.second).toEqual({ output: { invocation: seen[1] } })
})

test('unversioned call pins the resolved version and digest', async () => {
  const v1 = flow('callee', { wait: { kind: 'input', next: 'done' }, done: { kind: 'end' } })
  const v2 = {
    ...flow('callee', { ask: { kind: 'input', next: 'done' }, done: { kind: 'end' } }),
    version: 2,
  }

  const run = makeGraph([v1, v2]).start({ definition: caller('callee') })

  await collect(run)

  const state = run.getState()

  expect(state.status).toBe('suspended')
  expect(state.frames[1]?.flow).toEqual({
    id: 'callee',
    version: 2,
    digest: digestDefinition(v2 as unknown as JSONValue),
  })
})

test('suspended callee resumes and returns to the caller', async () => {
  const ask = flow('ask', {
    ask: { kind: 'input', next: 'answered', decline: { to: 'refused' } },
    answered: { kind: 'end', outcome: 'answered', output: { answer: { ref: ['results', 'ask'] } } },
    refused: { kind: 'end', outcome: 'refused', output: { declined: { ref: ['results', 'ask'] } } },
  })

  const root = caller('ask')
  const graph = makeGraph([ask, root])

  const first = graph.start({ definition: root })

  await collect(first)

  const suspended = roundTrip(first.getState())

  expect(suspended.status).toBe('suspended')
  expect(suspended.frames).toHaveLength(2)
  expect(suspended.pending?.node).toBe('ask')

  const resumed = graph.resume({ runState: suspended, event: { type: 'value', value: 'yes' } })

  await collect(resumed)

  expect(resumed.getState().status).toBe('ended')
  expect(resumed.getState().frames).toHaveLength(1)
  expect(resumed.getState().frames[0]?.results.c).toEqual({
    output: { answer: 'yes' },
    outcome: 'answered',
  })

  const declined = graph.resume({
    runState: suspended,
    event: { type: 'decline', reason: 'cancel' },
  })

  await collect(declined)

  expect(declined.getState().status).toBe('ended')
  expect(declined.getState().frames[0]?.results.c).toEqual({
    output: { declined: { declined: 'cancel' } },
    outcome: 'refused',
  })
})

test('suspended callee resumes with its own invocation ID', async () => {
  const ids: Array<[string, string]> = []

  const wait = defineNodeKind<{ kind: 'wait'; next: string }>({
    kind: 'wait',
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      properties: { kind: { const: 'wait' }, next: { type: 'string' } },
      additionalProperties: false,
    },
    targets: (node) => [{ path: ['next'], id: node.next }],
    execute: (_node, ctx) => {
      ids.push(['execute', ctx.invocationID])

      return { suspend: {} }
    },
    resume: (node, ctx) => {
      ids.push(['resume', ctx.invocationID])

      return { next: node.next }
    },
  })

  const callee = flow('waiter', { w: { kind: 'wait', next: 'done' }, done: { kind: 'end' } })
  const root = caller('waiter')
  const graph = makeGraph([callee, root], { kinds: [wait] })

  const first = graph.start({ definition: root })

  await collect(first)

  const resumed = graph.resume({
    runState: roundTrip(first.getState()),
    event: { type: 'value', value: null },
  })

  await collect(resumed)

  expect(resumed.getState().status).toBe('ended')
  expect(ids).toHaveLength(2)
  expect(ids[1]?.[1]).toBe(ids[0]?.[1])
})

test('call exceeding maxDepth fails with max_depth', async () => {
  const recursive = flow('rec', {
    c: { kind: 'call', flow: 'rec', next: 'done' },
    done: { kind: 'end' },
  })

  const run = makeGraph([recursive], { maxDepth: 3 }).start({ definition: recursive })

  await collect(run)

  const state = run.getState()

  expect(state.status).toBe('error')
  expect(state.error?.code).toBe('max_depth')
  expect(state.frames).toHaveLength(3)
})

test('call to an unknown flow fails with missing_flow', async () => {
  const resolver = drift([placeholder('nope')], empty)
  const run = createFlowGraph({ resolver }).start({ definition: caller('nope') })

  await collect(run)

  expect(run.getState().status).toBe('error')
  expect(run.getState().error?.code).toBe('missing_flow')
  expect(run.getState().frames).toHaveLength(1)
})

test('call to a flow whose id or version differs fails with missing_flow', async () => {
  const other = flow('other', { done: { kind: 'end' } })
  const graph = createFlowGraph({
    resolver: drift([placeholder('wanted')], { resolve: () => other }),
  })

  const run = graph.start({ definition: caller('wanted') })

  await collect(run)

  expect(run.getState().error?.code).toBe('missing_flow')

  const pinned = createFlowGraph({
    resolver: drift(
      [{ ...placeholder('wanted'), version: 2 }],
      createMapResolver([placeholder('wanted')]),
    ),
  }).start({ definition: caller('wanted', { version: 2 }) })

  await collect(pinned)

  expect(pinned.getState().error?.code).toBe('missing_flow')
})

test('call to an invalid flow fails with invalid_flow', async () => {
  const broken = flow('broken', { done: { kind: 'end' } }, { start: 'missing' })
  const resolver = drift([placeholder('broken')], createMapResolver([broken]))
  const run = createFlowGraph({ resolver }).start({ definition: caller('broken') })

  await collect(run)

  expect(run.getState().status).toBe('error')
  expect(run.getState().error?.code).toBe('invalid_flow')
})

test('call input failing the callee input schema fails with invalid_input', async () => {
  const strict = flow(
    'strict',
    { done: { kind: 'end' } },
    { input: { type: 'object', required: ['name'] } },
  )

  const resolver = drift([placeholder('strict')], createMapResolver([strict]))
  const run = createFlowGraph({ resolver }).start({ definition: caller('strict') })

  await collect(run)

  expect(run.getState().status).toBe('error')
  expect(run.getState().error?.code).toBe('invalid_input')
})

test('call reference failures route to onError', async () => {
  const root = flow('root', {
    c: { kind: 'call', flow: 'nope', next: 'done', onError: 'failed' },
    done: { kind: 'end' },
    failed: { kind: 'end', outcome: 'failed' },
  })

  const run = createFlowGraph({ resolver: drift([placeholder('nope')], empty) }).start({
    definition: root,
  })

  await collect(run)

  expect(run.getState().status).toBe('ended')
  expect(run.getState().outcome).toBe('failed')
  expect(run.getState().frames[0]?.results.c).toMatchObject({
    error: { code: 'missing_flow', reason: 'non_retryable' },
  })
})

test('omitted call input is {}', async () => {
  const echo = flow(
    'echo',
    { done: { kind: 'end', output: { input: { ref: ['input'] } } } },
    { input: { type: 'object' } },
  )

  const run = makeGraph([echo]).start({ definition: caller('echo') })

  await collect(run)

  expect(run.getState().status).toBe('ended')
  expect(run.getState().frames[0]?.results.c).toEqual({ output: { input: {} } })
})

test('resolver object mutated after push still runs the pinned snapshot', async () => {
  const callee = flow('callee', {
    s: { kind: 'set', assign: [{ path: ['state', 'x'], value: { value: 1 } }], next: 'done' },
    done: { kind: 'end', outcome: 'original' },
  })

  const run = makeGraph([callee]).start({ definition: caller('callee') })

  for await (const state of run) {
    if (state.frames.length === 2) {
      callee.nodes.done = { kind: 'end', outcome: 'mutated' }
      callee.nodes.s = { kind: 'end', outcome: 'hijacked' }
    }
  }

  expect(run.getState().status).toBe('ended')
  expect(run.getState().frames[0]?.results.c).toEqual({ output: {}, outcome: 'original' })
})

test('start with references and no resolver throws TypeError', () => {
  const graph = createFlowGraph()

  expect(() => graph.start({ definition: caller('any') })).toThrow(TypeError)

  expect(() =>
    graph.start({
      definition: flow('g', { g: { kind: 'goto', flow: 'other' } }),
    }),
  ).toThrow(TypeError)

  expect(() =>
    graph.start({
      definition: flow('l', {
        l: {
          kind: 'loop',
          while: { path: ['input'], is: { isNull: false } },
          maxIterations: 1,
          body: { flow: 'other' },
          exit: 'done',
        },
        done: { kind: 'end' },
      }),
    }),
  ).toThrow(TypeError)
})

test('abort mid-callee keeps the stack', async () => {
  const controller = new AbortController()

  const callee = flow('slow', {
    wait: { kind: 'action', name: 'wait', next: 'done' },
    done: { kind: 'end' },
  })

  const graph = makeGraph([callee], {
    actions: {
      wait: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
          controller.abort()
        }),
    },
  })

  const result = await graph.run({ definition: caller('slow'), signal: controller.signal })

  expect(result.status).toBe('aborted')
  expect(result.runState.frames).toHaveLength(2)
  expect(result.runState.inFlight).toBeUndefined()
})

test('steps never exceed maxSteps across frames', async () => {
  const callee = flow('long', {
    a: { kind: 'set', assign: [{ path: ['state', 'a'], value: { value: 1 } }], next: 'b' },
    b: { kind: 'set', assign: [{ path: ['state', 'b'], value: { value: 1 } }], next: 'c' },
    c: { kind: 'set', assign: [{ path: ['state', 'c'], value: { value: 1 } }], next: 'done' },
    done: { kind: 'end' },
  })

  const run = makeGraph([callee], { maxSteps: 4 }).start({ definition: caller('long') })
  const states = await collect(run)

  expect(run.getState().status).toBe('error')
  expect(run.getState().error?.code).toBe('max_steps')

  for (const state of states) {
    expect(state.steps).toBeLessThanOrEqual(4)
  }
})

test('push and pop add no steps', async () => {
  const callee = flow('one', { done: { kind: 'end' } })
  const run = makeGraph([callee]).start({ definition: caller('one') })

  await collect(run)

  // call entry, callee end, caller end.
  expect(run.getState().steps).toBe(3)
})

test('call fires node:enter once for the call node and once for the callee start', async () => {
  const callee = flow('callee', {
    s: { kind: 'set', assign: [{ path: ['state', 'x'], value: { value: 1 } }], next: 'done' },
    done: { kind: 'end' },
  })

  const run = makeGraph([callee]).start({ definition: caller('callee') })
  const entered: Array<string> = []

  run.events.on('node:enter', ({ node, runState }) => {
    entered.push(`${runState.frames.length}:${node}`)
  })

  await collect(run)

  expect(run.getState().status).toBe('ended')
  expect(entered).toEqual(['1:c', '2:s', '2:done', '1:done'])
})

test('goto inside a callee returns to the original caller', async () => {
  const target = flow(
    'target',
    { done: { kind: 'end', outcome: 'target', output: { x: { ref: ['input', 'x'] } } } },
    { input: { type: 'object', required: ['x'] } },
  )

  const middle = flow('middle', {
    g: { kind: 'goto', flow: 'target', input: { x: { value: 5 } } },
  })

  const run = makeGraph([target, middle]).start({ definition: caller('middle') })
  const states = await collect(run)

  for (const state of states) {
    expect(state.frames.length).toBeLessThanOrEqual(2)
  }

  const replaced = states.find((state) => state.frames[1]?.flow.id === 'target')

  expect(replaced?.frames[1]).toMatchObject({
    node: 'done',
    input: { x: 5 },
    state: {},
    results: {},
    loops: {},
    attempts: {},
    continuation: { kind: 'call', callerNode: 'c', returnTo: 'done' },
  })

  expect(run.getState().status).toBe('ended')
  expect(run.getState().frames).toHaveLength(1)
  expect(run.getState().frames[0]?.results.c).toEqual({ output: { x: 5 }, outcome: 'target' })
})

test('root goto repins the root frame', async () => {
  const target = flow('target', {
    done: { kind: 'end', outcome: 'handed', output: { from: { ref: ['input', 'from'] } } },
  })

  const root = flow('root', {
    g: { kind: 'goto', flow: 'target', input: { from: { value: 'root' } } },
  })
  const run = makeGraph([target]).start({ definition: root })
  const states = await collect(run)

  expect(states.every((state) => state.frames.length === 1)).toBe(true)

  const state = run.getState()

  expect(state.status).toBe('ended')
  expect(state.frames[0]?.flow).toEqual({
    id: 'target',
    version: 1,
    digest: digestDefinition(target as unknown as JSONValue),
  })
  expect(state.frames[0]?.continuation).toBeUndefined()
  expect(state.outcome).toBe('handed')
  expect(state.output).toEqual({ from: 'root' })
})

test('resume after a root goto resolves the new pin', async () => {
  const target = flow('target', {
    ask: { kind: 'input', next: 'done' },
    done: { kind: 'end', outcome: 'answered', output: { answer: { ref: ['results', 'ask'] } } },
  })

  const root = flow('root', { g: { kind: 'goto', flow: 'target' } })
  const graph = makeGraph([root, target])
  const first = graph.start({ definition: root })

  await collect(first)

  const suspended = roundTrip(first.getState())

  expect(suspended.status).toBe('suspended')
  expect(suspended.frames[0]?.flow.id).toBe('target')

  const resumed = graph.resume({ runState: suspended, event: { type: 'value', value: 42 } })

  await collect(resumed)

  expect(resumed.getState().status).toBe('ended')
  expect(resumed.getState().outcome).toBe('answered')
  expect(resumed.getState().output).toEqual({ answer: 42 })
})

const counterLoop = (maxIterations: number, extra: Record<string, unknown> = {}) =>
  flow('root', {
    l: {
      kind: 'loop',
      while: { not: { path: ['results', 'l', 'output', 'n'], is: { greaterThanOrEqualTo: 3 } } },
      maxIterations,
      body: { flow: 'tick', input: { prev: { ref: ['results', 'l', 'output', 'n'] } } },
      exit: 'done',
      ...extra,
    },
    done: { kind: 'end', output: { n: { ref: ['results', 'l', 'output', 'n'] } } },
  })

const tick = flow('tick', {
  inc: { kind: 'action', name: 'inc', args: { prev: { ref: ['input', 'prev'] } }, next: 'done' },
  done: { kind: 'end', outcome: 'ticked', output: { n: { ref: ['results', 'inc'] } } },
})

test('loop with a flow body runs the body flow each iteration', async () => {
  const graph = makeGraph([tick], {
    actions: { inc: ({ args }) => ((args.prev as number | null) ?? 0) + 1 },
  })

  const run = graph.start({ definition: counterLoop(5) })
  const states = await collect(run)

  // The first push is the run's first commit, so it has no previous state.
  const pushes = states.filter(
    (state, index) => state.frames.length === 2 && (states[index - 1]?.frames.length ?? 1) === 1,
  )

  expect(pushes).toHaveLength(3)
  expect(pushes.map((state) => state.frames[0]?.loops.l)).toEqual([1, 2, 3])

  for (const pushed of pushes) {
    expect(pushed.frames[1]?.continuation).toEqual({
      kind: 'loopBody',
      callerNode: 'l',
      returnTo: 'l',
    })
  }

  const state = run.getState()

  expect(state.status).toBe('ended')
  expect(state.frames).toHaveLength(1)
  expect(state.frames[0]?.loops).toEqual({})
  expect(state.frames[0]?.results.l).toEqual({ output: { n: 3 }, outcome: 'ticked' })
  expect(state.output).toEqual({ n: 3 })
})

test('loop body receives its input', async () => {
  const seen: Array<unknown> = []

  const graph = makeGraph([tick], {
    actions: {
      inc: ({ args }) => {
        seen.push(args.prev)

        return ((args.prev as number | null) ?? 0) + 1
      },
    },
  })

  const run = graph.start({ definition: counterLoop(5) })

  await collect(run)

  expect(run.getState().status).toBe('ended')
  expect(seen.slice(1)).toEqual([1, 2])
  expect(seen[0] ?? null).toBeNull()
})

test('loop with a flow body still exhausts', async () => {
  const graph = makeGraph([tick], {
    actions: { inc: ({ args }) => ((args.prev as number | null) ?? 0) + 1 },
  })

  const failed = graph.start({ definition: counterLoop(2) })

  await collect(failed)

  expect(failed.getState().status).toBe('error')
  expect(failed.getState().error?.code).toBe('loop_exhausted')
  expect(failed.getState().frames).toHaveLength(1)

  const handled = graph.start({ definition: counterLoop(2, { onExhausted: 'done' }) })

  await collect(handled)

  expect(handled.getState().status).toBe('ended')
  expect(handled.getState().output).toEqual({ n: 2 })
  expect(handled.getState().frames[0]?.loops).toEqual({})
})

test('goto and flow-body loop reference failures end the run', async () => {
  const gotoRun = createFlowGraph({ resolver: drift([placeholder('nope')], empty) }).start({
    definition: flow('g', { g: { kind: 'goto', flow: 'nope' } }),
  })

  await collect(gotoRun)

  expect(gotoRun.getState().status).toBe('error')
  expect(gotoRun.getState().error?.code).toBe('missing_flow')
  expect(gotoRun.getState().frames[0]?.flow.id).toBe('g')

  const loopRun = createFlowGraph({ resolver: drift([tick], empty) }).start({
    definition: counterLoop(2),
  })

  await collect(loopRun)

  expect(loopRun.getState().status).toBe('error')
  expect(loopRun.getState().error?.code).toBe('missing_flow')
  expect(loopRun.getState().frames).toHaveLength(1)
})

test('suspended loop body resumes and returns to the loop', async () => {
  const ask = flow('ask', {
    ask: { kind: 'input', next: 'done' },
    done: { kind: 'end', output: { stop: { ref: ['results', 'ask'] } } },
  })

  const root = flow('root', {
    l: {
      kind: 'loop',
      while: { not: { path: ['results', 'l', 'output', 'stop'], is: { equalTo: true } } },
      maxIterations: 3,
      body: { flow: 'ask' },
      exit: 'done',
    },
    done: { kind: 'end', outcome: 'stopped' },
  })

  const graph = makeGraph([ask, root])
  const first = graph.start({ definition: root })

  await collect(first)

  const suspended = roundTrip(first.getState())

  expect(suspended.status).toBe('suspended')
  expect(suspended.frames).toHaveLength(2)
  expect(suspended.frames[1]?.continuation?.kind).toBe('loopBody')

  const again = graph.resume({ runState: suspended, event: { type: 'value', value: false } })

  await collect(again)

  const second = roundTrip(again.getState())

  expect(second.status).toBe('suspended')
  expect(second.frames[0]?.loops.l).toBe(2)
  expect(second.frames[0]?.results.l).toEqual({ output: { stop: false } })

  const done = graph.resume({ runState: second, event: { type: 'value', value: true } })

  await collect(done)

  expect(done.getState().status).toBe('ended')
  expect(done.getState().outcome).toBe('stopped')
  expect(done.getState().frames[0]?.loops).toEqual({})
})

const pushedState = async (
  graph: ReturnType<typeof makeGraph>,
  definition: FlowDefinition,
): Promise<RunState> => {
  for await (const state of graph.start({ definition })) {
    if (state.frames.length === 2) {
      return roundTrip(state)
    }
  }

  throw new Error('Missing push commit')
}

test.each([
  ['call returnTo', 'call', { returnTo: 'nowhere' }],
  ['call onError', 'call', { onError: 'done' }],
  ['loopBody returnTo', 'loopBody', { returnTo: 'done' }],
  ['loopBody onError', 'loopBody', { onError: 'done' }],
] as const)('recover rejects a tampered %s continuation', async (_label, kind, patch) => {
  const definition = kind === 'call' ? caller('tick') : counterLoop(5)
  const graph = makeGraph([tick, definition], {
    actions: { inc: ({ args }) => ((args.prev as number | null) ?? 0) + 1 },
  })

  const tampered = await pushedState(graph, definition)
  const continuation = tampered.frames[1]?.continuation

  expect(continuation?.kind).toBe(kind)
  Object.assign(continuation as object, patch)

  const run = graph.recover({ runState: tampered })

  await expect(run.next()).rejects.toBeInstanceOf(FlowStateError)
  expect(run.getState()).toEqual(tampered)
})

/** Resolver backed by `definitions` that answers each lookup after a macrotask. */
function delayed(definitions: Array<FlowDefinition>): FlowResolver & { lookups: Array<string> } {
  const map = createMapResolver(definitions)
  const lookups: Array<string> = []

  return {
    lookups,
    resolve: async (id, version) => {
      lookups.push(id)

      await new Promise((resolve) => setTimeout(resolve, 1))

      return map.resolve(id, version)
    },
  }
}

test('an async resolver serves the start preflight, push, replace and resume', async () => {
  const target = flow('target', {
    ask: { kind: 'input', next: 'done' },
    done: { kind: 'end', outcome: 'answered', output: { answer: { ref: ['results', 'ask'] } } },
  })

  const middle = flow('middle', { g: { kind: 'goto', flow: 'target', version: 1 } })

  const root = flow('root', {
    c: { kind: 'call', flow: 'middle', version: 1, next: 'done' },
    done: { kind: 'end', output: { got: { ref: ['results', 'c', 'output', 'answer'] } } },
  })

  const resolver = delayed([root, middle, target])
  const graph = createFlowGraph({ resolver })
  const first = graph.start({ definition: root })

  await collect(first)

  // Preflight resolves middle and target; the push and the replace resolve them again.
  expect(resolver.lookups).toEqual(['middle', 'target', 'middle', 'target'])

  const suspended = roundTrip(first.getState())

  expect(suspended.status).toBe('suspended')
  expect(suspended.frames.map((frame) => frame.flow.id)).toEqual(['root', 'target'])

  resolver.lookups.length = 0

  const resumed = graph.resume({ runState: suspended, event: { type: 'value', value: 7 } })

  await collect(resumed)

  expect(resolver.lookups).toEqual(['root', 'target'])
  expect(resumed.getState().status).toBe('ended')
  expect(resumed.getState().output).toEqual({ got: 7 })
})

/** Committed states of a loop-body run, with the tick action counted per graph. */
async function loopRun(state?: RunState) {
  let incs = 0

  const graph = makeGraph([tick, counterLoop(5)], {
    actions: {
      inc: ({ args }) => {
        incs++

        return ((args.prev as number | null) ?? 0) + 1
      },
    },
  })

  const run = state
    ? graph.recover({ runState: roundTrip(state) })
    : graph.start({ definition: counterLoop(5), runID: 'loop' })

  const states = await collect(run)

  return { states, final: run.getState(), incs }
}

test('recover mid loop body rejects phase 2 failures without committing', async () => {
  const { states } = await loopRun()
  const mid = roundTrip(
    states.find((state) => state.frames.length === 2 && state.frames[1]?.node === 'inc') ??
      (undefined as never),
  )

  const error = new Error('lookup failed')

  const failing = createFlowGraph({
    resolver: {
      resolve: () => {
        throw error
      },
    },
  }).recover({ runState: mid })

  await expect(failing.next()).rejects.toBe(error)
  expect(failing.getState()).toEqual(mid)

  const edited = createFlowGraph({
    resolver: createMapResolver([counterLoop(5), { ...tick, name: 'Edited' }]),
  }).recover({ runState: roundTrip(mid) })

  await expect(edited.next()).rejects.toBeInstanceOf(FlowVersionMismatchError)
  expect(edited.getState()).toEqual(mid)

  const invalid = roundTrip(mid)

  ;(invalid.frames[1] as { node: string }).node = 'missing'

  const broken = createFlowGraph({
    resolver: createMapResolver([counterLoop(5), tick]),
  }).recover({ runState: invalid })

  await expect(broken.next()).rejects.toBeInstanceOf(FlowStateError)
  expect(broken.getState()).toEqual(invalid)
})

test('recover before and after a loop-body push and pop', async () => {
  const reference = await loopRun()

  expect(reference.incs).toBe(3)

  // The second push: the state before it is the first pop, the state before that the callee end.
  const pushIndex = reference.states.findIndex(
    (state, index) => index > 0 && state.frames.length === 2 && state.frames[0]?.loops.l === 2,
  )

  const afterPush = reference.states[pushIndex]
  const afterPop = reference.states[pushIndex - 1]
  const beforePop = reference.states[pushIndex - 2]

  if (!afterPush || !afterPop || !beforePop) {
    throw new Error('Missing loop-body commits')
  }

  expect(beforePop.frames).toHaveLength(2)
  expect(beforePop.frames[1]?.node).toBe('done')
  expect(afterPop.frames).toHaveLength(1)
  expect(afterPop.frames[0]?.results.l).toEqual({ output: { n: 1 }, outcome: 'ticked' })
  expect(afterPush.frames[1]?.node).toBe('inc')

  for (const state of [beforePop, afterPop, afterPush]) {
    const recovered = await loopRun(state)

    // The first iteration's tick ran before the snapshot; iterations two and three run once each.
    expect(recovered.incs).toBe(2)
    expect(recovered.final.status).toBe('ended')
    expect(recovered.final.output).toEqual(reference.final.output)
    expect(recovered.final.steps).toBe(reference.final.steps)
    expect(recovered.final.invocation).toBe(reference.final.invocation)
  }
})

/** Root calls `mid`, which calls `leaf`; `leaf` suspends in frame 2. */
const threeLevels = () => {
  const leaf = flow('leaf', {
    ask: { kind: 'input', next: 'done' },
    done: { kind: 'end', outcome: 'leaf', output: { answer: { ref: ['results', 'ask'] } } },
  })

  const mid = flow('mid', {
    c: { kind: 'call', flow: 'leaf', version: 1, next: 'done' },
    done: { kind: 'end', output: { answer: { ref: ['results', 'c', 'output', 'answer'] } } },
  })

  const root = flow('root', {
    c: { kind: 'call', flow: 'mid', version: 1, next: 'done' },
    done: { kind: 'end', output: { answer: { ref: ['results', 'c', 'output', 'answer'] } } },
  })

  return { leaf, mid, root }
}

test('a digest mismatch on a lower non-root frame rejects with FlowVersionMismatchError', async () => {
  const { leaf, mid, root } = threeLevels()
  const first = makeGraph([leaf, mid, root]).start({ definition: root })

  await collect(first)

  const suspended = roundTrip(first.getState())

  expect(suspended.frames.map((frame) => frame.flow.id)).toEqual(['root', 'mid', 'leaf'])

  const run = createFlowGraph({
    resolver: createMapResolver([root, { ...mid, name: 'Edited' }, leaf]),
  }).resume({ runState: suspended, event: { type: 'value', value: 1 } })

  await expect(run.next()).rejects.toBeInstanceOf(FlowVersionMismatchError)
  expect(run.getState()).toEqual(suspended)
})

test('a callee suspended in frame 2 recovers and resumes after a JSON round trip', async () => {
  const { leaf, mid, root } = threeLevels()
  const graph = makeGraph([leaf, mid, root])
  const reference = graph.start({ definition: root })
  const states = await collect(reference)

  // The last running commit before the suspension: leaf entered at frame 2.
  const suspendedIndex = states.findIndex((state) => state.status === 'suspended')
  const entering = roundTrip(states[suspendedIndex - 1] ?? (undefined as never))

  expect(entering.status).toBe('running')
  expect(entering.frames).toHaveLength(3)

  const recovered = createFlowGraph({ resolver: createMapResolver([leaf, mid, root]) }).recover({
    runState: entering,
  })

  await collect(recovered)

  const suspended = roundTrip(recovered.getState())

  expect(suspended.status).toBe('suspended')
  expect(suspended.pending?.node).toBe('ask')
  expect(suspended.frames).toEqual(reference.getState().frames)

  const resumed = createFlowGraph({ resolver: createMapResolver([leaf, mid, root]) }).resume({
    runState: suspended,
    event: { type: 'value', value: 'deep' },
  })

  await collect(resumed)

  expect(resumed.getState().status).toBe('ended')
  expect(resumed.getState().frames).toHaveLength(1)
  expect(resumed.getState().output).toEqual({ answer: 'deep' })
})

test('goto balances node:enter and node:exit and takes one step', async () => {
  const target = flow('target', { done: { kind: 'end', outcome: 'handed' } })
  const middle = flow('middle', { g: { kind: 'goto', flow: 'target', version: 1 } })
  const graph = makeGraph([target, middle])

  const observe = (run: ReturnType<typeof graph.start>) => {
    const events: Array<string> = []

    run.events.on('node:enter', ({ node, runState }) => {
      events.push(`enter:${runState.frames.length}:${node}`)
    })
    run.events.on('node:exit', ({ node, runState }) => {
      events.push(`exit:${runState.frames.length}:${node}`)
    })
    run.events.on('end', () => {
      events.push('end')
    })

    return events
  }

  const rootRun = graph.start({ definition: flow('root', { g: middle.nodes.g as FlowNode }) })
  const rootEvents = observe(rootRun)

  await collect(rootRun)

  expect(rootEvents).toEqual(['enter:1:g', 'exit:1:g', 'enter:1:done', 'end'])
  // goto, then the target end.
  expect(rootRun.getState().steps).toBe(2)

  const calleeRun = graph.start({ definition: caller('middle') })
  const calleeEvents = observe(calleeRun)

  await collect(calleeRun)

  expect(calleeEvents).toEqual([
    'enter:1:c',
    'enter:2:g',
    'exit:2:g',
    'enter:2:done',
    'exit:1:c',
    'enter:1:done',
    'end',
  ])
  // call entry, goto, target end (with the pop), caller end.
  expect(calleeRun.getState().steps).toBe(4)
})

test('state checks accept attempts of a retrying custom kind', async () => {
  const fetch = defineNodeKind<{ kind: 'fetch'; next: string }>({
    kind: 'fetch',
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      properties: { kind: { const: 'fetch' }, next: { type: 'string' } },
      additionalProperties: false,
    },
    retries: true,
    targets: (node) => [{ path: ['next'], id: node.next }],
    execute: (node) => ({ next: node.next, result: 1 }),
  })

  const callee = flow('fetcher', { f: { kind: 'fetch', next: 'done' }, done: { kind: 'end' } })
  const run = makeGraph([callee], { kinds: [fetch] }).start({ definition: caller('fetcher') })
  const states = await collect(run, { kinds: [fetch] })

  expect(states.some((state) => state.frames[1]?.attempts.f !== undefined)).toBe(true)
  expect(run.getState().status).toBe('ended')
})

test('end passes through a nested flow outcome reference', async () => {
  const inner = flow('inner', { done: { kind: 'end', outcome: 'accepted' } })
  const parent = flow('parent', {
    inner: { kind: 'call', flow: 'inner', next: 'done' },
    done: { kind: 'end', outcome: { ref: ['results', 'inner', 'outcome'] } },
  })

  const run = makeGraph([inner]).start({ definition: parent })

  await collect(run)

  expect(run.getState().status).toBe('ended')
  expect(run.getState().outcome).toBe('accepted')
  expect(run.getState().frames[0]?.results.inner).toEqual({ output: {}, outcome: 'accepted' })
})

test.each([null, 42, true, [], {}])(
  'end rejects a non-string resolved outcome: %j',
  async (value) => {
    const definition = flow('invalid-outcome', {
      done: { kind: 'end', outcome: { ref: ['input', 'outcome'] } },
    })

    const run = makeGraph([]).start({ definition, input: { outcome: value } })

    await collect(run)

    expect(run.getState().status).toBe('error')
    expect(run.getState().error).toMatchObject({
      code: 'invalid_value',
      node: 'done',
      lastFailure: { type: 'FlowNodeFailure' },
    })
    expect(run.getState().outcome).toBeUndefined()
  },
)
