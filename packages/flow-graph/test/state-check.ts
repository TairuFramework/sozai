import type { JSONValue } from '@sozai/json'

import type { FlowDefinition, NodeKind, RegisteredNodeKind, RunState } from '../src/index.js'
import { digestDefinition } from '../src/index.js'
import { builtinKinds } from '../src/kinds.js'
import { unavailableReferences } from '../src/reference-kinds.js'
import { assertRunStateDefinitions, assertRunStateShape } from '../src/state.js'

const pinKey = (id: string, version: number, digest: string) =>
  JSON.stringify([id, version, digest])

const known = new Map<string, FlowDefinition>()

const builtins = builtinKinds({ now: Date.now, references: unavailableReferences })

/** Kind map of a graph: the built-in kinds plus the given custom kinds. */
const kindMap = (custom: Array<RegisteredNodeKind> = []): Map<string, NodeKind> =>
  new Map([...builtins, ...custom].map((kind) => [kind.kind, kind as unknown as NodeKind] as const))

/** Remember definitions (as they are now) so `assertStates` can match frame pins to them. */
export function remember<Definition extends FlowDefinition>(definition: Definition): Definition {
  const snapshot = structuredClone(definition)
  const digest = digestDefinition(snapshot as unknown as JSONValue)

  known.set(pinKey(snapshot.id, snapshot.version, digest), snapshot)

  return definition
}

/** Options for `assertStates`. */
export type AssertStatesOptions = {
  maxDepth?: number
  /** Custom kinds registered with the graph that produced the states. */
  kinds?: Array<RegisteredNodeKind>
}

/**
 * Assert that every state passes the persisted-state shape check and fits the remembered
 * definitions of its frames, as `resume` and `recover` would check it.
 */
export function assertStates(states: Iterable<RunState>, options: AssertStatesOptions = {}): void {
  const { maxDepth = 16 } = options
  const kinds = kindMap(options.kinds)

  for (const state of states) {
    const copy = JSON.parse(JSON.stringify(state)) as RunState

    assertRunStateShape(copy, { maxDepth })

    const definitions = copy.frames.map((frame) => {
      const definition = known.get(pinKey(frame.flow.id, frame.flow.version, frame.flow.digest))

      if (!definition) {
        throw new Error(`No remembered definition for ${frame.flow.id}@${frame.flow.version}`)
      }

      return definition
    })

    assertRunStateDefinitions({ state: copy, definitions, kinds })
  }
}
