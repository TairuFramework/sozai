import { assertRetryPolicy } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import type { Schema, Validator } from '@sozai/schema'
import { createValidator, ValidationError } from '@sozai/schema'

import { FlowGraphValidatorsError } from './errors.js'
import { checkResult, issue } from './issue.js'
import { collectNodeReads, type ReadReference } from './reads.js'
import { schemaHasPath } from './result-paths.js'
import type {
  FlowCheckResult,
  FlowDefinition,
  FlowIssue,
  FlowNode,
  FlowRetryPolicy,
  NodeKind,
} from './types.js'
import { isSafePathSegment } from './value.js'

type ContainsEndParams = {
  definition: FlowDefinition
  kinds: Map<string, NodeKind>
  edges: Map<string, Array<string>>
  start: string
  visited?: Set<string>
}

type ValidationHintParams = {
  keyword: string
  field: unknown
  params: Record<string, unknown>
  isOperator: boolean
}

type AnalyzeGraphParams = {
  definition: FlowDefinition
  kinds: Map<string, NodeKind>
  ids: Array<string>
  edges: Map<string, Array<string>>
  reads: Map<string, Array<ReadReference>>
  issues: Array<FlowIssue>
}

type CheckReadsParams = {
  definition: FlowDefinition
  kinds: Map<string, NodeKind>
  reads: Map<string, Array<ReadReference>>
  issues: Array<FlowIssue>
  dominators: Map<string, Set<string>>
}

type CheckNodesParams = {
  definition: FlowDefinition
  ids: Array<string>
  kinds: Map<string, NodeKind>
  actions?: Record<string, unknown>
  validatorFor: (schema: Schema, strict?: boolean) => Validator<unknown>
  edges: Map<string, Array<string>>
  reads: Map<string, Array<ReadReference>>
  issues: Array<FlowIssue>
}

type CheckNodeRetryParams = {
  node: FlowNode
  kind: NodeKind
  nodeID: string
  issues: Array<FlowIssue>
}

type CheckNodeSchemasParams = CheckNodeRetryParams & {
  validatorFor: (schema: Schema, strict?: boolean) => Validator<unknown>
}

/** Inputs and validators used to check a definition. */
export type CheckDefinitionParams = {
  definition: unknown
  kinds: Map<string, NodeKind>
  actions?: Record<string, unknown>
  authoringSchema?: Schema
  validatorFor?: (schema: Schema, strict?: boolean) => Validator<unknown>
}

/** Render flow definition issues for people editing a graph. */
export function formatIssues(issues: ReadonlyArray<FlowIssue>): string {
  return issues
    .map(
      (item) =>
        `${item.severity} ${item.code} ${item.path.join('.')}: ${item.message} Fix: ${item.hint}`,
    )
    .join('\n')
}

const ownNode = (nodes: FlowDefinition['nodes'], id: string): FlowNode | undefined =>
  Object.hasOwn(nodes, id) ? nodes[id] : undefined

function validationField(keyword: string, params: Record<string, unknown>): unknown {
  if (keyword === 'additionalProperties') {
    return params.additionalProperty
  }

  if (keyword === 'required') {
    return params.missingProperty
  }

  return undefined
}

function validationHint({ keyword, field, params, isOperator }: ValidationHintParams): string {
  if (keyword === 'additionalProperties' && isOperator) {
    return 'Use isNull, equalTo, notEqualTo, in, notIn, lessThan, lessThanOrEqualTo, greaterThan, greaterThanOrEqualTo, contains, includesAll, includesAny or presence.'
  }

  switch (keyword) {
    case 'enum':
      return `Use one of ${JSON.stringify(params.allowedValues)}.`
    case 'const':
      return `Use ${JSON.stringify(params.allowedValue)}.`
    case 'type':
      return `Expected ${String(params.type)}.`
    case 'required':
      return `Add the required ${String(field)} field.`
    case 'additionalProperties':
      return `Remove the unknown ${String(field)} field.`
    default:
      return `Fix the ${keyword} constraint.`
  }
}

