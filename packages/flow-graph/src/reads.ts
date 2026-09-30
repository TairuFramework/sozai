import { issue } from './issue.js'
import type { FlowIssue, FlowNode } from './types.js'
import { isSafePathSegment } from './value.js'

/** Scope path read by a node, with the location of the reading field. */
export type ReadReference = { path: Array<string>; location: Array<string | number> }

/** Collect the scope paths a node reads; invalid paths are reported in `issues`. */
export function collectNodeReads(
  node: FlowNode,
  nodeID: string,
  issues: Array<FlowIssue>,
): Array<ReadReference> {
  const nodeReads: Array<ReadReference> = []

  const walk = (value: unknown, location: Array<string | number>): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, [...location, index])
      })

      return
    }

    const object = value as Record<string, unknown>
    const container = location.at(-1)

    // Reference input maps (`call.input`, `goto.input`, `loop.body.input`) are value maps too.
    const referenceInput =
      container === 'input' &&
      (((node.kind === 'call' || node.kind === 'goto') && location.length === 3) ||
        (node.kind === 'loop' && location.length === 4 && location[2] === 'body'))

    if (
      Object.hasOwn(object, 'value') &&
      Object.keys(object).length === 1 &&
      container !== 'output' &&
      container !== 'args' &&
      container !== 'object' &&
      !referenceInput
    ) {
      return
    }

    if (Array.isArray(object.ref)) {
      nodeReads.push({ path: object.ref as Array<string>, location: [...location, 'ref'] })
    }

    const writing = node.kind === 'set' && location.length === 4 && location[2] === 'assign'
    // Only filter leaves and set targets are paths; kinds may use `path` fields for other data.
    const isPath = writing || (Object.hasOwn(object, 'is') && typeof object.is === 'object')

    if (
      isPath &&
      Array.isArray(object.path) &&
      object.path.every((part) => typeof part === 'string')
    ) {
      const path = object.path as Array<string>

      if (writing && (path[0] !== 'state' || path.length < 2)) {
        issues.push(
          issue({
            code: 'invalid_path',
            path: [...location, 'path'],
            message: 'Set target must be under state.',
            hint: 'Use a state path with at least one key.',
          }),
        )
      } else if (!writing) {
        nodeReads.push({ path: path, location: [...location, 'path'] })
      }

      if (path.some((part) => !isSafePathSegment(part))) {
        issues.push(
          issue({
            code: 'invalid_path',
            path: [...location, 'path'],
            message: 'Path has an unsafe segment.',
            hint: 'Remove prototype-sensitive keys.',
          }),
        )
      }
    }

    for (const [key, item] of Object.entries(object)) {
      if (key !== 'schema' && key !== 'retry') {
        walk(item, [...location, key])
      }
    }
  }

  walk(node, ['nodes', nodeID])

  return nodeReads
}
