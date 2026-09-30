import { isJSONValue, type JSONValue } from '@sozai/json'
import { getSozaiLogger, isSetup } from '@sozai/log'
import { traceLogger } from '@sozai/otel'
import { createRuntime } from '@sozai/runtime'
import { ValidationError } from '@sozai/schema'

import { checkFlows, matchesReference } from './check-flows.js'
import { checkDefinition } from './checker.js'
import { digestDefinition } from './digest.js'
import {
  FlowDefinitionError,
  FlowInputError,
  FlowNodeFailure,
  FlowReferenceError,
  FlowResumeError,
  FlowStateError,
  FlowVersionMismatchError,
} from './errors.js'
import { defaultMaxDepth } from './frames.js'
import type { ReferenceService } from './reference-kinds.js'
import { createKindRegistry, createValidatorCache } from './registry.js'
import type { DefinitionCheck, PreparedFlow } from './resolver.js'
import { prepareDefinition, preparePinned } from './resolver.js'
import { validateResumeEvent } from './resume.js'
import { FlowRunner } from './run.js'
import { required } from './run-utils.js'
import { makeDefinitionSchema, runStateSchema } from './schemas.js'
import { assertRunStateDefinitions, assertRunStateShape } from './state.js'
import type {
  FlowCheckResult,
  FlowDefinition,
  FlowGraph,
  FlowGraphOptions,
  FlowResolver,
  FlowRun,
  RecoverParams,
  ResumeParams,
  RunState,
  StartParams,
} from './types.js'

/** Maximum number of resolved callee check results a graph keeps. */
const CALLEE_CHECK_CACHE_SIZE = 64

