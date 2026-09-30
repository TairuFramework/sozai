import type { JSONValue } from '@sozai/json'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { expect, expectTypeOf, test } from 'vitest'

import type {
  Action,
  ExecuteContext,
  FlowGraph,
  FlowIssue,
  FlowResolver,
  FlowRun,
  NodeKind,
  RunState,
  StartParams,
} from '../src/index.js'
import {
  createFlowGraph,
  createMapResolver,
  defineNodeKind,
  type FlowDefinitionError,
  type FlowInputError,
  FlowNodeFailure,
  type FlowResumeError,
  type FlowRetryableError,
  type FlowStateError,
} from '../src/index.js'

test('public API types preserve graph and custom kind contracts', () => {
  expectTypeOf(createFlowGraph).returns.toEqualTypeOf<FlowGraph>()
  expectTypeOf<Parameters<FlowGraph['start']>[0]>().toEqualTypeOf<StartParams>()
  expectTypeOf<ReturnType<FlowGraph['start']>>().toEqualTypeOf<FlowRun>()
  expectTypeOf<FlowRun>().toExtend<AsyncIterable<RunState>>()
  expectTypeOf<Parameters<Action>[0]['args']>().toEqualTypeOf<Record<string, JSONValue>>()
  expectTypeOf<ExecuteContext['setResult']>().toEqualTypeOf<(value: JSONValue) => void>()
  expectTypeOf<FlowDefinitionError['issues']>().toEqualTypeOf<ReadonlyArray<FlowIssue>>()
  expectTypeOf<FlowIssue>().toExtend<StandardSchemaV1.Issue>()
  expectTypeOf<FlowDefinitionError>().toExtend<StandardSchemaV1.FailureResult>()
  expectTypeOf<FlowInputError>().toExtend<StandardSchemaV1.FailureResult>()
  expectTypeOf<FlowStateError>().toExtend<StandardSchemaV1.FailureResult>()
  expectTypeOf<FlowResumeError>().toExtend<StandardSchemaV1.FailureResult>()
  expectTypeOf<FlowRetryableError['afterMs']>().toEqualTypeOf<number | undefined>()

  type CustomNode = { kind: 'custom'; next: string }

  const custom: NodeKind<CustomNode> = defineNodeKind<CustomNode>({
    kind: 'custom',
    schema: { type: 'object', required: ['kind', 'next'] },
    targets: (node) => [{ path: ['next'], id: node.next }],
    execute: (node) => ({ next: node.next }),
  })

  createFlowGraph({ kinds: [custom] })
})

test('exports FlowNodeFailure', () => {
  expect(new FlowNodeFailure({ code: 'invalid_suspend' }).code).toBe('invalid_suspend')
})

test('exports the resolver and state checks without internal helpers', async () => {
  expectTypeOf(createMapResolver).returns.toEqualTypeOf<FlowResolver>()

  const api: Record<string, unknown> = await import('../src/index.js')

  expect(typeof api.createMapResolver).toBe('function')
  expect(typeof api.assertRunState).toBe('function')

  for (const name of [
    'prepareDefinition',
    'preparePinned',
    'assertRunStateShape',
    'assertRunStateDefinitions',
  ]) {
    expect(api).not.toHaveProperty(name)
  }
})
