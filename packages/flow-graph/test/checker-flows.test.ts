import { expect, test, vi } from 'vitest'

import type {
  FlowDefinition,
  FlowGraphOptions,
  FlowIssue,
  FlowNode,
  FlowResolver,
  RunState,
} from '../src/index.js'
import {
  createFlowGraph,
  createMapResolver,
  defineNodeKind,
  FlowDefinitionError,
} from '../src/index.js'
import { failedIssues, passedWarnings, reportedIssues } from './check-result.js'

function flow(id: string, nodes: Record<string, FlowNode>, extra: Partial<FlowDefinition> = {}) {
  return {
    id,
    name: id,
    version: 1,
    start: Object.keys(nodes)[0] as string,
    nodes,
    ...extra,
  } as FlowDefinition
}

function makeGraph(definitions: Array<FlowDefinition>, options: FlowGraphOptions = {}) {
  return createFlowGraph({ resolver: createMapResolver(definitions), ...options })
}

const codes = (issues: ReadonlyArray<FlowIssue>) => issues.map((item) => item.code)

const find = (issues: ReadonlyArray<FlowIssue>, code: string) =>
  issues.filter((item) => item.code === code)

const callee = (id: string, output: Record<string, unknown> = { total: { value: 1 } }) =>
  flow(id, { done: { kind: 'end', output } })

const caller = (nodes: Record<string, FlowNode>) => flow('root', nodes)

test('checkFlows accepts a valid pinned reference set', async () => {
  const graph = makeGraph([callee('sum')])

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: { kind: 'end', output: { total: { ref: ['results', 'c', 'output', 'total'] } } },
    }),
  )

  expect(result).toEqual({ value: expect.objectContaining({ id: 'root' }), warnings: [] })
})

test('checkFlows stops on local check errors without resolving', async () => {
  const resolve = vi.fn()
  const graph = createFlowGraph({ resolver: { resolve } })

  const result = await graph.checkFlows(
    caller({ c: { kind: 'call', flow: 'sum', version: 1, next: 'missing' } }),
  )

  const issues = failedIssues(result)

  expect(codes(issues)).toContain('unknown_target')
  expect(resolve).not.toHaveBeenCalled()
})

test('checkFlows reports missing_flow when the resolver throws', async () => {
  const graph = makeGraph([callee('other')])

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: { kind: 'end' },
    }),
  )

  const issues = failedIssues(result)

  expect(find(issues, 'missing_flow')).toEqual([
    expect.objectContaining({ severity: 'error', path: ['nodes', 'c', 'flow'] }),
  ])
})

test('checkFlows reports missing_flow when the resolved definition does not match', async () => {
  const resolver: FlowResolver = { resolve: () => ({ ...callee('sum'), version: 2 }) }
  const graph = createFlowGraph({ resolver })

  const result = await graph.checkFlows(
    caller({
      l: {
        kind: 'loop',
        while: { path: ['input', 'go'], is: { presence: 'nonNull' } },
        maxIterations: 2,
        body: { flow: 'sum', version: 1 },
        exit: 'done',
      },
      done: { kind: 'end' },
    }),
  )

  expect(find(reportedIssues(result), 'missing_flow')).toEqual([
    expect.objectContaining({ path: ['nodes', 'l', 'body', 'flow'] }),
  ])
})

test('checkFlows reports unbounded_cycle when flows goto each other', async () => {
  const a = flow('a', { g: { kind: 'goto', flow: 'b', version: 1 } })
  const b = flow('b', { g: { kind: 'goto', flow: 'a', version: 1 } })
  const graph = makeGraph([a, b])

  const result = await graph.checkFlows(a)

  const issues = failedIssues(result)

  expect(find(issues, 'unbounded_cycle')).toEqual([
    expect.objectContaining({ severity: 'error', path: ['nodes', 'g', 'flow'] }),
  ])
})

test('checkFlows reports recursive_call when a flow calls itself', async () => {
  const self = flow('self', {
    c: { kind: 'call', flow: 'self', version: 1, next: 'done' },
    done: { kind: 'end' },
  })

  const graph = makeGraph([self])
  const result = await graph.checkFlows(self)

  const warnings = passedWarnings(result)

  expect(find(warnings, 'recursive_call')).toEqual([
    expect.objectContaining({ severity: 'warning', path: ['nodes', 'c', 'flow'] }),
  ])
  expect(find(warnings, 'recursive_call')[0]?.hint).toContain('maxDepth')
})

