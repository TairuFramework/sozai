import { expect, test, vi } from 'vitest'

import { createFlowGraph, FlowResumeError, FlowRetryableError } from '../src/index.js'

const definition = {
  id: 'r',
  name: 'Retry',
  version: 1,
  start: 'a',
  nodes: {
    a: {
      kind: 'action',
      name: 'work',
      retry: { maxAttempts: 2, backoff: { initialMs: 100 }, suspendAfterMs: 10 },
      next: 'end',
    },
    end: { kind: 'end' },
  },
}

test('retry suspension commits a fixed retryAt and rejects an early resume', async () => {
  let clock = 1000
  let calls = 0

  const graph = createFlowGraph({
    now: () => clock,
    actions: {
      work: async () => {
        calls++

        if (calls === 1) {
          throw new FlowRetryableError({ message: 'secret' })
        }

        return 2
      },
    },
  })

  const first = await graph.run({ definition })

  expect(first.status).toBe('suspended')
  expect(first.pending?.resumeAt).toBe('1970-01-01T00:00:01.100Z')
  expect(first.runState.frames[0]?.attempts.a?.lastFailure).toEqual({ type: 'FlowRetryableError' })

  const persisted = JSON.parse(JSON.stringify(first.runState))

  expect(() => graph.resume({ definition, runState: persisted, event: { type: 'retry' } })).toThrow(
    FlowResumeError,
  )
  expect(persisted).toEqual(first.runState)

  clock = 1100

  const resumed = graph.resume({ definition, runState: persisted, event: { type: 'retry' } })

  for await (const _state of resumed) {
    /* drain */
  }

  expect(resumed.getState().status).toBe('ended')
  expect(calls).toBe(2)
})

test('entry, checkpoint, retry suspension and resume keep one invocation', async () => {
  let clock = 1000
  const seen: Array<{ attempt: number; invocationID: string }> = []

  const graph = createFlowGraph({
    now: () => clock,
    actions: {
      work: async ({ attempt, invocationID }) => {
        seen.push({ attempt, invocationID })

        if (attempt === 1) {
          throw new FlowRetryableError({ message: 'retry' })
        }

        return 1
      },
    },
  })

  const run = graph.start({ definition, runID: 'fixed' })
  const commits = []

  for await (const state of run) {
    commits.push(state)
  }

  expect(
    commits.map((state) => [
      state.revision,
      state.steps,
      state.frames[0]?.invocation,
      state.frames[0]?.attempts.a?.count,
      state.inFlight?.attempt,
      state.status,
    ]),
  ).toEqual([
    [1, 1, 1, 0, undefined, 'running'],
    [2, 1, 1, 1, 1, 'running'],
    [3, 1, 1, 1, undefined, 'suspended'],
  ])
  expect(commits[2]?.frames[0]?.attempts.a?.invocationID).toBe('fixed:0:1')
  expect(commits[2]?.frames[0]?.attempts.a?.retryAt).toBe('1970-01-01T00:00:01.100Z')

  const suspended = commits[2]

  if (!suspended) {
    throw new Error('Missing retry suspension commit')
  }

  clock = 1100

  const resumed = graph.resume({ definition, runState: suspended, event: { type: 'retry' } })
  const rest = []

  for await (const state of resumed) {
    rest.push(state)
  }

  expect(
    rest.map((state) => [
      state.revision,
      state.steps,
      state.frames[0]?.invocation,
      state.frames[0]?.attempts.a?.count,
      state.inFlight?.attempt,
      state.status,
    ]),
  ).toEqual([
    [4, 1, 1, 2, 2, 'running'],
    [5, 1, 1, undefined, undefined, 'running'],
    [6, 2, 2, undefined, undefined, 'ended'],
  ])
  expect(seen).toEqual([
    { attempt: 1, invocationID: 'fixed:0:1' },
    { attempt: 2, invocationID: 'fixed:0:1' },
  ])
})

test('non-retryable failure terminates without scheduling another attempt', async () => {
  let calls = 0

  const graph = createFlowGraph({
    actions: {
      work: async () => {
        calls++

        throw new Error('do not retry')
      },
    },
  })

  const result = await graph.run({ definition })

  expect(result.error?.reason).toBe('non_retryable')
  expect(result.error?.attempts).toBe(1)
  expect(result.pending).toBeUndefined()
  expect(calls).toBe(1)
})

