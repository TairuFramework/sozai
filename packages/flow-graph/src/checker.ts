import { assertRetryPolicy } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import type { Schema } from '@sozai/schema'
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
const child = (schema: unknown, key: string): unknown => {
  if (!schema || typeof schema !== 'object') return undefined
  const shape = schema as { properties?: Record<string, unknown>; additionalProperties?: unknown }
  if (shape.properties?.[key]) return shape.properties[key]
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
  if (definition.nodes[start]?.kind === 'end') return true
  return (edges.get(start) ?? []).some((next) => containsEnd(definition, edges, next, visited))
}

export function checkDefinition(
  definition: unknown,
  kinds: Map<string, NodeKind>,
  actions?: Record<string, unknown>,
  authoringSchema?: Schema,
  storageSchema?: Schema,
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
      const valid = createValidator(authoringSchema, { strict: false })(definition)
      if (valid instanceof ValidationError) {
        const stored =
          storageSchema &&
          !(
            createValidator(storageSchema, { strict: false })(definition) instanceof ValidationError
          )
        issues.push(
          stored
            ? issue(
                'unsupported',
                ['nodes'],
                'Definition uses a reserved kind or flow reference.',
                'Use only executable node kinds in v1.',
              )
            : issue(
                'schema',
                [],
                'Definition does not match the authoring schema.',
                'Fix required fields and node shapes using authoringSchema.',
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
  if (!def.nodes[def.start])
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
      if (createValidator(kind.schema, { strict: false })(n) instanceof ValidationError)
        issues.push(
          issue(
            'schema',
            ['nodes', id],
            'Node has an invalid shape.',
            'Follow the node kind schema.',
          ),
        )
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
    if ('retry' in n) {
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
    if (n.kind === 'action' && actions && !((n.name as string) in actions))
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
      if (!def.nodes[edge.id])
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
      if (Array.isArray(obj.path) && obj.path.every((part) => typeof part === 'string')) {
        const p = obj.path as Array<string>
        const writing = location.includes('assign')
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
        createValidator(n.schema as Schema)
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
        createValidator(kind.resultSchema(n))
        const s = kind.resultSchema(n) as { properties?: Record<string, unknown> }
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
      createValidator(def.input)
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
    if (reachable.has(id) || !def.nodes[id]) return
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
      next.filter((target) => def.nodes[id]?.kind !== 'loop' || def.nodes[id]?.body !== target),
    ]),
  )
  const cycle = (id: string, stack = new Set<string>(), done = new Set<string>()): boolean => {
    if (stack.has(id)) return true
    if (done.has(id)) return false
    stack.add(id)
    for (const next of stripped.get(id) ?? []) if (cycle(next, stack, done)) return true
    stack.delete(id)
    done.add(id)
    return false
  }
  if (cycle(def.start))
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
      if (root === 'results' && (!producer || !def.nodes[producer])) {
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
      if (root === 'loops' && (!producer || def.nodes[producer]?.kind !== 'loop'))
        issues.push(
          issue(
            'invalid_path',
            ref.location,
            'Loop path does not name a loop.',
            'Name an existing loop node.',
          ),
        )
      if (root === 'results' && producer && def.nodes[producer]) {
        const p = def.nodes[producer]
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