test('checkFlows reports input_mismatch when reference input does not fit the callee', async () => {
  const sum = flow(
    'sum',
    { done: { kind: 'end' } },
    {
      input: {
        type: 'object',
        description: 'Numbers',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  )

  const graph = makeGraph([sum])

  const result = await graph.checkFlows(
    caller({
      c: {
        kind: 'call',
        flow: 'sum',
        version: 1,
        input: { a: { value: 1 }, c: { value: 2 } },
        next: 'g',
      },
      g: { kind: 'goto', flow: 'sum', version: 1 },
    }),
  )

  const issues = failedIssues(result)

  expect(find(issues, 'input_mismatch').map((item) => item.path)).toEqual([
    ['nodes', 'c', 'input', 'b'],
    ['nodes', 'c', 'input', 'c'],
    // An omitted input counts as `{}`.
    ['nodes', 'g', 'input', 'a'],
    ['nodes', 'g', 'input', 'b'],
  ])
})

test('input_mismatch is skipped for non-simple input schemas', async () => {
  const sum = flow(
    'sum',
    { done: { kind: 'end' } },
    {
      input: {
        anyOf: [
          { type: 'object', required: ['a'] },
          { type: 'object', required: ['b'] },
        ],
      },
    },
  )

  const graph = makeGraph([sum])

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: { kind: 'end' },
    }),
  )

  expect(result).toEqual({ value: expect.objectContaining({ id: 'root' }), warnings: [] })
})

test('checkFlows reports invalid_result_path when the callee does not return the key', async () => {
  const graph = makeGraph([callee('sum')])

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: {
        kind: 'end',
        output: {
          total: { ref: ['results', 'c', 'output', 'total', 'deep'] },
          outcome: { ref: ['results', 'c', 'outcome'] },
          other: { ref: ['results', 'c', 'output', 'other'] },
        },
      },
    }),
  )

  const issues = failedIssues(result)

  expect(find(issues, 'invalid_result_path')).toEqual([
    expect.objectContaining({ path: ['nodes', 'done', 'output', 'other', 'ref'] }),
  ])
})

test('checkFlows reports invalid_result_path for flow-body loop results', async () => {
  const graph = makeGraph([callee('sum')])

  const result = await graph.checkFlows(
    caller({
      l: {
        kind: 'loop',
        while: { path: ['input', 'go'], is: { presence: 'nonNull' } },
        maxIterations: 2,
        body: { flow: 'sum', version: 1 },
        exit: 'done',
      },
      done: { kind: 'end', output: { x: { ref: ['results', 'l', 'output', 'nope'] } } },
    }),
  )

  expect(find(reportedIssues(result), 'invalid_result_path')).toEqual([
    expect.objectContaining({ path: ['nodes', 'done', 'output', 'x', 'ref'] }),
  ])
})

test('invalid_result_path is skipped when the callee set has a terminal custom kind', async () => {
  const finish = defineNodeKind<{ kind: 'finish' }>({
    kind: 'finish',
    schema: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: { kind: { const: 'finish' } },
    },
    targets: () => [],
    terminal: true,
    execute: () => ({ end: { output: { anything: 1 } } }),
  })

  const sum = flow('sum', { g: { kind: 'goto', flow: 'fin', version: 1 } })
  const fin = flow('fin', { f: { kind: 'finish' } })
  const graph = makeGraph([sum, fin], { kinds: [finish] })

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: { kind: 'end', output: { x: { ref: ['results', 'c', 'output', 'anything'] } } },
    }),
  )

  expect(result).toEqual({ value: expect.objectContaining({ id: 'root' }), warnings: [] })
})

test('output keys from goto-reachable flows are accepted', async () => {
  const sum = flow('sum', {
    b: {
      kind: 'branch',
      cases: [{ when: { path: ['input', 'x'], is: { presence: 'nonNull' } }, to: 'g' }],
      default: 'done',
    },
    g: { kind: 'goto', flow: 'more', version: 1 },
    done: { kind: 'end', output: { total: { value: 1 } } },
  })

  const more = flow('more', { done: { kind: 'end', output: { extra: { value: 2 } } } })
  const graph = makeGraph([sum, more])

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: {
        kind: 'end',
        output: {
          total: { ref: ['results', 'c', 'output', 'total'] },
          extra: { ref: ['results', 'c', 'output', 'extra'] },
          nope: { ref: ['results', 'c', 'output', 'nope'] },
        },
      },
    }),
  )

  expect(find(reportedIssues(result), 'invalid_result_path')).toEqual([
    expect.objectContaining({ path: ['nodes', 'done', 'output', 'nope', 'ref'] }),
  ])
})

test('checkFlows reports unversioned_reference when a reference has no version', async () => {
  const graph = makeGraph([callee('sum')])

  const root = caller({
    c: { kind: 'call', flow: 'sum', next: 'done' },
    done: { kind: 'end' },
  })

  const result = await graph.checkFlows(root)

  // A passing check has no `issues`; its warnings travel with the checked definition.
  expect(result).toStrictEqual({
    value: root,
    warnings: [
      expect.objectContaining({
        code: 'unversioned_reference',
        severity: 'warning',
        path: ['nodes', 'c', 'flow'],
      }),
    ],
  })
})