test('terminal failure commits after its checkpoint without exceeding maxAttempts', async () => {
  const graph = createFlowGraph({
    actions: {
      work: async () => {
        throw new FlowRetryableError({})
      },
    },
  })

  const def = {
    ...definition,
    nodes: {
      ...definition.nodes,
      a: { ...definition.nodes.a, retry: { maxAttempts: 2 } },
    },
  }

  const states = []

  for await (const state of graph.start({ definition: def, runID: 'bounded' })) {
    states.push(state)
  }

  expect(
    states.map((state) => [
      state.revision,
      state.steps,
      state.frames[0]?.invocation,
      state.frames[0]?.attempts.a?.count,
      state.status,
    ]),
  ).toEqual([
    [1, 1, 1, 0, 'running'],
    [2, 1, 1, 1, 'running'],
    [3, 1, 1, 1, 'running'],
    [4, 1, 1, 2, 'running'],
    [5, 1, 1, 2, 'error'],
  ])
  expect(states.every((state) => (state.frames[0]?.attempts.a?.count ?? 0) <= 2)).toBe(true)
  expect(states[4]?.error?.reason).toBe('attempts')
})

test('recover replays an in-flight attempt with the same invocation and count', async () => {
  const seen: Array<string> = []

  const graph = createFlowGraph({
    actions: {
      work: async ({ invocationID }) => {
        seen.push(invocationID)

        return 1
      },
    },
  })

  const def = {
    ...definition,
    nodes: { ...definition.nodes, a: { ...definition.nodes.a, retry: { maxAttempts: 1 } } },
  }

  const run = graph.start({ definition: def })

  await run.next()

  const checkpoint = (await run.next()).value

  expect(checkpoint.inFlight?.attempt).toBe(1)

  const recovered = graph.recover({ definition: def, runState: checkpoint })
  const replay = (await recovered.next()).value

  expect(replay.frames[0]?.attempts.a?.count).toBe(1)
  expect(replay.frames[0]?.attempts.a?.interruptions).toBe(1)

  for await (const _state of recovered) {
    /* drain */
  }

  expect(seen).toEqual([checkpoint.inFlight?.invocationID])
  expect(recovered.getState().status).toBe('ended')
})

test('attempt timeout rejects a handler that ignores its signal', async () => {
  vi.useFakeTimers()

  try {
    let resolveLate: ((value: number) => void) | undefined

    const graph = createFlowGraph({
      actions: {
        work: async () =>
          new Promise<number>((resolve) => {
            resolveLate = resolve
          }),
      },
    })

    const def = {
      ...definition,
      nodes: {
        ...definition.nodes,
        a: { ...definition.nodes.a, retry: { maxAttempts: 1, attemptTimeoutMs: 25 } },
      },
    }

    const pending = graph.run({ definition: def })

    await vi.advanceTimersByTimeAsync(25)

    const result = await pending

    expect(result.status).toBe('error')
    expect(result.error?.lastFailure?.type).toBe('TimeoutInterruption')

    resolveLate?.(1)

    await Promise.resolve()

    expect(result.runState.status).toBe('error')
  } finally {
    vi.useRealTimers()
  }
})

test.each([
  { attemptTimeoutMs: 10, totalTimeoutMs: 50, expectedReason: 'attempts' },
  { attemptTimeoutMs: 50, totalTimeoutMs: 10, expectedReason: 'total_timeout' },
])(
  'the earliest timeout wins with $expectedReason',
  async ({ attemptTimeoutMs, totalTimeoutMs, expectedReason }) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    try {
      const graph = createFlowGraph({
        now: () => Date.now(),
        actions: { work: async () => new Promise<number>(() => {}) },
      })

      const def = {
        ...definition,
        nodes: {
          ...definition.nodes,
          a: { ...definition.nodes.a, retry: { maxAttempts: 1, attemptTimeoutMs, totalTimeoutMs } },
        },
      }

      const pending = graph.run({ definition: def })

      await vi.advanceTimersByTimeAsync(10)

      const result = await pending

      expect(result.status).toBe('error')
      expect(result.error?.reason).toBe(expectedReason)
      expect(result.error?.lastFailure?.type).toBe('TimeoutInterruption')
    } finally {
      vi.useRealTimers()
    }
  },
)