const validationIssues = (
  error: ValidationError,
  prefix: Array<string | number>,
): Array<FlowIssue> => {
  const specific = error.issues.filter(
    (item) => !['oneOf', 'anyOf', 'allOf'].includes(item.details.keyword),
  )

  const detailed = specific.length > 0 ? specific : error.issues

  const selected = detailed.filter(
    (item) =>
      !detailed.some(
        (other) =>
          other.path.length > item.path.length &&
          item.path.every((part, index) => other.path[index] === part),
      ),
  )

  const result = selected.map((item) => {
    const details = item.details
    const params = details.params as Record<string, unknown>
    const field = validationField(details.keyword, params)
    const path = [...prefix, ...item.path.map((part) => (/^\d+$/.test(part) ? Number(part) : part))]

    if (typeof field === 'string') {
      path.push(field)
    }

    const allowed = validationHint({
      keyword: details.keyword,
      field,
      params,
      isOperator: item.path.at(-1) === 'is',
    })

    return issue({ code: 'schema', path, message: item.message, hint: allowed })
  })

  return [...new Map(result.map((item) => [JSON.stringify(item.path), item])).values()]
}

type IsEndNodeParams = { definition: FlowDefinition; kinds: Map<string, NodeKind>; id: string }

/** Whether a node ends the run's local graph: a terminal kind, or a `goto` handover. */
const isEndNode = (params: IsEndNodeParams): boolean => {
  const { definition, kinds, id } = params
  const kind = ownNode(definition.nodes, id)?.kind

  return kind !== undefined && (kind === 'goto' || kinds.get(kind)?.terminal === true)
}

const containsEnd = (params: ContainsEndParams): boolean => {
  const { definition, kinds, edges, start, visited = new Set<string>() } = params

  if (visited.has(start)) {
    return false
  }

  visited.add(start)

  if (isEndNode({ definition, kinds, id: start })) {
    return true
  }

  return (edges.get(start) ?? []).some((next) =>
    containsEnd({ definition, kinds, edges, start: next, visited }),
  )
}

function checkReads(params: CheckReadsParams): void {
  const { definition, kinds, reads, issues, dominators } = params

  for (const [id, refs] of reads) {
    for (const ref of refs) {
      const [root, producer, ...rest] = ref.path

      if (
        !['input', 'state', 'results', 'loops'].includes(root as string) ||
        ref.path.some((part) => !isSafePathSegment(part))
      ) {
        issues.push(
          issue({
            code: 'invalid_path',
            path: ref.location,
            message: 'Invalid scope path.',
            hint: 'Use a safe input, state, results or loops path.',
          }),
        )
        continue
      }

      if (root === 'results' && (!producer || !ownNode(definition.nodes, producer))) {
        issues.push(
          issue({
            code: 'invalid_path',
            path: ref.location,
            message: 'Result producer does not exist.',
            hint: 'Name an existing node after results.',
          }),
        )
        continue
      }

      if (root === 'loops' && (!producer || ownNode(definition.nodes, producer)?.kind !== 'loop')) {
        issues.push(
          issue({
            code: 'invalid_path',
            path: ref.location,
            message: 'Loop path does not name a loop.',
            hint: 'Name an existing loop node.',
          }),
        )
      }

      if (root === 'results' && producer && ownNode(definition.nodes, producer)) {
        const producerNode = ownNode(definition.nodes, producer)

        if (!producerNode) {
          continue
        }

        if (rest[0] === 'error' && producerNode.onError) {
          if (
            (rest.length > 1 &&
              !['type', 'code', 'status', 'reason', 'attempts'].includes(rest[1] as string)) ||
            rest.length > 2
          ) {
            issues.push(
              issue({
                code: 'invalid_error_path',
                path: ref.location,
                message: 'Unknown handled-error field.',
                hint: 'Use type, code, status, reason or attempts.',
              }),
            )
          }
        } else {
          const kind = kinds.get(producerNode.kind)

          if (
            kind?.resultSchema &&
            rest.length > 0 &&
            !schemaHasPath(kind.resultSchema(producerNode), rest)
          ) {
            issues.push(
              issue({
                code: 'invalid_result_path',
                path: ref.location,
                message: 'Result field is not declared.',
                hint: 'Reference a field in the producer resultSchema.',
              }),
            )
          }
        }

        if (id !== producer && !dominators.get(id)?.has(producer)) {
          issues.push(
            issue({
              code: 'result_maybe_missing',
              path: ref.location,
              message: 'Producer may not run before this read.',
              hint: 'Guard the missing result or change graph edges.',
              severity: 'warning',
            }),
          )
        }
      }
    }
  }
}