test('checkFlows returns warnings with every error when the flow set fails', async () => {
  const graph = makeGraph([callee('sum')])
  const root = caller({
    c: { kind: 'call', flow: 'sum', next: 'g' },
    g: { kind: 'call', flow: 'gone', version: 1, next: 'done' },
    done: { kind: 'end' },
  })

  const result = await graph.checkFlows(root)

  expect(result).not.toHaveProperty('value')
  expect(failedIssues(result).map((item) => [item.code, item.severity])).toEqual([
    ['unversioned_reference', 'warning'],
    ['missing_flow', 'error'],
  ])
})

test('checkFlows prefixes issues inside resolved flows', async () => {
  const sum = flow('sum', {
    c: { kind: 'call', flow: 'gone', version: 3, next: 'bad' },
  })

  const graph = makeGraph([sum])

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: { kind: 'end' },
    }),
  )

  const issues = failedIssues(result)

  expect(issues).toContainEqual(
    expect.objectContaining({
      code: 'unknown_target',
      path: ['flows', 'sum', 1, 'nodes', 'c', 'next'],
    }),
  )
})

test('checkFlows prefixes cross-flow issues found in resolved flows', async () => {
  const sum = flow('sum', {
    c: { kind: 'call', flow: 'gone', version: 3, next: 'done' },
    done: { kind: 'end' },
  })

  const graph = makeGraph([sum])

  const result = await graph.checkFlows(
    caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: { kind: 'end' },
    }),
  )

  expect(reportedIssues(result)).toEqual([
    expect.objectContaining({
      code: 'missing_flow',
      path: ['flows', 'sum', 1, 'nodes', 'c', 'flow'],
    }),
  ])
})

test('checkFlows resolves each reference once, breadth first', async () => {
  const definitions = [
    callee('leaf'),
    flow('mid', {
      c: { kind: 'call', flow: 'leaf', version: 1, next: 'done' },
      done: { kind: 'end' },
    }),
    callee('side'),
  ]

  const map = createMapResolver(definitions)
  const seen: Array<string> = []

  const graph = createFlowGraph({
    resolver: {
      resolve: async (id, version) => {
        seen.push(`${id}@${version}`)

        return map.resolve(id, version)
      },
    },
  })

  const result = await graph.checkFlows(
    caller({
      a: { kind: 'call', flow: 'mid', version: 1, next: 'b' },
      b: { kind: 'call', flow: 'side', version: 1, next: 'c' },
      c: { kind: 'call', flow: 'mid', version: 1, next: 'done' },
      done: { kind: 'end' },
    }),
  )

  expect(result.issues).toBeUndefined()
  expect(seen).toEqual(['mid@1', 'side@1', 'leaf@1'])
})

test('start with references rejects the first next() with FlowDefinitionError and commits nothing', async () => {
  const graph = makeGraph([])
  const commits: Array<string> = []

  const run = graph.start({
    definition: caller({
      c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
      done: { kind: 'end' },
    }),
  })

  run.events.on('node:enter', ({ node }) => {
    commits.push(node)
  })

  const error = await run.next().then(
    () => undefined,
    (reason: unknown) => reason,
  )

  expect(error).toBeInstanceOf(FlowDefinitionError)
  expect(codes([...(error as FlowDefinitionError).issues])).toContain('missing_flow')
  expect(commits).toEqual([])
  expect(run.getState()).toMatchObject<Partial<RunState>>({ revision: 0, steps: 0 })
})

test('start preflight warnings do not block the run', async () => {
  const graph = makeGraph([callee('sum')])

  const result = await graph.run({
    definition: caller({
      c: { kind: 'call', flow: 'sum', next: 'done' },
      done: { kind: 'end', output: { got: { ref: ['results', 'c', 'output', 'total'] } } },
    }),
  })

  expect(result.status).toBe('ended')
  expect(result.output).toEqual({ got: 1 })
})

test('checkFlows distinguishes a throwing resolver from a mismatched definition', async () => {
  const reference = caller({
    c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
    done: { kind: 'end' },
  })

  const thrown = await createFlowGraph({
    resolver: {
      resolve: () => {
        throw new Error('secret resolver detail')
      },
    },
  }).checkFlows(reference)

  const mismatched = await createFlowGraph({
    resolver: { resolve: () => ({ ...callee('sum'), version: 2 }) },
  }).checkFlows(reference)

  const [thrownIssue] = find(failedIssues(thrown), 'missing_flow')
  const [mismatchedIssue] = find(failedIssues(mismatched), 'missing_flow')

  expect(thrownIssue?.message).toBeDefined()
  expect(mismatchedIssue?.message).toBeDefined()
  expect(thrownIssue?.message).not.toBe(mismatchedIssue?.message)
  expect(thrownIssue?.message).not.toContain('secret')
})