test('retry uses the saved policy after defaults change in another graph', async () => {
  let clock = 0
  let calls = 0

  const def = {
    ...definition,
    nodes: { ...definition.nodes, a: { kind: 'action', name: 'work', next: 'end' } },
  }

  const actions = {
    work: async () => {
      calls++

      throw new FlowRetryableError({ message: 'private' })
    },
  }

  const first = await createFlowGraph({
    now: () => clock,
    actions,
    retryDefaults: { action: { maxAttempts: 2, backoff: { initialMs: 20 }, suspendAfterMs: 0 } },
  }).run({ definition: def })

  expect(first.status).toBe('suspended')
  expect(first.runState.frames[0]?.attempts.a?.policy.maxAttempts).toBe(2)

  clock = 20

  const resumed = createFlowGraph({
    now: () => clock,
    actions,
    retryDefaults: { action: { maxAttempts: 10 } },
  }).resume({ definition: def, runState: first.runState, event: { type: 'retry' } })

  for await (const _state of resumed) {
    /* drain */
  }

  expect(resumed.getState().error?.attempts).toBe(2)
  expect(calls).toBe(2)
})

test('late retry exhausts the total deadline without another action call', async () => {
  let clock = 0
  let calls = 0

  const def = {
    ...definition,
    nodes: {
      ...definition.nodes,
      a: {
        ...definition.nodes.a,
        retry: {
          maxAttempts: 3,
          totalTimeoutMs: 50,
          backoff: { initialMs: 20 },
          suspendAfterMs: 0,
        },
      },
    },
  }

  const graph = createFlowGraph({
    now: () => clock,
    actions: {
      work: async () => {
        calls++

        throw new FlowRetryableError({})
      },
    },
  })

  const first = await graph.run({ definition: def })

  expect(first.status).toBe('suspended')

  clock = 60

  const resumed = graph.resume({
    definition: def,
    runState: first.runState,
    event: { type: 'retry' },
  })

  for await (const _state of resumed) {
    /* drain */
  }

  expect(resumed.getState().error?.reason).toBe('total_timeout')
  expect(calls).toBe(1)
})

test('a retry wait beyond the total deadline is never scheduled', async () => {
  const def = {
    ...definition,
    nodes: {
      ...definition.nodes,
      a: {
        ...definition.nodes.a,
        retry: {
          maxAttempts: 3,
          totalTimeoutMs: 50,
          backoff: { initialMs: 60 },
          suspendAfterMs: 0,
        },
      },
    },
  }

  const graph = createFlowGraph({
    now: () => 0,
    actions: {
      work: async () => {
        throw new FlowRetryableError({})
      },
    },
  })

  const result = await graph.run({ definition: def })

  expect(result.status).toBe('error')
  expect(result.error?.reason).toBe('total_timeout')
  expect(result.pending).toBeUndefined()
})

test('recovery stops after maxInterruptions without consuming another attempt', async () => {
  let calls = 0

  const def = {
    ...definition,
    nodes: {
      ...definition.nodes,
      a: { ...definition.nodes.a, retry: { maxAttempts: 1, maxInterruptions: 0 } },
    },
  }

  const graph = createFlowGraph({
    actions: {
      work: async () => {
        calls++

        return 1
      },
    },
  })

  const run = graph.start({ definition: def })

  await run.next()

  const checkpoint = (await run.next()).value
  const recovered = graph.recover({ definition: def, runState: checkpoint })

  for await (const _state of recovered) {
    /* drain */
  }

  expect(recovered.getState().error?.reason).toBe('interrupted')
  expect(recovered.getState().error?.attempts).toBe(1)
  expect(calls).toBe(0)
})

test('FlowRetryableError afterMs controls the saved retryAt', async () => {
  const def = {
    ...definition,
    nodes: {
      ...definition.nodes,
      a: {
        ...definition.nodes.a,
        retry: { maxAttempts: 2, backoff: { initialMs: 20 }, suspendAfterMs: 0 },
      },
    },
  }

  const graph = createFlowGraph({
    now: () => 1000,
    actions: {
      work: async () => {
        throw new FlowRetryableError({ message: 'private', afterMs: 80 })
      },
    },
  })

  const result = await graph.run({ definition: def })

  expect(result.pending?.resumeAt).toBe('1970-01-01T00:00:01.080Z')
})