function computeDominators(
  definition: FlowDefinition,
  ids: Array<string>,
  edges: Map<string, Array<string>>,
): Map<string, Set<string>> {
  const predecessors = new Map(ids.map((id) => [id, [] as Array<string>]))

  for (const [id, targets] of edges) {
    for (const target of targets) {
      predecessors.get(target)?.push(id)
    }
  }

  const dominators = new Map(ids.map((id) => [id, new Set(id === definition.start ? [id] : ids)]))

  for (let changed = true; changed; ) {
    changed = false

    for (const id of ids) {
      if (id === definition.start) {
        continue
      }

      const incoming = predecessors.get(id) ?? []

      const next = new Set([
        id,
        ...ids.filter(
          (candidate) =>
            incoming.length > 0 &&
            incoming.every((predecessor) => dominators.get(predecessor)?.has(candidate)),
        ),
      ])

      const old = dominators.get(id)

      if (!old) {
        continue
      }

      if (next.size !== old.size || [...next].some((candidate) => !old.has(candidate))) {
        dominators.set(id, next)

        changed = true
      }
    }
  }

  return dominators
}

function analyzeGraph(params: AnalyzeGraphParams): void {
  const { definition, kinds, ids, edges, reads, issues } = params
  const reachable = new Set<string>()

  const visit = (id: string): void => {
    if (reachable.has(id) || !ownNode(definition.nodes, id)) {
      return
    }

    reachable.add(id)

    for (const next of edges.get(id) ?? []) {
      visit(next)
    }
  }

  visit(definition.start)

  for (const id of ids) {
    if (!reachable.has(id)) {
      issues.push(
        issue({
          code: 'unreachable',
          path: ['nodes', id],
          message: 'Node cannot be reached from start.',
          hint: 'Connect it or remove it.',
          severity: 'warning',
        }),
      )
    }

    if (!containsEnd({ definition: definition, kinds, edges, start: id })) {
      issues.push(
        issue({
          code: 'no_end',
          path: ['nodes', id],
          message: 'No end node is reachable.',
          hint: 'Add a path to an end node.',
        }),
      )
    }
  }

  const stripped = new Map(
    [...edges].map(([id, next]) => [
      id,
      next.filter(
        (target) =>
          ownNode(definition.nodes, id)?.kind !== 'loop' ||
          ownNode(definition.nodes, id)?.body !== target,
      ),
    ]),
  )

  const done = new Set<string>()

  const cycle = (id: string, stack = new Set<string>()): boolean => {
    if (stack.has(id)) {
      return true
    }

    if (done.has(id)) {
      return false
    }

    stack.add(id)

    for (const next of stripped.get(id) ?? []) {
      if (cycle(next, stack)) {
        return true
      }
    }

    stack.delete(id)

    done.add(id)

    return false
  }

  if (ids.some((id) => cycle(id))) {
    issues.push(
      issue({
        code: 'unbounded_cycle',
        path: ['nodes'],
        message: 'Cycle does not traverse a loop body edge.',
        hint: 'Route cycles through a loop body edge.',
      }),
    )
  }

  const dominators = computeDominators(definition, ids, edges)

  checkReads({ definition, kinds, reads, issues, dominators })
}

