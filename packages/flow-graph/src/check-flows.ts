import { isJSONValue } from '@sozai/json'

import { checkResult, issue } from './issue.js'
import { collectNodeReads } from './reads.js'
import type { FlowReference } from './reference-kinds.js'
import type { DefinitionCheck } from './resolver.js'
import { ANNOTATION_KEYS } from './result-paths.js'
import type { FlowCheckResult, FlowDefinition, FlowIssue, FlowResolver, NodeKind } from './types.js'

/** Inputs used to check a definition together with the flows it references. */
export type CheckFlowsParams = {
  definition: unknown
  /** Local check of the root definition. */
  check: DefinitionCheck
  /** Local check of resolved flows; may cache by content. */
  checkReference: DefinitionCheck
  resolver: FlowResolver
  kinds: Map<string, NodeKind>
  /** Passed to the resolver so a lookup can stop once the run aborts. */
  signal?: AbortSignal
  /** Result of `check` for `definition` when the caller already has it; skips checking it again. */
  local?: FlowCheckResult
}

type Path = Array<string | number>

/** Reference held by a node: `call`, `goto`, or a loop with a flow body. */
type Reference = {
  edge: 'call' | 'goto' | 'body'
  nodeID: string
  ref: FlowReference
  /** Path of the reference object inside its definition. */
  path: Path
}

/** Resolved flow that passed local `check`. */
type Flow = { key: string; definition: FlowDefinition; prefix: Path; references: Array<Reference> }

/** Reference from a checked flow; `to` is the resolved flow key, absent when it is missing. */
type Link = { from: Flow; reference: Reference; to?: string }

type CycleParams = {
  links: Array<Link>
  report: (link: Link) => boolean
  push: (link: Link) => void
}

/** Links indexed by the key of the flow that holds them. */
type LinkIndex = {
  /** `goto` links of each flow. */
  gotos: Map<string, Array<Link>>
  /** First non-`goto` link of each flow, by referencing node id. */
  producers: Map<string, Map<string, Link>>
}

type OutputKeysParams = {
  key: string
  flows: Map<string, Flow>
  index: LinkIndex
  kinds: Map<string, NodeKind>
}

const INPUT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const flowKey = (id: string, version: unknown): string => JSON.stringify([id, version])

/** Whether a resolved value names the referenced flow and, when pinned, its version. */
export function matchesReference(value: unknown, ref: { flow: string; version?: number }): boolean {
  if (!isRecord(value)) {
    return false
  }

  return value.id === ref.flow && (ref.version === undefined || value.version === ref.version)
}

function referencesOf(definition: FlowDefinition): Array<Reference> {
  const references: Array<Reference> = []

  for (const [nodeID, node] of Object.entries(definition.nodes)) {
    if (node.kind === 'call' || node.kind === 'goto') {
      references.push({
        edge: node.kind,
        nodeID,
        ref: node as unknown as FlowReference,
        path: ['nodes', nodeID],
      })
    } else if (node.kind === 'loop' && isRecord(node.body)) {
      references.push({
        edge: 'body',
        nodeID,
        ref: node.body as unknown as FlowReference,
        path: ['nodes', nodeID, 'body'],
      })
    }
  }

  return references
}

function inputIssues(schema: unknown, reference: Reference, at: Path): Array<FlowIssue> {
  if (
    !isRecord(schema) ||
    schema.type !== 'object' ||
    !Object.keys(schema).every((key) => INPUT_KEYS.has(key) || ANNOTATION_KEYS.has(key)) ||
    (schema.properties !== undefined && !isRecord(schema.properties)) ||
    (schema.required !== undefined && !Array.isArray(schema.required))
  ) {
    // Only simple object schemas are checked statically.
    return []
  }

  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const required = (schema.required ?? []) as Array<unknown>
  const input = reference.ref.input ?? {}
  const issues: Array<FlowIssue> = []

  for (const key of required) {
    if (typeof key === 'string' && !Object.hasOwn(input, key)) {
      issues.push(
        issue({
          code: 'input_mismatch',
          path: [...at, 'input', key],
          message: 'Required callee input is missing.',
          hint: `Add the required ${key} input.`,
        }),
      )
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(properties, key)) {
        issues.push(
          issue({
            code: 'input_mismatch',
            path: [...at, 'input', key],
            message: 'Callee input does not accept this key.',
            hint: `Remove the unknown ${key} input.`,
          }),
        )
      }
    }
  }

  return issues
}

