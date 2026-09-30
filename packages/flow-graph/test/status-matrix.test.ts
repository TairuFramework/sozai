import { expect, test } from 'vitest'

import type { FlowDefinition, RunState } from '../src/index.js'
import { assertRunState, FlowStateError } from '../src/index.js'
import { builtinKinds } from '../src/kinds.js'
import { unavailableReferences } from '../src/reference-kinds.js'

const kinds = new Map(
  builtinKinds({ now: Date.now, references: unavailableReferences }).map((kind) => [
    kind.kind,
    kind as never,
  ]),
)

const definition: FlowDefinition = {
  id: 'matrix',
  name: 'Matrix',
  version: 1,
  start: 'work',
  nodes: {
    work: { kind: 'action', name: 'work', next: 'end' },
    ask: { kind: 'input', next: 'end' },
    loop: {
      kind: 'loop',
      maxIterations: 2,
      while: { path: ['input'], is: { isNull: false } },
      body: 'work',
      exit: 'end',
    },
    end: { kind: 'end' },
  },
}

const timestamp = '1970-01-01T00:00:00.100Z'

const frame = (node: string): RunState['frames'][number] => ({
  flow: { id: 'matrix', version: 1, digest: 'digest' },
  node,
  input: null,
  state: {},
  results: {},
  loops: {},
  attempts: {},
})

const attempt = () => ({
  invocationID: 'run:1',
  policy: { maxAttempts: 2, maxInterruptions: 1 },
  count: 1,
  interruptions: 0,
})

const base = (status: RunState['status']): RunState => {
  const node = status === 'suspended' ? 'ask' : status === 'ended' ? 'end' : 'work'

  const state: RunState = {
    runID: 'run',
    revision: 1,
    status,
    frames: [frame(node)],
    steps: 1,
    invocation: 1,
  }

  if (status === 'suspended') {
    state.pending = { node, reason: 'suspend' }
  }

  if (status === 'error') {
    state.error = { code: 'node_failed', name: 'FlowNodeFailure' }
  }

  return state
}

const retry = (status: 'running' | 'suspended' | 'ended' | 'error' | 'aborted'): RunState => {
  const state = base(status)
  const top = state.frames[0]

  if (!top) {
    throw new Error('Missing fixture frame')
  }

  top.node = 'work'
  top.attempts.work = { ...attempt(), retryAt: timestamp }

  if (status === 'suspended') {
    state.pending = { node: 'work', reason: 'retry', resumeAt: timestamp }
  } else if (status !== 'running') {
    delete top.attempts.work.retryAt
  }

  return state
}

type Fixture = { name: string; state: () => RunState; mutate: (state: RunState) => void }

