import { expect, test } from 'vitest'

import { createFlowGraph, defineNodeKind, FlowRetryableError } from '../src/index.js'

type Ask = { kind: 'ask'; next: string; prompt: string }

const ask = defineNodeKind<Ask>({
  kind: 'ask',
  schema: {
    type: 'object',
    required: ['kind', 'next', 'prompt'],
    additionalProperties: false,
    properties: { kind: { const: 'ask' }, next: { type: 'string' }, prompt: { type: 'string' } },
  },
  targets: (node) => [{ path: ['next'], id: node.next }],
  resultSchema: () => ({
    type: 'object',
    properties: { answer: { type: 'string' } },
    additionalProperties: false,
  }),
  execute: (node) => ({ suspend: { prompt: node.prompt, data: { job: 'j1' } } }),
  resume: (node, ctx, event) => {
    expect(ctx.pending?.data).toEqual({ job: 'j1' })

    return { next: node.next, result: { answer: event.type === 'value' ? event.value : 'late' } }
  },
})

test('extension kind suspends and resumes with continuation data', async () => {
  const definition = {
    id: 'ext',
    name: 'Extension',
    version: 1,
    start: 'ask',
    nodes: {
      ask: { kind: 'ask', next: 'end', prompt: 'hello' },
      end: { kind: 'end', output: { answer: { ref: ['results', 'ask', 'answer'] } } },
    },
  }

  const graph = createFlowGraph({ kinds: [ask] })
  const first = await graph.run({ definition })

  expect(first.pending?.data).toEqual({ job: 'j1' })

  const resumed = graph.resume({
    definition,
    runState: JSON.parse(JSON.stringify(first.runState)),
    event: { type: 'value', value: 'yes' },
  })

  for await (const _state of resumed) {
    /* drain */
  }

  expect(resumed.getState().output).toEqual({ answer: 'yes' })
})

test('checker validates cross-node result paths and dominance', () => {
  const graph = createFlowGraph({ kinds: [ask] })

  const definition = {
    id: 'ext',
    name: 'Extension',
    version: 1,
    start: 'branch',
    nodes: {
      branch: {
        kind: 'branch',
        cases: [{ when: { path: ['input'], is: { isNull: true } }, to: 'ask' }],
        default: 'end',
      },
      ask: { kind: 'ask', next: 'end', prompt: 'hello' },
      end: { kind: 'end', output: { answer: { ref: ['results', 'ask', 'missing'] } } },
    },
  }

  const issues = graph.check(definition).issues

  expect(issues.map((issue) => issue.code)).toContain('invalid_result_path')
  expect(issues.map((issue) => issue.code)).toContain('result_maybe_missing')
})

test('kind registration rejects a resultSchema top-level error field', () => {
  expect(() =>
    createFlowGraph({
      kinds: [
        {
          ...ask,
          resultSchema: () => ({ type: 'object', properties: { error: { type: 'string' } } }),
        },
      ],
    }),
  ).toThrow(TypeError)
})

test('recover accepts an extension kind with a snapshotted retry default', async () => {
  const task = defineNodeKind({
    kind: 'task',
    retries: true,
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      properties: { kind: { const: 'task' }, next: { type: 'string' } },
      additionalProperties: false,
    },
    targets: (node: { kind: 'task'; next: string }) => [{ path: ['next'], id: node.next }],
    execute: (node) => ({ next: node.next }),
  })

  const definition = {
    id: 'task',
    name: 'Task',
    version: 1,
    start: 'task',
    nodes: { task: { kind: 'task', next: 'end' }, end: { kind: 'end' } },
  }

  const graph = createFlowGraph({ kinds: [task], retryDefaults: { task: { maxAttempts: 1 } } })
  const run = graph.start({ definition })

  await run.next()

  const checkpoint = (await run.next()).value
  const recovered = graph.recover({ definition, runState: checkpoint })

  for await (const _state of recovered) {
    /* drain */
  }

  expect(recovered.getState().status).toBe('ended')
})