/** Map each flow key to its strongly connected component. */
function components(links: Array<Link>): Map<string, number> {
  const next = new Map<string, Array<string>>()

  for (const link of links) {
    if (link.to !== undefined) {
      next.set(link.from.key, [...(next.get(link.from.key) ?? []), link.to])
    }
  }

  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const component = new Map<string, number>()
  const stack: Array<string> = []
  let counter = 0
  let count = 0

  const visit = (key: string): void => {
    index.set(key, counter)
    low.set(key, counter)
    counter += 1
    stack.push(key)

    for (const target of next.get(key) ?? []) {
      if (!index.has(target)) {
        visit(target)
        low.set(key, Math.min(low.get(key) as number, low.get(target) as number))
      } else if (!component.has(target)) {
        low.set(key, Math.min(low.get(key) as number, index.get(target) as number))
      }
    }

    if (low.get(key) === index.get(key)) {
      let member: string | undefined

      do {
        member = stack.pop() as string
        component.set(member, count)
      } while (member !== key)

      count += 1
    }
  }

  for (const link of links) {
    for (const key of [link.from.key, link.to]) {
      if (key !== undefined && !index.has(key)) {
        visit(key)
      }
    }
  }

  return component
}

/** Report each cycle once, at the first matching link that lies on it. */
function reportCycles(params: CycleParams): void {
  const { links, report, push } = params
  const component = components(links)
  const reported = new Set<number>()

  for (const link of links) {
    const from = component.get(link.from.key)

    if (
      link.to !== undefined &&
      from !== undefined &&
      from === component.get(link.to) &&
      !reported.has(from) &&
      report(link)
    ) {
      reported.add(from)
      push(link)
    }
  }
}

/** Index links by their source flow so lookups per read are not scans over every link. */
function indexLinks(links: Array<Link>): LinkIndex {
  const gotos = new Map<string, Array<Link>>()
  const producers = new Map<string, Map<string, Link>>()

  for (const link of links) {
    const key = link.from.key

    if (link.reference.edge === 'goto') {
      const from = gotos.get(key)

      if (from) {
        from.push(link)
      } else {
        gotos.set(key, [link])
      }
    } else {
      let byNode = producers.get(key)

      if (!byNode) {
        byNode = new Map()

        producers.set(key, byNode)
      }

      if (!byNode.has(link.reference.nodeID)) {
        byNode.set(link.reference.nodeID, link)
      }
    }
  }

  return { gotos, producers }
}

/**
 * `end.output` keys of a flow and every flow it reaches by `goto`, or `undefined` when they are
 * unconstrained: a terminal custom kind may end with any output, and an unresolved flow is unknown.
 */
function outputKeys(params: OutputKeysParams): Set<string> | undefined {
  const { key, flows, index, kinds } = params
  const keys = new Set<string>()
  const seen = new Set([key])
  const queue = [key]

  for (let position = 0; position < queue.length; position++) {
    const flow = flows.get(queue[position] as string)

    if (!flow) {
      return undefined
    }

    for (const node of Object.values(flow.definition.nodes)) {
      if (node.kind === 'end') {
        for (const name of Object.keys(isRecord(node.output) ? node.output : {})) {
          keys.add(name)
        }
      } else if (kinds.get(node.kind)?.terminal === true) {
        return undefined
      }
    }

    for (const link of index.gotos.get(flow.key) ?? []) {
      if (link.to === undefined) {
        return undefined
      }

      if (!seen.has(link.to)) {
        seen.add(link.to)
        queue.push(link.to)
      }
    }
  }

  return keys
}

function resultPathIssues(params: {
  flows: Map<string, Flow>
  links: Array<Link>
  kinds: Map<string, NodeKind>
}): Array<FlowIssue> {
  const { flows, links, kinds } = params
  const index = indexLinks(links)
  const issues: Array<FlowIssue> = []
  const cache = new Map<string, Set<string> | undefined>()

  const keysOf = (key: string): Set<string> | undefined => {
    if (!cache.has(key)) {
      cache.set(key, outputKeys({ key, flows, index, kinds }))
    }

    return cache.get(key)
  }

  for (const flow of flows.values()) {
    const producers = index.producers.get(flow.key)

    for (const [nodeID, node] of Object.entries(flow.definition.nodes)) {
      for (const read of collectNodeReads(node, nodeID, [])) {
        const [root, producer, field, key] = read.path

        if (root !== 'results' || field !== 'output' || key === undefined) {
          continue
        }

        const link = typeof producer === 'string' ? producers?.get(producer) : undefined

        const keys = link?.to === undefined ? undefined : keysOf(link.to)

        if (keys && !keys.has(key)) {
          issues.push(
            issue({
              code: 'invalid_result_path',
              path: [...flow.prefix, ...read.location],
              message: 'Callee does not return this output key.',
              hint: 'Reference an end output key of the callee or of a flow it reaches by goto.',
            }),
          )
        }
      }
    }
  }

  return issues
}