test('resume uses committed jitter without drawing random again', async () => {
  let clock = 0
  let calls = 0

  const def = {
    ...definition,
    nodes: {
      ...definition.nodes,
      a: {
        ...definition.nodes.a,
        retry: { maxAttempts: 2, backoff: { initialMs: 100, jitter: true }, suspendAfterMs: 0 },
      },
    },
  }

  const actions = {
    work: async () => {
      calls++

      if (calls === 1) {
        throw new FlowRetryableError({})
      }

      return 1
    },
  }

  const first = await createFlowGraph({ now: () => clock, random: () => 0.5, actions }).run({
    definition: def,
  })

  expect(first.pending?.resumeAt).toBe('1970-01-01T00:00:00.050Z')

  clock = 50

  const random = vi.fn(() => 0.9)

  const second = createFlowGraph({ now: () => clock, random, actions }).resume({
    definition: def,
    runState: first.runState,
    event: { type: 'retry' },
  })

  for await (const _state of second) {
    /* drain */
  }

  expect(second.getState().status).toBe('ended')
  expect(random).not.toHaveBeenCalled()
})

test('recover waits for a committed retryAt before checkpointing the next attempt', async () => {
  vi.useFakeTimers()

  try {
    let clock = 0
    let calls = 0

    const def = {
      ...definition,
      nodes: {
        ...definition.nodes,
        a: {
          ...definition.nodes.a,
          retry: { maxAttempts: 2, backoff: { initialMs: 100, jitter: true } },
        },
      },
    }

    const graph = createFlowGraph({
      now: () => clock,
      random: () => 1,
      actions: {
        work: async () => {
          calls++

          if (calls === 1) {
            throw new FlowRetryableError({})
          }

          return 1
        },
      },
    })

    const run = graph.start({ definition: def })

    await run.next()
    await run.next()

    const failed = (await run.next()).value

    expect(failed.frames[0]?.attempts.a?.retryAt).toBe('1970-01-01T00:00:00.100Z')

    const random = vi.fn(() => 0.25)

    const recovered = createFlowGraph({
      now: () => clock,
      random,
      actions: {
        work: async () => {
          calls++

          return 1
        },
      },
    }).recover({ definition: def, runState: failed })

    const waiting = recovered.next()

    await vi.advanceTimersByTimeAsync(99)

    expect(recovered.getState().revision).toBe(failed.revision)

    clock = 100

    await vi.advanceTimersByTimeAsync(1)

    const checkpoint = (await waiting).value

    expect(checkpoint.frames[0]?.attempts.a?.count).toBe(2)

    for await (const _state of recovered) {
      /* drain */
    }

    expect(recovered.getState().status).toBe('ended')
    expect(random).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

test('describeError sanitizes non-finite metadata and restores a missing type', async () => {
  const graph = createFlowGraph({
    kinds: [
      {
        kind: 'fail',
        schema: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { const: 'fail' } },
          additionalProperties: false,
        },
        targets: () => [{ path: ['next'], id: 'end' }],
        retries: true,
        execute: () => {
          throw new Error('private')
        },
        describeError: () => ({
          type: undefined as unknown as string,
          status: Number.NaN,
          retryAfterMs: Number.POSITIVE_INFINITY,
        }),
      },
    ],
  })

  const result = await graph.run({
    definition: {
      id: 'meta',
      name: 'Meta',
      version: 1,
      start: 'fail',
      nodes: { fail: { kind: 'fail' }, end: { kind: 'end' } },
    },
  })

  expect(result.error?.lastFailure).toEqual({ type: 'Error' })
  expect(JSON.stringify(result.runState)).not.toContain('private')
})

test('late completion of an abandoned attempt cannot replace the next attempt result', async () => {
  vi.useFakeTimers()

  try {
    const pending: Array<(value: number) => void> = []

    const graph = createFlowGraph({
      actions: {
        work: async () =>
          new Promise<number>((resolve) => {
            pending.push(resolve)
          }),
      },
    })

    const def = {
      id: 'late',
      name: 'Late',
      version: 1,
      start: 'a',
      nodes: {
        a: {
          kind: 'action',
          name: 'work',
          next: 'end',
          retry: { maxAttempts: 2, attemptTimeoutMs: 10 },
        },
        end: { kind: 'end', output: { value: { ref: ['results', 'a'] } } },
      },
    }

    const run = graph.run({ definition: def })

    await vi.advanceTimersByTimeAsync(10)

    expect(pending).toHaveLength(2)

    pending[0]?.(111)

    await Promise.resolve()

    pending[1]?.(222)

    const result = await run

    expect(result.output).toEqual({ value: 222 })
  } finally {
    vi.useRealTimers()
  }
})