const fixtures: Array<Fixture> = [
  ...(['running', 'suspended', 'ended', 'error', 'aborted'] as const).map((status) => ({
    name: `${status}: pending where forbidden`,
    state: () => base(status),
    mutate: (state: RunState) => {
      if (status === 'suspended') {
        delete state.pending
      } else {
        state.pending = { node: state.frames[0]?.node ?? 'work', reason: 'suspend' }
      }
    },
  })),
  ...(['suspended', 'ended', 'error', 'aborted'] as const).map((status) => ({
    name: `${status}: inFlight`,
    state: () => retry(status),
    mutate: (state: RunState) => {
      state.inFlight = { node: 'work', attempt: 1, invocationID: 'run:1' }
    },
  })),
  ...(['ended', 'error', 'aborted'] as const).map((status) => ({
    name: `${status}: retryAt`,
    state: () => retry(status),
    mutate: (state: RunState) => {
      const top = state.frames[0]

      if (top?.attempts.work) {
        top.attempts.work.retryAt = timestamp
      }
    },
  })),
  ...(['running', 'suspended', 'error', 'aborted'] as const).map((status) => ({
    name: `${status}: outcome`,
    state: () => base(status),
    mutate: (state: RunState) => {
      state.outcome = 'done'
    },
  })),
  ...(['running', 'suspended', 'error', 'aborted'] as const).map((status) => ({
    name: `${status}: output`,
    state: () => base(status),
    mutate: (state: RunState) => {
      state.output = { answer: 1 }
    },
  })),
  ...(['running', 'suspended', 'ended', 'aborted'] as const).map((status) => ({
    name: `${status}: error`,
    state: () => base(status),
    mutate: (state: RunState) => {
      state.error = { code: 'node_failed', name: 'FlowNodeFailure' }
    },
  })),
  {
    name: 'error: missing error',
    state: () => base('error'),
    mutate: (state) => {
      delete state.error
    },
  },
  {
    name: 'running: inFlight with retryAt',
    state: () => retry('running'),
    mutate: (state) => {
      state.inFlight = { node: 'work', attempt: 1, invocationID: 'run:1' }
    },
  },
  {
    name: 'suspended: retry pending without retryAt',
    state: () => retry('suspended'),
    mutate: (state) => {
      delete state.frames[0]?.attempts.work?.retryAt
    },
  },
  {
    name: 'suspended: retryAt with value pending',
    state: () => retry('suspended'),
    mutate: (state) => {
      state.pending = { node: 'work', reason: 'suspend' }
    },
  },
  {
    name: 'suspended: retryAt differs from resumeAt',
    state: () => retry('suspended'),
    mutate: (state) => {
      if (state.pending) {
        state.pending.resumeAt = '1970-01-01T00:00:00.200Z'
      }
    },
  },
  {
    name: 'pending node differs from cursor',
    state: () => base('suspended'),
    mutate: (state) => {
      if (state.pending) {
        state.pending.node = 'end'
      }
    },
  },
  {
    name: 'cursor node does not exist',
    state: () => base('running'),
    mutate: (state) => {
      if (state.frames[0]) {
        state.frames[0].node = 'missing'
      }
    },
  },
  {
    name: 'attempts contain another node',
    state: () => retry('running'),
    mutate: (state) => {
      if (state.frames[0]) {
        state.frames[0].attempts.ask = attempt()
      }
    },
  },
  {
    name: 'non-retrying node has attempts',
    state: () => base('running'),
    mutate: (state) => {
      if (state.frames[0]) {
        state.frames[0].node = 'ask'
        state.frames[0].attempts.ask = attempt()
      }
    },
  },
  {
    name: 'attempt count exceeds policy',
    state: () => retry('running'),
    mutate: (state) => {
      if (state.frames[0]?.attempts.work) {
        state.frames[0].attempts.work.count = 3
      }
    },
  },
  {
    name: 'interruptions exceed policy',
    state: () => retry('running'),
    mutate: (state) => {
      if (state.frames[0]?.attempts.work) {
        state.frames[0].attempts.work.interruptions = 2
      }
    },
  },
  ...(['node', 'attempt', 'invocationID'] as const).map((field) => ({
    name: `inFlight ${field} differs from attempt`,
    state: () => {
      const state = base('running')
      const top = state.frames[0]

      if (!top) {
        throw new Error('Missing fixture frame')
      }

      top.attempts.work = attempt()

      state.inFlight = { node: 'work', attempt: 1, invocationID: 'run:1' }

      return state
    },
    mutate: (state: RunState) => {
      if (!state.inFlight) {
        return
      }

      if (field === 'node') {
        state.inFlight.node = 'ask'
      }

      if (field === 'attempt') {
        state.inFlight.attempt = 2
      }

      if (field === 'invocationID') {
        state.inFlight.invocationID = 'different'
      }
    },
  })),
  ...(['1970-01-01T00:00:00+00:00', '1970-01-01T00:00:00'] as const).map((value) => ({
    name: `non-canonical pending timestamp ${value}`,
    state: () => base('suspended'),
    mutate: (state: RunState) => {
      if (state.pending) {
        state.pending.deadline = value
      }
    },
  })),
  ...(['deadline', 'retryAt'] as const).map((field) => ({
    name: `non-canonical attempt ${field}`,
    state: () => retry('running'),
    mutate: (state: RunState) => {
      const saved = state.frames[0]?.attempts.work

      if (saved) {
        saved[field] = '1970-01-01T00:00:00+00:00'
      }
    },
  })),
  {
    name: 'loop key names a non-loop node',
    state: () => base('running'),
    mutate: (state) => {
      if (state.frames[0]) {
        state.frames[0].loops.work = 1
      }
    },
  },
  {
    name: 'loop count exceeds maxIterations',
    state: () => base('running'),
    mutate: (state) => {
      if (state.frames[0]) {
        state.frames[0].loops.loop = 3
      }
    },
  },
]

test.each(fixtures)('$name violates run state invariants', ({ state: make, mutate }) => {
  const state = make()

  expect(() => assertRunState(state, { definitions: [definition], kinds: kinds })).not.toThrow()

  mutate(state)

  expect(() => assertRunState(state, { definitions: [definition], kinds: kinds })).toThrow(
    FlowStateError,
  )
})