/**
 * Check a definition, then resolve its references breadth first and check the flow set as
 * resolved now. Issues inside a resolved flow are prefixed with `['flows', id, version]`.
 */
export async function checkFlows(params: CheckFlowsParams): Promise<FlowCheckResult> {
  const { definition, check, checkReference, resolver, kinds, signal } = params
  const local = params.local ?? check(definition)

  if (local.issues) {
    return { issues: [...local.issues] }
  }

  const issues = [...local.warnings]
  const root = definition as FlowDefinition

  const rootFlow: Flow = {
    key: flowKey(root.id, root.version),
    definition: root,
    prefix: [],
    references: referencesOf(root),
  }

  const flows = new Map([[rootFlow.key, rootFlow]])
  const invalid = new Set<string>()
  /** Resolved flow key by reference, or the reason the reference did not resolve. */
  const resolved = new Map<string, { key: string } | { missing: string }>()
  const links: Array<Link> = []
  const queue = [rootFlow]

  const resolve = async (ref: FlowReference): Promise<{ key: string } | { missing: string }> => {
    let value: unknown

    try {
      value = await resolver.resolve(ref.flow, ref.version, { signal })
    } catch {
      // The resolver error itself may carry private data.
      return { missing: 'Referenced flow cannot be resolved.' }
    }

    if (!matchesReference(value, ref)) {
      return { missing: 'Resolved flow does not match the referenced id or version.' }
    }

    const { version } = value as { version: unknown }
    const key = flowKey(ref.flow, version)

    if (flows.has(key) || invalid.has(key)) {
      return { key }
    }

    const prefix: Path = ['flows', ref.flow, version as number]
    // Check a snapshot, as the runner does at push time.
    const snapshot = isJSONValue(value) ? structuredClone(value) : value
    const result = checkReference(snapshot)

    const found = result.issues ?? result.warnings

    issues.push(...found.map((item) => ({ ...item, path: [...prefix, ...item.path] })))

    if (result.issues) {
      invalid.add(key)

      return { key }
    }

    const flow: Flow = {
      key,
      definition: snapshot as FlowDefinition,
      prefix,
      references: referencesOf(snapshot as FlowDefinition),
    }

    flows.set(key, flow)
    queue.push(flow)

    return { key }
  }

  for (let position = 0; position < queue.length; position++) {
    const flow = queue[position] as Flow

    for (const reference of flow.references) {
      const at = [...flow.prefix, ...reference.path]
      const { ref } = reference

      if (ref.version === undefined) {
        issues.push(
          issue({
            code: 'unversioned_reference',
            path: [...at, 'flow'],
            message: 'Reference has no version; it resolves when the node runs.',
            hint: 'Pin a version: the resolved flow may change between runs and drop output keys.',
            severity: 'warning',
          }),
        )
      }

      const refKey = JSON.stringify([ref.flow, ref.version ?? null])

      let outcome = resolved.get(refKey)

      if (!outcome) {
        outcome = await resolve(ref)

        resolved.set(refKey, outcome)
      }

      const to = 'key' in outcome ? outcome.key : undefined

      if ('missing' in outcome) {
        issues.push(
          issue({
            code: 'missing_flow',
            path: [...at, 'flow'],
            message: outcome.missing,
            hint: 'Register the flow and version with the resolver.',
          }),
        )
      }

      links.push({ from: flow, reference, ...(to !== undefined ? { to } : {}) })
    }
  }

  for (const link of links) {
    const callee = link.to === undefined ? undefined : flows.get(link.to)

    if (callee) {
      issues.push(
        ...inputIssues(callee.definition.input, link.reference, [
          ...link.from.prefix,
          ...link.reference.path,
        ]),
      )
    }
  }

  // Cycles only run through flows that passed local check.
  const checked = links.filter((link) => link.to !== undefined && flows.has(link.to))

  const at = (link: Link): Path => [...link.from.prefix, ...link.reference.path, 'flow']

  reportCycles({
    links: checked.filter((link) => link.reference.edge === 'goto'),
    report: () => true,
    push: (link) =>
      issues.push(
        issue({
          code: 'unbounded_cycle',
          path: at(link),
          message: 'Flows hand over to each other through goto in a cycle.',
          hint: 'Break the goto cycle, or loop inside one flow.',
        }),
      ),
  })

  reportCycles({
    links: checked,
    report: (link) => link.reference.edge !== 'goto',
    push: (link) =>
      issues.push(
        issue({
          code: 'recursive_call',
          path: at(link),
          message: 'Flows call each other recursively.',
          hint: 'Bound the recursion: runs deeper than maxDepth frames fail with max_depth.',
          severity: 'warning',
        }),
      ),
  })

  issues.push(...resultPathIssues({ flows, links, kinds }))

  return checkResult(definition, issues)
}