function checkNodeRetry(params: CheckNodeRetryParams): void {
  const { node, kind, nodeID, issues } = params

  if (Object.hasOwn(node, 'retry')) {
    try {
      if (!kind.retries) {
        throw new TypeError('Kind does not retry')
      }

      const policy = node.retry as FlowRetryPolicy

      if (node.kind === 'call' && policy.attemptTimeoutMs !== undefined) {
        // A callee may suspend for days; call retries only bound the total retry window.
        throw new TypeError('Call retry policy rejects attemptTimeoutMs')
      }

      assertRetryPolicy(policy)

      if (
        policy.suspendAfterMs !== undefined &&
        (!Number.isInteger(policy.suspendAfterMs) ||
          policy.suspendAfterMs < 0 ||
          policy.suspendAfterMs > 2147483647 ||
          (policy.totalTimeoutMs !== undefined && policy.suspendAfterMs >= policy.totalTimeoutMs))
      ) {
        throw new RangeError('Invalid suspend threshold')
      }
    } catch {
      issues.push(
        issue({
          code: 'invalid_retry',
          path: ['nodes', nodeID, 'retry'],
          message: 'Retry policy is invalid.',
          hint: 'Use bounded retry values on a retrying kind.',
        }),
      )
    }
  }
}

function checkNodeSchemas(params: CheckNodeSchemasParams): void {
  const { node, kind, nodeID, issues, validatorFor } = params

  if (node.kind === 'input' && node.schema) {
    try {
      validatorFor(node.schema as Schema)
    } catch (error) {
      if (error instanceof FlowGraphValidatorsError) {
        throw error
      }

      issues.push(
        issue({
          code: 'invalid_schema',
          path: ['nodes', nodeID, 'schema'],
          message: 'Input schema cannot compile.',
          hint: 'Repair the JSON Schema.',
        }),
      )
    }
  }

  if (kind.resultSchema) {
    try {
      const resultSchema = kind.resultSchema(node) as Schema & {
        properties?: Record<string, unknown>
      }

      // Result schemas only describe readable paths; path-only shapes need not be strict.
      validatorFor(resultSchema, false)

      if (resultSchema.properties?.error) {
        issues.push(
          issue({
            code: 'invalid_schema',
            path: ['nodes', nodeID],
            message: 'Result schema reserves error.',
            hint: 'Remove top-level error from resultSchema.',
          }),
        )
      }
    } catch {
      issues.push(
        issue({
          code: 'invalid_schema',
          path: ['nodes', nodeID],
          message: 'Result schema cannot compile.',
          hint: 'Repair the JSON Schema.',
        }),
      )
    }
  }
}

function checkNodes(params: CheckNodesParams): void {
  const { definition, ids, kinds, actions, validatorFor, edges, reads, issues } = params

  for (const id of ids) {
    const node = definition.nodes[id] as FlowNode

    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.kind !== 'string') {
      issues.push(
        issue({
          code: 'schema',
          path: ['nodes', id],
          message: 'Node must be an object with a kind.',
          hint: 'Use a valid node kind and shape.',
        }),
      )
      continue
    }

    const kind = kinds.get(node.kind)

    if (!kind) {
      issues.push(
        issue({
          code: 'unknown_kind',
          path: ['nodes', id, 'kind'],
          message: 'Node kind is not registered.',
          hint: 'Register this kind or choose a built-in kind.',
        }),
      )
      continue
    }

    try {
      const valid = validatorFor(kind.schema, false)(node)

      if (valid instanceof ValidationError) {
        issues.push(...validationIssues(valid, ['nodes', id]))
      }
    } catch {
      issues.push(
        issue({
          code: 'invalid_schema',
          path: ['nodes', id],
          message: 'Node schema cannot compile.',
          hint: 'Repair the registered node schema.',
        }),
      )
    }

    checkNodeRetry({ node, kind, nodeID: id, issues })

    if (node.kind === 'action' && actions && !Object.hasOwn(actions, node.name as string)) {
      issues.push(
        issue({
          code: 'unknown_action',
          path: ['nodes', id, 'name'],
          message: 'Action is not registered.',
          hint: 'Register the action or choose an existing name.',
        }),
      )
    }

    let outgoing: ReturnType<NodeKind['targets']>

    try {
      outgoing = kind.targets(node)
    } catch {
      issues.push(
        issue({
          code: 'schema',
          path: ['nodes', id],
          message: 'Node targets cannot be read.',
          hint: 'Follow the node kind schema.',
        }),
      )
      continue
    }

    edges.set(
      id,
      outgoing.map((edge) => edge.id),
    )

    for (const edge of outgoing) {
      if (!ownNode(definition.nodes, edge.id)) {
        issues.push(
          issue({
            code: 'unknown_target',
            path: ['nodes', id, ...edge.path],
            message: 'Target node is missing.',
            hint: 'Name an existing node.',
          }),
        )
      }
    }

    reads.set(id, collectNodeReads(node, id, issues))

    checkNodeSchemas({ node, kind, nodeID: id, issues, validatorFor })

    issues.push(...(kind.check?.(node, { definition: definition, nodeID: id, issue }) ?? []))
  }
}