/** Create a graph runtime with registered kinds and lifecycle operations. */
export function createFlowGraph(options: FlowGraphOptions = {}): FlowGraph {
  const now = options.now ?? Date.now
  const runtime = options.runtime ?? createRuntime()
  const logger = options.logger ?? getSozaiLogger('flow-graph')
  // Kinds hold the service; it only calls `check` at run time, after the registry exists.
  const references: ReferenceService = {
    prepare: (ref, input, resolveOptions) => prepareReference(ref, input, resolveOptions),
  }
  const kinds = createKindRegistry(options, now, references)
  const authoringSchema = makeDefinitionSchema([...kinds.values()])
  const validatorFor = createValidatorCache()

  const check = (definition: unknown) =>
    checkDefinition({
      definition,
      kinds,
      actions: options.actions,
      authoringSchema,
      validatorFor,
    })

  // Least recently used entries come first; a hit moves its entry to the end.
  const checked = new Map<string, FlowCheckResult>()

  // Local check results of resolved callees, cached by digest. Root drafts use plain `check`.
  const checkCallee: DefinitionCheck = (definition) => {
    if (!isJSONValue(definition)) {
      return check(definition)
    }

    const digest = digestDefinition(definition)
    const result = checked.get(digest) ?? check(definition)

    checked.delete(digest)
    checked.set(digest, result)

    if (checked.size > CALLEE_CHECK_CACHE_SIZE) {
      checked.delete(checked.keys().next().value as string)
    }

    return result.issues
      ? { issues: [...result.issues] }
      : { value: definition as unknown as FlowDefinition, warnings: [...result.warnings] }
  }

  const prepareReference = async (
    ref: { flow: string; version?: number },
    input: JSONValue,
    resolveOptions?: { signal?: AbortSignal },
  ): Promise<PreparedFlow> => {
    let value: unknown

    try {
      value = await required(options.resolver, ['resolver']).resolve(
        ref.flow,
        ref.version,
        resolveOptions,
      )
    } catch {
      // biome-ignore lint/style/useErrorCause: resolver errors may carry private data
      throw new FlowNodeFailure({ code: 'missing_flow' })
    }

    if (!matchesReference(value, ref)) {
      throw new FlowNodeFailure({ code: 'missing_flow' })
    }

    const prepared = prepareDefinition({ value, check: checkCallee })

    if (!prepared.ok) {
      throw new FlowNodeFailure({ code: 'invalid_flow' })
    }

    const schema = prepared.flow.definition.input

    if (schema && validatorFor(schema)(input) instanceof ValidationError) {
      throw new FlowNodeFailure({ code: 'invalid_input' })
    }

    return prepared.flow
  }

  const logError = (message: string, metadata: Record<string, unknown>) => {
    if (isSetup()) {
      traceLogger(logger).error(message, metadata)
    } else {
      console.error(`[@sozai/flow-graph] ${message}`, metadata)
    }
  }

  const warn = (message: string, metadata: Record<string, unknown>) =>
    traceLogger(logger).warn(message, metadata)

  const maxDepth = options.maxDepth ?? defaultMaxDepth

  /** Snapshot and check a root definition; `local` is the check result of the snapshot. */
  const snapshot = (definition: FlowDefinition): PreparedFlow & { local: FlowCheckResult } => {
    let local: FlowCheckResult | undefined

    const prepared = prepareDefinition({
      value: definition,
      check: (value) => {
        local = check(value)

        return local
      },
    })

    if (!prepared.ok) {
      logError('Invalid flow definition', {
        'flow.id': typeof definition?.id === 'string' ? definition.id : undefined,
        code: 'invalid_definition',
        issues: prepared.issues.map((issue) => issue.code),
      })

      throw new FlowDefinitionError({ issues: prepared.issues })
    }

    return { ...prepared.flow, local: required(local, ['definition']) }
  }

  const invalidState = (error: unknown, flowID: string | undefined): never => {
    logError('Invalid run state', { 'flow.id': flowID, code: 'invalid_state' })

    if (error instanceof FlowStateError) {
      throw error
    }

    throw new FlowStateError({ issues: [{ message: 'Run state validation failed.', path: [] }] })
  }

  const requireResolver = (operation: 'resume' | 'recover'): FlowResolver => {
    if (!options.resolver) {
      throw new TypeError(`${operation} requires a flow resolver`)
    }

    return options.resolver
  }

  const validateShape = (runState: RunState) => {
    try {
      assertRunStateShape(runState, { maxDepth, validatorFor })
    } catch (error) {
      const root = (runState as { frames?: Array<{ flow?: { id?: unknown } }> } | undefined)
        ?.frames?.[0]?.flow?.id

      invalidState(error, typeof root === 'string' ? root : undefined)
    }
  }

  const resolveFrames = async (params: {
    resolver: FlowResolver
    state: RunState
    signal?: AbortSignal
  }): Promise<Array<FlowDefinition>> => {
    const { resolver, state, signal } = params
    const definitions: Array<FlowDefinition> = []

    for (const frame of state.frames) {
      const value = await resolver.resolve(frame.flow.id, frame.flow.version, { signal })

      try {
        definitions.push(preparePinned({ value, pin: frame.flow, check }).definition)
      } catch (error) {
        if (error instanceof FlowVersionMismatchError) {
          logError('Flow version mismatch', { 'flow.id': frame.flow.id, code: 'version_mismatch' })

          throw error
        }

        invalidState(error, frame.flow.id)
      }
    }

    try {
      assertRunStateDefinitions({ state, definitions, kinds })
    } catch (error) {
      invalidState(error, state.frames[0]?.flow.id)
    }

    return definitions
  }

  const makeRun = (params: {
    definitions: Array<FlowDefinition>
    prepare?: (state: RunState) => Promise<Array<FlowDefinition>>
    initial: RunState
    mode: 'start' | 'resume' | 'recover'
    signal?: AbortSignal
    parentContext?: StartParams['parentContext']
    event?: ResumeParams['event']
  }): FlowRun =>
    new FlowRunner({
      ...params,
      kinds,
      references,
      validatorFor,
      options,
      now,
      runtime,
      logger,
      logError,
      warn,
    }).run()

  // Without a resolver, every reference is reported as `missing_flow`.
  const flowResolver: FlowResolver = options.resolver ?? {
    resolve: (id, version) => {
      throw new FlowReferenceError({ id, version })
    },
  }

  const preflight = async (params: {
    definition: FlowDefinition
    local: FlowCheckResult
    signal?: AbortSignal
  }): Promise<Array<FlowDefinition>> => {
    const { definition, local, signal } = params

    const result = await checkFlows({
      definition,
      check,
      checkReference: checkCallee,
      resolver: flowResolver,
      kinds,
      signal,
      local,
    })

    if (result.issues) {
      logError('Invalid flow set', {
        'flow.id': definition.id,
        code: 'invalid_definition',
        issues: result.issues.map((issue) => issue.code),
      })

      throw new FlowDefinitionError({ issues: result.issues })
    }

    return [definition]
  }

  function start(params: StartParams): FlowRun {
    const { definition, pin, local } = snapshot(params.definition)
    const referencing = hasReferences(definition)

    if (!options.resolver && referencing) {
      throw new TypeError('start requires a flow resolver for a definition with references')
    }

    const input = params.input ?? null

    if (!isJSONValue(input)) {
      throw new FlowInputError({ issues: [{ message: 'Input must be a JSON value.', path: [] }] })
    }

    if (definition.input) {
      const result = validatorFor(definition.input)(input)

      if (result instanceof ValidationError) {
        throw new FlowInputError({ issues: result.issues })
      }
    }

    const state: RunState = {
      runID: params.runID ?? runtime.getRandomID(),
      revision: 0,
      status: 'running',
      steps: 0,
      invocation: 0,
      frames: [
        {
          flow: pin,
          node: definition.start,
          input,
          state: {},
          results: {},
          loops: {},
          attempts: {},
        },
      ],
    }

    return makeRun({
      definitions: [definition],
      // The cross-flow preflight runs lazily on the first `next()`; nothing is committed on failure.
      ...(referencing
        ? { prepare: () => preflight({ definition, local, signal: params.signal }) }
        : {}),
      initial: state,
      mode: 'start',
      signal: params.signal,
      parentContext: params.parentContext,
    })
  }

  function resume(params: ResumeParams): FlowRun {
    const resolver = requireResolver('resume')

    validateShape(params.runState)

    if (params.runState.status !== 'suspended') {
      throw new FlowResumeError({
        issues: [{ message: 'Run is not suspended.', path: ['status'] }],
      })
    }

    const pending = required(params.runState.pending, ['pending'])

    validateResumeEvent({ event: params.event, pending, now, validatorFor })

    return makeRun({
      definitions: [],
      prepare: (state) => resolveFrames({ resolver, state, signal: params.signal }),
      initial: params.runState,
      mode: 'resume',
      signal: params.signal,
      parentContext: params.parentContext,
      event: params.event,
    })
  }

  function recover(params: RecoverParams): FlowRun {
    const resolver = requireResolver('recover')

    validateShape(params.runState)

    if (params.runState.status !== 'running') {
      throw new FlowStateError({
        issues: [{ message: 'Recovery requires a running state.', path: ['status'] }],
      })
    }

    return makeRun({
      definitions: [],
      prepare: (state) => resolveFrames({ resolver, state, signal: params.signal }),
      initial: params.runState,
      mode: 'recover',
      signal: params.signal,
      parentContext: params.parentContext,
    })
  }

  async function run(params: StartParams) {
    const flow = start(params)

    try {
      for await (const _state of flow) {
        /* commit notifications are available from start() */
      }
    } catch (error) {
      // A rejected `next()` (such as the lazy preflight) leaves the segment open; end it.
      await flow.return()

      throw error
    }

    const runState = flow.getState()

    return {
      status: runState.status,
      ...(runState.outcome !== undefined ? { outcome: runState.outcome } : {}),
      ...(runState.output !== undefined ? { output: runState.output } : {}),
      ...(runState.pending ? { pending: runState.pending } : {}),
      ...(runState.error ? { error: runState.error } : {}),
      runState,
    }
  }

  return {
    authoringSchema,
    runStateSchema,
    check,
    checkFlows: (definition) =>
      checkFlows({ definition, check, checkReference: checkCallee, resolver: flowResolver, kinds }),
    start,
    resume,
    recover,
    run,
  }
}

function hasReferences(definition: FlowDefinition): boolean {
  return Object.values(definition.nodes).some(
    (node) =>
      node.kind === 'call' ||
      node.kind === 'goto' ||
      (node.kind === 'loop' && typeof node.body === 'object' && node.body !== null),
  )
}
