import type { JSONValue } from '@sozai/json'
import { expectTypeOf, test } from 'vitest'

import type {
  Action,
  ExecuteContext,
  FlowGraph,
  FlowIssue,
  FlowRun,
  NodeKind,
  RunState,
  StartParams,
} from '../src/index.js'
import {
  createFlowGraph,
  defineNodeKind,
  type FlowDefinitionError,
  type FlowRetryableError,
} from '../src/index.js'

test('public API types preserve graph and custom kind contracts', () => {
  expectTypeOf(createFlowGraph).returns.toEqualTypeOf<FlowGraph>()
  expectTypeOf<Parameters<FlowGraph['start']>[0]>().toEqualTypeOf<StartParams>()
  expectTypeOf<ReturnType<FlowGraph['start']>>().toEqualTypeOf<FlowRun>()
  expectTypeOf<FlowRun>().toExtend<AsyncIterable<RunState>>()
  expectTypeOf<Parameters<Action>[0]['args']>().toEqualTypeOf<Record<string, JSONValue>>()
  expectTypeOf<ExecuteContext['setResult']>().toEqualTypeOf<(value: JSONValue) => void>()
  expectTypeOf<FlowDefinitionError['issues']>().toEqualTypeOf<Array<FlowIssue>>()
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