/**
 * Check a flow definition. Every repairable issue is in `issues` on failure, or in `warnings`
 * alongside the checked definition on success.
 */
export function checkDefinition(params: CheckDefinitionParams): FlowCheckResult {
  const {
    definition,
    kinds,
    actions,
    authoringSchema,
    validatorFor = (schema, strict) =>
      createValidator(schema, strict === undefined ? undefined : { strict }),
  } = params

  const issues: Array<FlowIssue> = []

  if (!isJSONValue(definition)) {
    return {
      issues: [
        issue({
          code: 'schema',
          path: [],
          message: 'Definition must be finite JSON.',
          hint: 'Remove undefined, non-finite numbers, cycles and non-JSON objects.',
        }),
      ],
    }
  }

  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return {
      issues: [
        issue({
          code: 'schema',
          path: [],
          message: 'Definition must be an object.',
          hint: 'Use a flow definition object.',
        }),
      ],
    }
  }

  const raw = definition as Record<string, unknown>

  if (authoringSchema) {
    try {
      const valid = validatorFor(authoringSchema, false)(definition)

      if (valid instanceof ValidationError) {
        issues.push(
          ...validationIssues(valid, []).filter(
            (item) => item.path[0] !== 'nodes' || item.path.length <= 1,
          ),
        )
      }
    } catch {
      issues.push(
        issue({
          code: 'invalid_schema',
          path: ['nodes'],
          message: 'A registered node schema cannot compile.',
          hint: 'Repair the registered JSON Schema.',
        }),
      )
    }
  }

  if (!raw.nodes || typeof raw.nodes !== 'object' || Array.isArray(raw.nodes)) {
    if (!issues.some((item) => item.path[0] === 'nodes' || item.path.length === 0)) {
      issues.push(
        issue({
          code: 'schema',
          path: ['nodes'],
          message: 'Definition must have a nodes object.',
          hint: 'Add a nodes object keyed by node id.',
        }),
      )
    }

    return { issues }
  }

  const def = definition as unknown as FlowDefinition
  const ids = Object.keys(def.nodes)
  const edges = new Map<string, Array<string>>()

  if (!ownNode(def.nodes, def.start)) {
    issues.push(
      issue({
        code: 'unknown_target',
        path: ['start'],
        message: 'Start node is missing.',
        hint: 'Name an existing node.',
      }),
    )
  }

  const reads = new Map<string, Array<ReadReference>>()

  checkNodes({ definition: def, ids, kinds, actions, validatorFor, edges, reads, issues })

  if (def.input) {
    try {
      validatorFor(def.input)
    } catch (error) {
      if (error instanceof FlowGraphValidatorsError) {
        throw error
      }

      issues.push(
        issue({
          code: 'invalid_schema',
          path: ['input'],
          message: 'Input schema cannot compile.',
          hint: 'Repair the JSON Schema.',
        }),
      )
    }
  }

  analyzeGraph({ definition: def, kinds, ids, edges, reads, issues })

  return checkResult(definition, issues)
}
