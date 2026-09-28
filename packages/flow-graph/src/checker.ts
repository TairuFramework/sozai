import { assertRetryPolicy } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import type { Schema, Validator } from '@sozai/schema'
import { createValidator, ValidationError } from '@sozai/schema'

import type { FlowDefinition, FlowIssue, FlowNode, FlowRetryPolicy, NodeKind } from './types.js'
import { isSafePathSegment } from './value.js'

export function formatIssues(issues: Array<FlowIssue>): string {
  return issues
    .map((i) => `${i.severity} ${i.code} ${i.path.join('.')}: ${i.message} Fix: ${i.hint}`)
    .join('\n')
}
const issue = (
  code: string,
  path: Array<string | number>,
  message: string,
  hint: string,
  severity: 'error' | 'warning' = 'error',
): FlowIssue => ({ severity, path, code, message, hint })
const ownNode = (nodes: FlowDefinition['nodes'], id: string): FlowNode | undefined =>
  Object.hasOwn(nodes, id) ? nodes[id] : undefined
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
    const field =
      details.keyword === 'additionalProperties'
        ? params.additionalProperty
        : details.keyword === 'required'
          ? params.missingProperty
          : undefined
    const path = [...prefix, ...item.path.map((part) => (/^\d+$/.test(part) ? Number(part) : part))]
    if (typeof field === 'string') path.push(field)
    const allowed =
      details.keyword === 'additionalProperties' && item.path.at(-1) === 'is'
        ? 'Use isNull, equalTo, notEqualTo, in, notIn, lessThan, lessThanOrEqualTo, greaterThan, greaterThanOrEqualTo, contains, includesAll, includesAny or presence.'
        : details.keyword === 'enum'
          ? `Use one of ${JSON.stringify(params.allowedValues)}.`
          : details.keyword === 'const'
            ? `Use ${JSON.stringify(params.allowedValue)}.`
            : details.keyword === 'type'
              ? `Expected ${String(params.type)}.`
              : details.keyword === 'required'
                ? `Add the required ${String(field)} field.`
                : details.keyword === 'additionalProperties'
                  ? `Remove the unknown ${String(field)} field.`
                  : `Fix the ${details.keyword} constraint.`
    return issue('schema', path, item.message, allowed)
  })
  return [...new Map(result.map((item) => [JSON.stringify(item.path), item])).values()]
}
const child = (schema: unknown, key: string): unknown => {
  if (!schema || typeof schema !== 'object') return undefined
  const shape = schema as {
    properties?: Record<string, unknown>
    additionalProperties?: unknown
    items?: unknown
  }
  if (shape.properties && Object.hasOwn(shape.properties, key)) return shape.properties[key]
  if (/^(0|[1-9]\d*)$/.test(key) && shape.items && typeof shape.items === 'object')
    return shape.items
  return shape.additionalProperties && typeof shape.additionalProperties === 'object'
    ? shape.additionalProperties
    : undefined
}
const schemaHasPath = (schema: Schema, path: Array<string>): boolean => {
  let current: unknown = schema
  for (const part of path) {
    current = child(current, part)
    if (!current) return false
  }
  return true
}
const containsEnd = (
  definition: FlowDefinition,
  edges: Map<string, Array<string>>,
  start: string,
  visited = new Set<string>(),
): boolean => {
  if (visited.has(start)) return false
  visited.add(start)
  if (ownNode(definition.nodes, start)?.kind === 'end') return true
  return (edges.get(start) ?? []).some((next) => containsEnd(definition, edges, next, visited))
}