const probed = () => {
  const checked: Array<string> = []

  const probe = defineNodeKind<{ kind: 'probe'; next: string }>({
    kind: 'probe',
    schema: {
      type: 'object',
      required: ['kind', 'next'],
      additionalProperties: false,
      properties: { kind: { const: 'probe' }, next: { type: 'string' } },
    },
    targets: (node) => [{ path: ['next'], id: node.next }],
    check: (_node, ctx) => {
      checked.push(ctx.definition.id)

      return []
    },
    execute: (node) => ({ next: node.next }),
  })

  return { checked, probe }
}

test('checkFlows and the start preflight check root drafts afresh', async () => {
  const { checked, probe } = probed()
  const graph = makeGraph([callee('sum')], { kinds: [probe] })

  const root = caller({
    p: { kind: 'probe', next: 'c' },
    c: { kind: 'call', flow: 'sum', version: 1, next: 'done' },
    done: { kind: 'end' },
  })

  await graph.checkFlows(root)
  await graph.checkFlows(root)

  expect(checked).toEqual(['root', 'root'])

  checked.length = 0

  await graph.run({ definition: root })
  await graph.run({ definition: root })

  // Each start checks its snapshot once; the preflight reuses that result for the root.
  expect(checked).toEqual(['root', 'root'])
})

test('checkFlows results are never shared between calls', async () => {
  const graph = makeGraph([])
  const root = caller({ c: { kind: 'call', flow: 'sum', version: 1, next: 'missing' } })

  const first = failedIssues(await graph.checkFlows(root)) as Array<FlowIssue>
  const expected = [...first]

  first.length = 0

  const second = await graph.checkFlows(root)

  expect(second.issues).toEqual(expected)
})

test('resolved callee checks are cached in a bounded LRU', async () => {
  const { checked, probe } = probed()
  const ids = Array.from({ length: 65 }, (_, index) => `leaf${index}`)

  const leaves = ids.map((id) =>
    flow(id, { p: { kind: 'probe', next: 'done' }, done: { kind: 'end' } }),
  )

  const graph = makeGraph(leaves, { kinds: [probe] })

  const callAll = (targets: Array<string>) =>
    caller(
      Object.fromEntries([
        ...targets.map((id, index) => [
          `c${index}`,
          {
            kind: 'call',
            flow: id,
            version: 1,
            next: targets[index + 1] ? `c${index + 1}` : 'done',
          },
        ]),
        ['done', { kind: 'end' }],
      ]),
    )

  expect((await graph.checkFlows(callAll(ids))).issues).toBeUndefined()
  expect(checked).toEqual(ids)

  checked.length = 0

  // 65 callees overflow the 64-entry cache: the least recently used one was evicted.
  await graph.checkFlows(callAll(['leaf64', 'leaf0']))

  expect(checked).toEqual(['leaf0'])
})

test('a goto-only cycle is unbounded_cycle, never recursive_call', async () => {
  const a = flow('a', { g: { kind: 'goto', flow: 'b', version: 1 } })
  const b = flow('b', { g: { kind: 'goto', flow: 'a', version: 1 } })
  const result = await makeGraph([a, b]).checkFlows(a)

  expect(codes(reportedIssues(result))).toContain('unbounded_cycle')
  expect(find(reportedIssues(result), 'recursive_call')).toEqual([])
})

test('checkFlows reports recursive_call through a loop body edge', async () => {
  const self = flow('self', {
    l: {
      kind: 'loop',
      while: { path: ['input', 'go'], is: { presence: 'nonNull' } },
      maxIterations: 2,
      body: { flow: 'self', version: 1 },
      exit: 'done',
    },
    done: { kind: 'end' },
  })

  const result = await makeGraph([self]).checkFlows(self)

  const warnings = passedWarnings(result)

  expect(find(warnings, 'recursive_call')).toEqual([
    expect.objectContaining({ severity: 'warning', path: ['nodes', 'l', 'body', 'flow'] }),
  ])
  expect(find(warnings, 'unbounded_cycle')).toEqual([])
})

test('a mixed call and goto cycle warns recursive_call without an error', async () => {
  const a = flow('a', {
    c: { kind: 'call', flow: 'b', version: 1, next: 'done' },
    done: { kind: 'end' },
  })

  const b = flow('b', { g: { kind: 'goto', flow: 'a', version: 1 } })
  const result = await makeGraph([a, b]).checkFlows(a)

  const warnings = passedWarnings(result)

  expect(find(warnings, 'unbounded_cycle')).toEqual([])
  expect(find(warnings, 'recursive_call')).toEqual([
    expect.objectContaining({ severity: 'warning', path: ['nodes', 'c', 'flow'] }),
  ])
})