test('a retrying kind keeps its invocation and policy while suspended', async () => {
  const seen: Array<string> = []

  const kind = defineNodeKind({
    kind: 'job',
    retries: true,
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      properties: { kind: { const: 'job' }, next: { type: 'string' } },
      additionalProperties: false,
    },
    targets: (node: { kind: 'job'; next: string }) => [{ path: ['next'], id: node.next }],
    execute: (_node, ctx) => {
      seen.push(ctx.invocationID)

      return { suspend: { data: { id: 'external' } } }
    },
    resume: (node, ctx) => {
      seen.push(ctx.invocationID)

      return { next: node.next, result: ctx.pending?.data ?? null }
    },
  })

  const definition = {
    id: 'job',
    name: 'Job',
    version: 1,
    start: 'job',
    nodes: { job: { kind: 'job', next: 'end' }, end: { kind: 'end' } },
  }

  const graph = createFlowGraph({ kinds: [kind], retryDefaults: { job: { maxAttempts: 2 } } })
  const first = await graph.run({ definition })

  expect(first.runState.frames[0]?.attempts.job?.count).toBe(1)

  const second = graph.resume({
    definition,
    runState: first.runState,
    event: { type: 'value', value: 1 },
  })

  for await (const _state of second) {
    /* drain */
  }

  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe(seen[1])
  expect(second.getState().status).toBe('ended')
})

test('evaluate sees a staged setResult before the node commits', async () => {
  const decide = defineNodeKind({
    kind: 'decide',
    schema: {
      type: 'object',
      required: ['kind', 'yes', 'no'],
      properties: { kind: { const: 'decide' }, yes: { type: 'string' }, no: { type: 'string' } },
      additionalProperties: false,
    },
    targets: (node: { kind: 'decide'; yes: string; no: string }) => [
      { path: ['yes'], id: node.yes },
      { path: ['no'], id: node.no },
    ],
    execute: (node, ctx) => {
      ctx.setResult({ answer: 'yes' })

      return {
        next: ctx.evaluate({ path: ['results', ctx.nodeID, 'answer'], is: { equalTo: 'yes' } })
          ? node.yes
          : node.no,
      }
    },
  })

  const result = await createFlowGraph({ kinds: [decide] }).run({
    definition: {
      id: 'decide',
      name: 'Decide',
      version: 1,
      start: 'decide',
      nodes: {
        decide: { kind: 'decide', yes: 'yes', no: 'no' },
        yes: { kind: 'end', outcome: 'yes' },
        no: { kind: 'end', outcome: 'no' },
      },
    },
  })

  expect(result.outcome).toBe('yes')
  expect(result.runState.frames[0]?.results.decide).toEqual({ answer: 'yes' })
})

test('registration accepts a resultSchema that depends on node fields', () => {
  const dynamic = defineNodeKind({
    kind: 'dynamic',
    schema: {
      type: 'object',
      required: ['kind', 'field', 'next'],
      properties: {
        kind: { const: 'dynamic' },
        field: { type: 'string' },
        next: { type: 'string' },
      },
      additionalProperties: false,
    },
    targets: (node: { kind: 'dynamic'; field: string; next: string }) => [
      { path: ['next'], id: node.next },
    ],
    resultSchema: (node) => ({
      type: 'object',
      properties: { [node.field.toUpperCase()]: { type: 'string' } },
      additionalProperties: false,
    }),
    execute: (node) => ({ next: node.next, result: { [node.field.toUpperCase()]: 'value' } }),
  })

  const graph = createFlowGraph({ kinds: [dynamic] })

  const definition = {
    id: 'dynamic',
    name: 'Dynamic',
    version: 1,
    start: 'dynamic',
    nodes: {
      dynamic: { kind: 'dynamic', field: 'answer', next: 'end' },
      end: { kind: 'end', output: { value: { ref: ['results', 'dynamic', 'ANSWER'] } } },
    },
  }

  expect(graph.check(definition).ok).toBe(true)
})

test('a retryable resume failure starts the next logical attempt', async () => {
  const attempts: Array<number> = []

  const job = defineNodeKind({
    kind: 'job',
    retries: true,
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      properties: { kind: { const: 'job' }, next: { type: 'string' } },
      additionalProperties: false,
    },
    targets: (node: { kind: 'job'; next: string }) => [{ path: ['next'], id: node.next }],
    execute: (node, ctx) => {
      attempts.push(ctx.attempt)

      return ctx.attempt === 1 ? { suspend: { data: 1 } } : { next: node.next }
    },
    resume: () => {
      throw new FlowRetryableError({ message: 'private' })
    },
    retryable: (error) => error instanceof FlowRetryableError,
  })

  const definition = {
    id: 'retry-resume',
    name: 'Retry resume',
    version: 1,
    start: 'job',
    nodes: { job: { kind: 'job', next: 'end' }, end: { kind: 'end' } },
  }

  const graph = createFlowGraph({ kinds: [job], retryDefaults: { job: { maxAttempts: 2 } } })
  const first = await graph.run({ definition })

  const second = graph.resume({
    definition,
    runState: first.runState,
    event: { type: 'value', value: 1 },
  })

  for await (const _state of second) {
    /* drain */
  }

  expect(second.getState().status).toBe('ended')
  expect(attempts).toEqual([1, 2])
})
