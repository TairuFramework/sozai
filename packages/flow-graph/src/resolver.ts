import { isJSONValue, type JSONValue } from '@sozai/json'

import { digestDefinition } from './digest.js'
import { FlowReferenceError, FlowStateError, FlowVersionMismatchError } from './errors.js'
import type { FlowDefinition, FlowIssue, FlowResolver, Frame } from './types.js'

/** Local definition check used while preparing a snapshot. */
export type DefinitionCheck = (definition: unknown) => { ok: boolean; issues: Array<FlowIssue> }

/** Checked definition snapshot and the pin that identifies it in run state. */
export type PreparedFlow = {
  definition: FlowDefinition
  pin: { id: string; version: number; digest: string }
}

/** Parameters for snapshotting a new definition. */
export type PrepareDefinitionParams = { value: unknown; check: DefinitionCheck }

/** Parameters for snapshotting a definition resolved for a pinned frame. */
export type PreparePinnedParams = { value: unknown; pin: Frame['flow']; check: DefinitionCheck }

/** In-memory resolver. Unversioned lookup returns the highest version. */
export function createMapResolver(definitions: Array<FlowDefinition>): FlowResolver {
  const byID = new Map<string, Map<number, FlowDefinition>>()

  for (const definition of definitions) {
    let versions = byID.get(definition.id)

    if (!versions) {
      versions = new Map()

      byID.set(definition.id, versions)
    }

    if (versions.has(definition.version)) {
      throw new TypeError(
        `Duplicate flow definition: ${definition.id} version ${definition.version}`,
      )
    }

    versions.set(definition.version, definition)
  }

  return {
    resolve(id, version) {
      const versions = byID.get(id)

      const definition = versions?.get(
        version === undefined ? Math.max(...versions.keys()) : version,
      )

      if (!definition) {
        throw new FlowReferenceError({ id, version })
      }

      return definition
    },
  }
}

/** Snapshot a JSON definition, check it, and compute its pin. */
export function prepareDefinition(
  params: PrepareDefinitionParams,
): { ok: true; flow: PreparedFlow } | { ok: false; issues: Array<FlowIssue> } {
  const { value, check } = params

  if (!isJSONValue(value)) {
    // The checker reports non-JSON input as its `schema` issue.
    return { ok: false, issues: check(value).issues }
  }

  const definition = structuredClone(value) as unknown as FlowDefinition
  const result = check(definition)

  if (!result.ok) {
    return { ok: false, issues: result.issues }
  }

  return { ok: true, flow: { definition, pin: pinOf(definition) } }
}

/** Snapshot a definition resolved for a pinned frame, verify the pin, then check it. */
export function preparePinned(params: PreparePinnedParams): PreparedFlow {
  const { value, pin, check } = params

  if (!isJSONValue(value) || typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FlowVersionMismatchError()
  }

  const definition = structuredClone(value) as unknown as FlowDefinition
  const snapshot = pinOf(definition)

  if (
    snapshot.id !== pin.id ||
    snapshot.version !== pin.version ||
    snapshot.digest !== pin.digest
  ) {
    throw new FlowVersionMismatchError()
  }

  const result = check(definition)

  if (!result.ok) {
    throw new FlowStateError({ issues: result.issues })
  }

  return { definition, pin: snapshot }
}

function pinOf(definition: FlowDefinition): PreparedFlow['pin'] {
  return {
    id: definition.id,
    version: definition.version,
    digest: digestDefinition(definition as unknown as JSONValue),
  }
}