export function checkDefinition(
  definition: unknown,
  kinds: Map<string, NodeKind>,
  actions?: Record<string, unknown>,
  authoringSchema?: Schema,
  storageSchema?: Schema,
  validatorFor: (schema: Schema, strict?: boolean) => Validator<unknown> = (schema, strict) =>
    createValidator(schema, strict === undefined ? undefined : { strict }),
): { ok: boolean; issues: Array<FlowIssue> } {
  const issues: Array<FlowIssue> = []
  if (!isJSONValue(definition))
    return {
      ok: false,
      issues: [
        issue(
          'schema',
          [],
          'Definition must be finite JSON.',
          'Remove undefined, non-finite numbers, cycles and non-JSON objects.',
        ),
      ],
    }
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition))
    return {
      ok: false,
      issues: [
        issue('schema', [], 'Definition must be an object.', 'Use a flow definition object.'),
      ],
    }
  const raw = definition as Record<string, unknown>
  if (authoringSchema) {
    try {
      const valid = validatorFor(authoringSchema, false)(definition)
      if (valid instanceof ValidationError) {
        const stored =
          storageSchema &&
          !(validatorFor(storageSchema, false)(definition) instanceof ValidationError)
        if (stored && raw.nodes && typeof raw.nodes === 'object') {
          const reserved = Object.entries(raw.nodes).filter(([, node]) => {
            if (!node || typeof node !== 'object') return false
            const shape = node as Record<string, unknown>
            return (
              shape.kind === 'call' ||
              shape.kind === 'goto' ||
              (shape.kind === 'loop' && shape.body !== null && typeof shape.body === 'object')
            )
          })
          return {
            ok: false,
            issues: reserved.map(([id]) =>
              issue(
                'unsupported',
                ['nodes', id],
                'Node uses a reserved flow reference.',
                'Use an executable node kind or a local loop body.',
              ),
            ),
          }
        }
        issues.push(
          ...validationIssues(valid, []).filter(
            (item) => item.path[0] !== 'nodes' || item.path.length <= 1,
          ),
        )
      }
    } catch {
      issues.push(
        issue(
          'invalid_schema',
          ['nodes'],
          'A registered node schema cannot compile.',
          'Repair the registered JSON Schema.',
        ),
      )
    }
  }
  if (!raw.nodes || typeof raw.nodes !== 'object' || Array.isArray(raw.nodes))
    return { ok: false, issues }
  const def = definition as unknown as FlowDefinition
  const ids = Object.keys(def.nodes)
  const edges = new Map<string, Array<string>>()
  if (!ownNode(def.nodes, def.start))
    issues.push(
      issue('unknown_target', ['start'], 'Start node is missing.', 'Name an existing node.'),
    )
  const reads = new Map<string, Array<{ path: Array<string>; location: Array<string | number> }>>()
  for (const id of ids) {
    const n = def.nodes[id] as FlowNode
    if (!n || typeof n !== 'object' || Array.isArray(n) || typeof n.kind !== 'string') {
      issues.push(
        issue(
          'schema',
          ['nodes', id],
          'Node must be an object with a kind.',
          'Use a valid node kind and shape.',
        ),
      )
      continue
    }
    const kind = kinds.get(n.kind)
    if (!kind) {
      issues.push(
        issue(
          'unknown_kind',
          ['nodes', id, 'kind'],
          `Unknown kind ${n.kind}.`,
          'Register this kind or choose a built-in kind.',
        ),
      )
      continue
    }
    try {
      const valid = validatorFor(kind.schema, false)(n)
      if (valid instanceof ValidationError) issues.push(...validationIssues(valid, ['nodes', id]))
    } catch {
      issues.push(
        issue(
          'invalid_schema',
          ['nodes', id],
          'Node schema cannot compile.',
          'Repair the registered node schema.',
        ),
      )
    }
    if (Object.hasOwn(n, 'retry')) {
      try {
        if (!kind.retries) throw new TypeError('Kind does not retry')
        const policy = n.retry as FlowRetryPolicy
        assertRetryPolicy(policy)
        if (
          policy.suspendAfterMs !== undefined &&
          (!Number.isInteger(policy.suspendAfterMs) ||
            policy.suspendAfterMs < 0 ||
            policy.suspendAfterMs > 2147483647 ||
            (policy.totalTimeoutMs !== undefined && policy.suspendAfterMs >= policy.totalTimeoutMs))
        )
          throw new RangeError('Invalid suspend threshold')
      } catch {
        issues.push(
          issue(
            'invalid_retry',
            ['nodes', id, 'retry'],
            'Retry policy is invalid.',
            'Use bounded retry values on a retrying kind.',
          ),
        )
      }
    }
    if (n.kind === 'action' && actions && !Object.hasOwn(actions, n.name as string))
      issues.push(
        issue(
          'unknown_action',
          ['nodes', id, 'name'],
          'Action is not registered.',
          'Register the action or choose an existing name.',
        ),
      )
    let outgoing: ReturnType<NodeKind['targets']>
    try {
      outgoing = kind.targets(n)
    } catch {
      issues.push(
        issue(
          'schema',
          ['nodes', id],
          'Node targets cannot be read.',
          'Follow the node kind schema.',
        ),
      )
      continue
    }
    edges.set(
      id,
      outgoing.map((e) => e.id),
    )
    for (const edge of outgoing)
      if (!ownNode(def.nodes, edge.id))
        issues.push(
          issue(
            'unknown_target',
            ['nodes', id, ...edge.path],
            'Target node is missing.',
            'Name an existing node.',
          ),
        )
    const nodeReads: Array<{ path: Array<string>; location: Array<string | number> }> = []
    const walk = (value: unknown, location: Array<string | number>): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          walk(item, [...location, i])
        })
        return
      }
      const obj = value as Record<string, unknown>
      const container = location.at(-1)
      if (
        Object.hasOwn(obj, 'value') &&
        Object.keys(obj).length === 1 &&
        container !== 'output' &&
        container !== 'args' &&
        container !== 'object'
      )
        return
      if (Array.isArray(obj.ref))
        nodeReads.push({ path: obj.ref as Array<string>, location: [...location, 'ref'] })
      const writing = n.kind === 'set' && location.length === 4 && location[2] === 'assign'
      // Only filter leaves and set targets are paths; kinds may use `path` fields for other data.
      const isPath = writing || (Object.hasOwn(obj, 'is') && typeof obj.is === 'object')
      if (isPath && Array.isArray(obj.path) && obj.path.every((part) => typeof part === 'string')) {
        const p = obj.path as Array<string>
        if (writing && (p[0] !== 'state' || p.length < 2))
          issues.push(
            issue(
              'invalid_path',
              [...location, 'path'],
              'Set target must be under state.',
              'Use a state path with at least one key.',
            ),
          )
        else if (!writing) nodeReads.push({ path: p, location: [...location, 'path'] })
        if (p.some((part) => !isSafePathSegment(part)))
          issues.push(
            issue(
              'invalid_path',
              [...location, 'path'],
              'Path has an unsafe segment.',
              'Remove prototype-sensitive keys.',
            ),
          )
      }
      for (const [key, item] of Object.entries(obj))
        if (key !== 'schema' && key !== 'retry') walk(item, [...location, key])
    }
    walk(n, ['nodes', id])
    reads.set(id, nodeReads)
    if (n.kind === 'input' && n.schema)
      try {
        validatorFor(n.schema as Schema)
      } catch {
        issues.push(
          issue(
            'invalid_schema',
            ['nodes', id, 'schema'],
            'Input schema cannot compile.',
            'Repair the JSON Schema.',
          ),
        )
      }
    if (kind.resultSchema)
      try {
        const s = kind.resultSchema(n) as Schema & { properties?: Record<string, unknown> }
        validatorFor(s)
        if (s.properties?.error)
          issues.push(
            issue(
              'invalid_schema',
              ['nodes', id],
              'Result schema reserves error.',
              'Remove top-level error from resultSchema.',
            ),
          )
      } catch {
        issues.push(
          issue(
            'invalid_schema',
            ['nodes', id],
            'Result schema cannot compile.',
            'Repair the JSON Schema.',
          ),
        )
      }
    issues.push(...(kind.check?.(n, { definition: def, nodeID: id, issue }) ?? []))
  }
  if (def.input)
    try {
      validatorFor(def.input)
    } catch {
      issues.push(
        issue(
          'invalid_schema',
          ['input'],
          'Input schema cannot compile.',
          'Repair the JSON Schema.',
        ),
      )
    }
  const reachable = new Set<string>()
  const visit = (id: string): void => {
    if (reachable.has(id) || !ownNode(def.nodes, id)) return
    reachable.add(id)
    for (const next of edges.get(id) ?? []) visit(next)
  }
  visit(def.start)
  for (const id of ids) {
    if (!reachable.has(id))
      issues.push(
        issue(
          'unreachable',
          ['nodes', id],
          'Node cannot be reached from start.',
          'Connect it or remove it.',
          'warning',
        ),
      )
    if (!containsEnd(def, edges, id))
      issues.push(
        issue('no_end', ['nodes', id], 'No end node is reachable.', 'Add a path to an end node.'),
      )
  }
  const stripped = new Map(
    [...edges].map(([id, next]) => [
      id,
      next.filter(
        (target) =>
          ownNode(def.nodes, id)?.kind !== 'loop' || ownNode(def.nodes, id)?.body !== target,
      ),
    ]),
  )
  const done = new Set<string>()
  const cycle = (id: string, stack = new Set<string>()): boolean => {
    if (stack.has(id)) return true
    if (done.has(id)) return false
    stack.add(id)
    for (const next of stripped.get(id) ?? []) if (cycle(next, stack)) return true
    stack.delete(id)
    done.add(id)
    return false
  }
  if (ids.some((id) => cycle(id)))
    issues.push(
      issue(
        'unbounded_cycle',
        ['nodes'],
        'Cycle does not traverse a loop body edge.',
        'Route cycles through a loop body edge.',
      ),
    )
  const predecessors = new Map(ids.map((id) => [id, [] as Array<string>]))
  for (const [id, targets] of edges)
    for (const target of targets) predecessors.get(target)?.push(id)
  const dominators = new Map(ids.map((id) => [id, new Set(id === def.start ? [id] : ids)]))
  for (let changed = true; changed; ) {
    changed = false
    for (const id of ids) {
      if (id === def.start) continue
      const incoming = predecessors.get(id) ?? []
      const next = new Set([
        id,
        ...ids.filter(
          (candidate) =>
            incoming.length > 0 && incoming.every((p) => dominators.get(p)?.has(candidate)),
        ),
      ])
      const old = dominators.get(id)
      if (!old) continue
      if (next.size !== old.size || [...next].some((x) => !old.has(x))) {
        dominators.set(id, next)
        changed = true
      }
    }
  }
  for (const [id, refs] of reads)
    for (const ref of refs) {
      const [root, producer, ...rest] = ref.path
      if (
        !['input', 'state', 'results', 'loops'].includes(root as string) ||
        ref.path.some((part) => !isSafePathSegment(part))
      ) {
        issues.push(
          issue(
            'invalid_path',
            ref.location,
            'Invalid scope path.',
            'Use a safe input, state, results or loops path.',
          ),
        )
        continue
      }
      if (root === 'results' && (!producer || !ownNode(def.nodes, producer))) {
        issues.push(
          issue(
            'invalid_path',
            ref.location,
            'Result producer does not exist.',
            'Name an existing node after results.',
          ),
        )
        continue
      }
      if (root === 'loops' && (!producer || ownNode(def.nodes, producer)?.kind !== 'loop'))
        issues.push(
          issue(
            'invalid_path',
            ref.location,
            'Loop path does not name a loop.',
            'Name an existing loop node.',
          ),
        )
      if (root === 'results' && producer && ownNode(def.nodes, producer)) {
        const p = ownNode(def.nodes, producer)
        if (!p) continue
        if (rest[0] === 'error' && p.onError) {
          if (
            (rest.length > 1 &&
              !['type', 'code', 'status', 'reason', 'attempts'].includes(rest[1] as string)) ||
            rest.length > 2
          )
            issues.push(
              issue(
                'invalid_error_path',
                ref.location,
                'Unknown handled-error field.',
                'Use type, code, status, reason or attempts.',
              ),
            )
        } else {
          const kind = kinds.get(p.kind)
          if (kind?.resultSchema && rest.length > 0 && !schemaHasPath(kind.resultSchema(p), rest))
            issues.push(
              issue(
                'invalid_result_path',
                ref.location,
                'Result field is not declared.',
                'Reference a field in the producer resultSchema.',
              ),
            )
        }
        if (id !== producer && !dominators.get(id)?.has(producer))
          issues.push(
            issue(
              'result_maybe_missing',
              ref.location,
              'Producer may not run before this read.',
              'Guard the missing result or change graph edges.',
              'warning',
            ),
          )
      }
    }
  return { ok: !issues.some((i) => i.severity === 'error'), issues }
}
