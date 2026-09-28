import type { JSONValue } from '@sozai/json'
import { isJSONValue } from '@sozai/json'
import { getSozaiLogger, isSetup } from '@sozai/log'
import { traceLogger } from '@sozai/otel'
import { createRuntime } from '@sozai/runtime'
import { ValidationError } from '@sozai/schema'

import { checkDefinition } from './checker.js'
import { digestDefinition } from './digest.js'
import {
  FlowDefinitionError,
  FlowInputError,
  FlowResumeError,
  FlowStateError,
  FlowVersionMismatchError,
} from './errors.js'
import { createKindRegistry, createValidatorCache } from './registry.js'
import { validateResumeEvent } from './resume.js'
import { FlowRunner } from './run.js'
import { required } from './run-utils.js'
import { makeDefinitionSchema, runStateSchema } from './schemas.js'
import { assertRunState } from './state.js'
import type {
  FlowDefinition,
  FlowGraph,
  FlowGraphOptions,
  FlowRun,
  RecoverParams,
  ResumeParams,
  RunState,
  StartParams,
} from './types.js'

/** Create a graph runtime with registered kinds and lifecycle operations. */
export function createFlowGraph(options: FlowGraphOptions = {}): FlowGraph {
  const now = options.now ?? Date.now
  const runtime = options.runtime ?? createRuntime()
  const logger = options.logger ?? getSozaiLogger('flow-graph')
  const kinds = createKindRegistry(options, now)
  const authoringSchema = makeDefinitionSchema([...kinds.values()])
  const storageSchema = makeDefinitionSchema([...kinds.values()], true)
  const validatorFor = createValidatorCache()

  const check = (definition: unknown) =>
    checkDefinition({
      definition,
      kinds,
      actions: options.actions,
      authoringSchema,
      storageSchema,
      validatorFor,
    })

  const logError = (message: string, metadata: Record<string, unknown>) => {
    if (isSetup()) {
      traceLogger(logger).error(message, metadata)
    } else {
      console.error(`[@sozai/flow-graph] ${message}`, metadata)
    }
  }

  const warn = (message: string, metadata: Record<string, unknown>) =>
    traceLogger(logger).warn(message, metadata)

  const verifyDefinition = (definition: FlowDefinition): string => {
    const result = check(definition)

    if (!result.ok) {
      logError('Invalid flow definition', {
        'flow.id': definition?.id,
        code: 'invalid_definition',
        issues: result.issues.map((issue) => issue.code),
      })

      throw new FlowDefinitionError({ issues: result.issues })
    }

    return digestDefinition(definition as unknown as JSONValue)
  }

  const assertVersion = (definition: FlowDefinition, state: RunState, digest: string) => {
    const pinned = state.frames[0]?.flow

    if (
      !pinned ||
      pinned.id !== definition.id ||
      pinned.version !== definition.version ||
      pinned.digest !== digest
    ) {
      logError('Flow version mismatch', { 'flow.id': definition.id, code: 'version_mismatch' })

      throw new FlowVersionMismatchError()
    }
  }

  const validateState = (definition: FlowDefinition, runState: RunState, digest: string) => {
    try {
      assertRunState(runState, definition, kinds)
    } catch (error) {
      logError('Invalid run state', { 'flow.id': definition.id, code: 'invalid_state' })

      if (error instanceof FlowStateError) {
        throw error
      }
      // biome-ignore lint/style/useErrorCause: validation failures may carry private run state
      throw new FlowStateError({ issues: [{ message: 'Run state validation failed.', path: [] }] })
    }

    assertVersion(definition, runState, digest)
  }

  const makeRun = (params: {
    definition: FlowDefinition
    initial: RunState
    mode: 'start' | 'resume' | 'recover'
    signal?: AbortSignal
    parentContext?: StartParams['parentContext']
    event?: ResumeParams['event']
  }): FlowRun =>
    new FlowRunner({ ...params, kinds, options, now, runtime, logger, logError, warn }).run()

  function start(params: StartParams): FlowRun {
    const digest = verifyDefinition(params.definition)
    const input = params.input ?? null

    if (!isJSONValue(input)) {
      throw new FlowInputError({ issues: [{ message: 'Input must be a JSON value.', path: [] }] })
    }

    if (params.definition.input) {
      const result = validatorFor(params.definition.input)(input)

      if (result instanceof ValidationError) {
        throw new FlowInputError({ issues: result.issues })
      }
    }

    const state: RunState = {
      runID: params.runID ?? runtime.getRandomID(),
      revision: 0,
      status: 'running',
      steps: 0,
      frames: [
        {
          flow: { id: params.definition.id, version: params.definition.version, digest },
          node: params.definition.start,
          input,
          state: {},
          results: {},
          loops: {},
          invocation: 0,
          attempts: {},
        },
      ],
    }

    return makeRun({
      definition: params.definition,
      initial: state,
      mode: 'start',
      signal: params.signal,
      parentContext: params.parentContext,
    })
  }

  function resume(params: ResumeParams): FlowRun {
    const digest = verifyDefinition(params.definition)

    validateState(params.definition, params.runState, digest)

    if (params.runState.status !== 'suspended') {
      throw new FlowResumeError({
        issues: [{ message: 'Run is not suspended.', path: ['status'] }],
      })
    }

    const pending = required(params.runState.pending, ['pending'])

    validateResumeEvent({ event: params.event, pending, now, validatorFor })

    return makeRun({
      definition: params.definition,
      initial: params.runState,
      mode: 'resume',
      signal: params.signal,
      parentContext: params.parentContext,
      event: params.event,
    })
  }

  function recover(params: RecoverParams): FlowRun {
    const digest = verifyDefinition(params.definition)

    validateState(params.definition, params.runState, digest)

    if (params.runState.status !== 'running') {
      throw new FlowStateError({
        issues: [{ message: 'Recovery requires a running state.', path: ['status'] }],
      })
    }

    return makeRun({
      definition: params.definition,
      initial: params.runState,
      mode: 'recover',
      signal: params.signal,
      parentContext: params.parentContext,
    })
  }

  async function run(params: StartParams) {
    const flow = start(params)

    for await (const _state of flow) {
      /* commit notifications are available from start() */
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

  return { authoringSchema, storageSchema, runStateSchema, check, start, resume, recover, run }
}
