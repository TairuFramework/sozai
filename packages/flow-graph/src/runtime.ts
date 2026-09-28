import {
  assertRetryPolicy,
  getRetryDelay,
  MAX_DELAY_MS,
  raceAttempt,
  sleep,
  TimeoutInterruption,
} from '@sozai/async'
import { EventEmitter } from '@sozai/event'
import { createGenerator } from '@sozai/flow'
import type { JSONValue } from '@sozai/json'
import { isJSONValue } from '@sozai/json'
import { getSozaiLogger, isSetup } from '@sozai/log'
import type { Span } from '@sozai/otel'
import {
  createTracerFactory,
  formatTraceparent,
  isValidSpanID,
  isValidTraceID,
  parseTraceparent,
  SpanStatusCode,
  setSpanOnContext,
  traceLogger,
  withActiveContext,
} from '@sozai/otel'
import { createRuntime } from '@sozai/runtime'
import type { Schema, Validator } from '@sozai/schema'
import { createValidator, ValidationError } from '@sozai/schema'

import { checkDefinition } from './checker.js'
import { digestDefinition } from './digest.js'
import {
  FlowDefinitionError,
  FlowInputError,
  FlowResumeError,
  FlowStateError,
  FlowVersionMismatchError,
} from './errors.js'
import { evaluateFilter } from './filter.js'
import { builtinKinds, FlowNodeFailure } from './kinds.js'
import { makeDefinitionSchema, runStateSchema } from './schemas.js'
import { assertRunState } from './state.js'
import { isCanonicalTimestamp, toTimestamp } from './time.js'
import type {
  ErrorMetadata,
  ExecuteContext,
  FlowDefinition,
  FlowEvents,
  FlowGraph,
  FlowGraphOptions,
  FlowNode,
  FlowRetryPolicy,
  FlowRun,
  NodeAttempts,
  NodeKind,
  NodeResult,
  Pending,
  RecoverParams,
  ResumeEvent,
  ResumeParams,
  RunError,
  RunState,
  StartParams,
} from './types.js'
import type { Scope } from './value.js'
import { resolveValue } from './value.js'

const clone = <Value>(value: Value): Value => structuredClone(value)

const own = <Value>(values: Record<string, Value>, key: string): Value | undefined =>
  Object.hasOwn(values, key) ? values[key] : undefined

const required = <Value>(value: Value | undefined, path: Array<string | number>): Value => {
  if (value === undefined) {
    throw new FlowStateError({
      issues: [{ message: 'Required run state field is missing.', path }],
    })
  }

  return value
}

const retryFailureReason = (
  expired: boolean,
  decision: ReturnType<NonNullable<NodeKind['retryable']>>,
  attempt: NodeAttempts,
): 'total_timeout' | 'non_retryable' | 'attempts' | undefined => {
  if (expired) {
    return 'total_timeout'
  }

  if (!decision) {
    return 'non_retryable'
  }

  if (attempt.count >= attempt.policy.maxAttempts) {
    return 'attempts'
  }

  return undefined
}

const requireJSON = (value: unknown): void => {
  if (!isJSONValue(value)) {
    throw new FlowNodeFailure({ code: 'invalid_value' })
  }
}

const tracer = createTracerFactory('sozai')('flow-graph')

const final = (status: RunState['status']) =>
  status === 'ended' || status === 'error' || status === 'aborted' || status === 'suspended'

const defaultMeta = (error: unknown): ErrorMetadata => ({
  type: error instanceof Error ? error.name : 'Error',
})

const sanitize = (error: unknown, kind: NodeKind): ErrorMetadata => {
  let raw: unknown

  try {
    raw = kind.describeError?.(error)
  } catch {
    raw = undefined
  }

  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  return {
    type: typeof src.type === 'string' ? src.type : defaultMeta(error).type,
    ...(typeof src.code === 'string' ? { code: src.code } : {}),
    ...(typeof src.status === 'number' && Number.isFinite(src.status)
      ? { status: src.status }
      : {}),
    ...(typeof src.retryAfterMs === 'number' && Number.isFinite(src.retryAfterMs)
      ? { retryAfterMs: Math.min(MAX_DELAY_MS, Math.max(0, src.retryAfterMs)) }
      : {}),
  }
}

type MakeRunParams = {
  definition: FlowDefinition
  initial: RunState
  mode: 'start' | 'resume' | 'recover'
  signal?: AbortSignal
  parentContext?: StartParams['parentContext']
  event?: ResumeEvent | { type: 'retry' }
}

type FailureParams = {
  code: string
  nodeID: string
  detail?: Partial<RunError>
  meta?: ErrorMetadata
}

type NodeFailParams = {
  nodeID: string
  node: FlowNode
  kind: NodeKind
  reason: RunError['reason']
  meta: ErrorMetadata
}

type RunOneParams = {
  nodeID: string
  kind: NodeKind
  attempt: number
  invocationID: string
  pending?: RunState['pending']
  deadline?: number
  timeoutMs?: number
}

type HandleNodeErrorParams = {
  error: unknown
  nodeID: string
  node: FlowNode
  kind: NodeKind
  resumed: boolean
}

type ApplyResultParams = {
  result: NodeResult
  staged: Scope
  nodeID: string
  resumed: boolean
}

type ValidateResumeEventParams = {
  event: ResumeParams['event']
  pending: Pending
  now: () => number
  validatorFor: (schema: Schema) => Validator<unknown>
}

function validateResumeEvent(params: ValidateResumeEventParams): void {
  const { event, pending, now, validatorFor } = params

  if (
    pending.reason === 'retry'
      ? event.type !== 'retry'
      : event.type !== 'value' && event.type !== 'timeout'
  ) {
    throw new FlowResumeError({
      issues: [
        { message: 'Resume event type does not match pending work.', path: ['event', 'type'] },
      ],
    })
  }

  if (
    event.type === 'retry' &&
    now() < new Date(required(pending.resumeAt, ['pending', 'resumeAt'])).getTime()
  ) {
    throw new FlowResumeError({
      issues: [{ message: 'Retry resume time has not arrived.', path: ['pending', 'resumeAt'] }],
    })
  }

  if (
    event.type === 'timeout' &&
    (!pending.deadline || now() < new Date(pending.deadline).getTime())
  ) {
    throw new FlowResumeError({
      issues: [{ message: 'Input deadline has not arrived.', path: ['pending', 'deadline'] }],
    })
  }

  if (event.type === 'value') {
    if (!isJSONValue(event.value)) {
      throw new FlowResumeError({
        issues: [{ message: 'Resume value must be a JSON value.', path: ['event', 'value'] }],
      })
    }

    if (pending.schema) {
      const result = validatorFor(pending.schema)(event.value)

      if (result instanceof ValidationError) {
        throw new FlowResumeError({ issues: result.issues })
      }
    }
  }
}

function createKindRegistry(options: FlowGraphOptions, now: () => number): Map<string, NodeKind> {
  const kinds = new Map<string, NodeKind>()

  for (const registered of [...builtinKinds(options.actions, now), ...(options.kinds ?? [])]) {
    const kind = registered as unknown as NodeKind

    if (kinds.has(kind.kind)) {
      throw new TypeError(`Duplicate node kind: ${kind.kind}`)
    }

    if (kind.resultSchema) {
      let shape: { properties?: Record<string, unknown> } | undefined

      try {
        shape = kind.resultSchema({ kind: kind.kind }) as typeof shape
      } catch {
        /* A schema may depend on node fields unavailable at registration. */
      }

      if (shape?.properties?.error) {
        throw new TypeError('resultSchema cannot declare top-level error')
      }
    }

    kinds.set(kind.kind, kind)
  }

  for (const [key, policy] of Object.entries(options.retryDefaults ?? {})) {
    if (!kinds.get(key)?.retries) {
      throw new TypeError(`Retry default for non-retrying kind: ${key}`)
    }

    validatePolicy(policy)
  }

  return kinds
}

function createValidatorCache(): (schema: Schema, strict?: boolean) => Validator<unknown> {
  const validators = new Map<string, Validator<unknown>>()

  return (schema, strict) => {
    const key = `${strict ?? 'default'}:${JSON.stringify(schema)}`
    let validator = validators.get(key)

    if (!validator) {
      validator = createValidator(schema, strict === undefined ? undefined : { strict })

      validators.set(key, validator)
    }

    return validator
  }
}

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

  function makeRun(params: MakeRunParams): FlowRun {
    const { definition, initial, mode, signal, parentContext, event } = params
    let state = clone(initial)
    const events = new EventEmitter<FlowEvents>()

    const parsed =
      mode === 'start' ? undefined : state.origin && parseTraceparent(state.origin.traceparent)

    const links =
      parsed && isValidTraceID(parsed.traceID) && isValidSpanID(parsed.spanID)
        ? [
            {
              context: {
                traceId: parsed.traceID,
                spanId: parsed.spanID,
                traceFlags: parsed.traceFlags,
                isRemote: true,
              },
            },
          ]
        : []

    const segment = tracer.startSpan(
      'flow.segment',
      {
        attributes: {
          'flow.id': definition.id,
          'flow.version': definition.version,
          'flow.run.id': state.runID,
          'flow.segment.kind': mode,
        },
        links,
      },
      parentContext,
    )

    const segmentContext = setSpanOnContext(parentContext, segment)
    let failedSpan: Span | undefined

    const closeFailedSpan = (fn: (span: Span | undefined) => void): void => {
      const span = failedSpan

      if (span) {
        withActiveContext(setSpanOnContext(segmentContext, span), () => fn(span))

        span.end()

        failedSpan = undefined
      } else {
        fn(undefined)
      }
    }

    if (mode === 'start') {
      const spanContext = segment.spanContext()

      const traceparent = formatTraceparent(
        spanContext.traceId,
        spanContext.spanId,
        spanContext.traceFlags,
      )

      if (traceparent) {
        state.origin = { traceparent }
      }
    }

    let segmentEnded = false

    const status = (next: RunState) => {
      if (segmentEnded) {
        return
      }

      segmentEnded = true

      segment.setAttribute('flow.status', next.status)
      segment.setAttribute('flow.steps', next.steps)

      if (next.outcome) {
        segment.setAttribute('flow.outcome', next.outcome)
      }

      segment.end()
    }

    const commit = (next: RunState, close = true): RunState => {
      next.revision = state.revision + 1
      state = clone(next)

      if (close && final(state.status)) {
        status(state)
      }

      return clone(state)
    }

    const abort = (): RunState => {
      closeFailedSpan(() => {})

      const next = clone(state)

      next.status = 'aborted'
      delete next.inFlight
      delete next.pending

      const frame = next.frames[0]

      const attempts =
        frame && Object.hasOwn(frame.attempts, frame.node) ? frame.attempts[frame.node] : undefined

      if (attempts) {
        delete attempts.retryAt
      }

      return commit(next)
    }

    const failure = (params: FailureParams): RunState => {
      const { code, nodeID, detail, meta } = params
      const next = clone(state)

      next.status = 'error'
      delete next.inFlight
      delete next.pending

      const attempts =
        next.frames[0] && Object.hasOwn(next.frames[0].attempts, nodeID)
          ? next.frames[0].attempts[nodeID]
          : undefined

      if (attempts) {
        delete attempts.retryAt
      }

      if (code === 'loop_exhausted') {
        delete next.frames[0]?.loops[nodeID]
      }

      next.error = {
        code,
        name: code === 'node_failed' ? 'FlowNodeFailure' : 'FlowRunError',
        node: nodeID,
        ...detail,
        ...(meta ? { lastFailure: meta } : {}),
      }

      const saved = commit(next, false)

      closeFailedSpan((span) => {
        if (span) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          span.setAttribute('flow.error.code', code)

          if (meta) {
            span.setAttribute('error.type', meta.type)
          }
        }

        logError('Flow run failed', {
          'flow.id': definition.id,
          runID: saved.runID,
          code,
          node: nodeID,
          ...(detail?.reason ? { reason: detail.reason } : {}),
          ...(detail?.attempts !== undefined ? { attempts: detail.attempts } : {}),
          ...(meta ?? {}),
        })
      })

      segment.setStatus({ code: SpanStatusCode.ERROR })
      segment.setAttribute('flow.error.code', code)

      if (meta) {
        segment.setAttribute('error.type', meta.type)
      }

      status(saved)

      return saved
    }

    const nodeFail = (params: NodeFailParams): RunState => {
      const { nodeID, node, kind, reason, meta } = params

      const attempts =
        state.frames[0] && Object.hasOwn(state.frames[0].attempts, nodeID)
          ? state.frames[0].attempts[nodeID]
          : undefined

      const count = attempts?.count ?? 1

      if (typeof node.onError === 'string') {
        const next = clone(state)
        const frame = required(next.frames[0], ['frames', 0])

        frame.results[nodeID] = {
          error: {
            type: meta.type,
            ...(meta.code ? { code: meta.code } : {}),
            ...(meta.status !== undefined ? { status: meta.status } : {}),
            reason: required(reason, ['error', 'reason']),
            attempts: count,
          },
        }
        frame.node = node.onError
        delete frame.attempts[nodeID]

        delete next.inFlight
        delete next.pending
        next.status = 'running'

        const saved = commit(next)

        closeFailedSpan((span) => {
          span?.addEvent('flow.error.handled', { 'error.type': meta.type })

          warn('Flow node failure handled', {
            'flow.id': definition.id,
            runID: state.runID,
            node: nodeID,
            kind: kind.kind,
            attempt: count,
            reason,
            ...meta,
          })
        })

        events.fire('node:exit', { node: nodeID, runState: saved })

        return saved
      }

      return failure({ code: 'node_failed', nodeID, detail: { reason, attempts: count }, meta })
    }

    const runSignal = signal ?? new AbortController().signal
    let currentResult: NodeResult | undefined
    let activeGeneration = 0
    let activeContext: ExecuteContext | undefined

    const handlers = Object.fromEntries(
      [...kinds].map(([name, kind]) => [
        name,
        async ({
          state: flowState,
          params,
        }: {
          state: Record<string, unknown>
          params: { node: string }
        }) => {
          const node = required(
            Object.hasOwn(definition.nodes, params.node)
              ? definition.nodes[params.node]
              : undefined,
            ['frames', 0, 'node'],
          )

          if (event && mode === 'resume' && state.pending?.reason === 'suspend' && !kind.resume) {
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
          }

          const generation = activeGeneration

          const produced =
            event && mode === 'resume' && state.pending?.reason === 'suspend'
              ? await required(kind.resume, ['pending'])(
                  node,
                  required(activeContext, ['frames', 0, 'node']),
                  event as ResumeEvent,
                )
              : await kind.execute(node, required(activeContext, ['frames', 0, 'node']))

          if (generation === activeGeneration) {
            currentResult = produced
          }

          const nextID = produced && 'next' in produced ? produced.next : undefined

          const nextNode =
            nextID && Object.hasOwn(definition.nodes, nextID) ? definition.nodes[nextID] : undefined

          return nextNode
            ? {
                status: 'action' as const,
                state: flowState,
                action: { name: nextNode.kind, params: { node: nextID } },
              }
            : { status: 'state' as const, state: flowState }
        },
      ]),
    )

    let flow = createGenerator({
      handlers,
      state: state as unknown as Record<string, unknown>,
      signal,
    })

    const runOne = async (params: RunOneParams): Promise<{ result: NodeResult; staged: Scope }> => {
      const { nodeID, kind, attempt, invocationID, pending, deadline, timeoutMs } = params

      activeGeneration++

      const frame = required(state.frames[0], ['frames', 0])

      const staged: Scope = {
        input: clone(frame.input),
        state: clone(frame.state),
        results: clone(frame.results),
        loops: clone(frame.loops),
      }

      const nodeSpan = tracer.startSpan(
        'flow.node',
        {
          attributes: {
            'flow.node.id': nodeID,
            'flow.node.kind': kind.kind,
            'flow.attempt': attempt,
          },
        },
        segmentContext,
      )

      const nodeContext = setSpanOnContext(segmentContext, nodeSpan)
      let thrown: unknown

      try {
        const execute = async (attemptSignal: AbortSignal) =>
          withActiveContext(nodeContext, async () => {
            activeContext = {
              nodeID,
              runID: state.runID,
              invocationID,
              attempt,
              ...(pending?.data !== undefined ? { pending: { data: pending.data } } : {}),
              scope: staged,
              resolve: (value) => resolveValue(value, staged),
              evaluate: (filter) => evaluateFilter(filter, staged),
              setResult: (value) => {
                staged.results[nodeID] = value
              },
              signal: attemptSignal,
              span: nodeSpan,
              logger,
              runtime,
            }

            currentResult = undefined

            const outcome = await flow.next({
              action: { name: kind.kind, params: { node: nodeID } },
              state: state as unknown as Record<string, unknown>,
              signal,
            })

            if (signal?.aborted) {
              throw signal.reason
            }

            const flowValue = outcome.value

            if (flowValue?.status === 'error') {
              flow = createGenerator({
                handlers,
                state: state as unknown as Record<string, unknown>,
                signal,
              })

              const wrapped = flowValue.error

              throw wrapped instanceof Error &&
                wrapped.message === 'Handler execution failed' &&
                wrapped.cause !== undefined
                ? wrapped.cause
                : wrapped
            }

            if (flowValue?.status === 'aborted') {
              throw signal?.reason
            }

            const result = currentResult as NodeResult | undefined

            if (!result) {
              throw new FlowNodeFailure({ code: 'invalid_value' })
            }

            return result
          })

        const result = kind.retries
          ? await raceAttempt({ fn: execute, signal, timeoutMs, deadline, now })
          : await execute(runSignal)

        requireJSON(result)
        requireJSON(staged.state)
        requireJSON(staged.results)
        requireJSON(staged.loops)

        if ('suspend' in result) {
          if (
            !kind.resume ||
            (result.suspend.deadline && !isCanonicalTimestamp(result.suspend.deadline))
          ) {
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
          }
        } else if ('next' in result) {
          if (
            !kind
              .targets(required(definition.nodes[nodeID], ['frames', 0, 'node']))
              .some((edge) => edge.id === result.next)
          ) {
            throw new FlowNodeFailure({ code: 'invalid_target' })
          }

          nodeSpan.setAttribute('flow.next', result.next)

          if ('result' in result) {
            requireJSON(result.result)

            staged.results[nodeID] = result.result as JSONValue
          }
        } else if (!('end' in result)) {
          throw new FlowNodeFailure({ code: 'invalid_value' })
        }

        requireJSON(staged)

        return { result, staged }
      } catch (error) {
        thrown = error

        failedSpan = nodeSpan

        flow = createGenerator({
          handlers,
          state: state as unknown as Record<string, unknown>,
          signal,
        })

        if (options.recordErrorMessages) {
          nodeSpan.recordException(error instanceof Error ? error : new Error(String(error)))
        }

        throw error
      } finally {
        if (thrown && !options.recordErrorMessages) {
          nodeSpan.setAttribute('error.type', defaultMeta(thrown).type)
        }

        if (!thrown) {
          nodeSpan.end()
        }
      }
    }

    function handleNodeError(params: HandleNodeErrorParams): RunState {
      const { error, nodeID, node, kind, resumed } = params

      if (!kind.retries && !resumed) {
        const entered = clone(state)

        entered.steps++

        required(entered.frames[0], ['frames', 0]).invocation++

        state = entered
      }

      const meta = sanitize(error, kind)

      if (
        error instanceof FlowNodeFailure &&
        ['invalid_value', 'invalid_target', 'invalid_suspend', 'loop_exhausted'].includes(
          error.code,
        )
      ) {
        return failure({ code: error.code, nodeID, meta })
      }

      const frame = required(state.frames[0], ['frames', 0])
      const attempt = Object.hasOwn(frame.attempts, nodeID) ? frame.attempts[nodeID] : undefined

      if (!attempt) {
        return nodeFail({ nodeID, node, kind, reason: 'non_retryable', meta })
      }

      const expired =
        (error instanceof TimeoutInterruption && error.cause === 'deadline') ||
        (!!attempt.deadline && now() >= new Date(attempt.deadline).getTime())

      let decision: ReturnType<NonNullable<NodeKind['retryable']>> = false

      try {
        decision =
          error instanceof TimeoutInterruption && error.cause === 'attempt'
            ? true
            : (kind.retryable?.(error) ?? false)
      } catch {
        decision = false
      }

      const reason = retryFailureReason(expired, decision, attempt)

      const delayMs = reason
        ? 0
        : getRetryDelay(attempt.policy, attempt.count, {
            afterMs: typeof decision === 'object' ? decision.afterMs : meta.retryAfterMs,
            random: options.random,
          })

      const retryAt = now() + delayMs

      const terminalReason =
        reason ??
        (attempt.deadline && retryAt >= new Date(attempt.deadline).getTime()
          ? 'total_timeout'
          : undefined)

      if (terminalReason) {
        const next = clone(state)

        required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
          'frames',
          0,
          'attempts',
          nodeID,
        ]).lastFailure = meta

        delete next.inFlight

        state = next

        return nodeFail({ nodeID, node, kind, reason: terminalReason, meta })
      }

      const suspended =
        attempt.policy.suspendAfterMs !== undefined && delayMs > attempt.policy.suspendAfterMs

      const next = clone(state)

      const updated = required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
        'frames',
        0,
        'attempts',
        nodeID,
      ])

      updated.lastFailure = meta
      updated.retryAt = toTimestamp(retryAt)

      delete next.inFlight
      delete next.pending
      next.status = suspended ? 'suspended' : 'running'

      if (suspended) {
        next.pending = { node: nodeID, reason: 'retry', resumeAt: updated.retryAt }
      }

      const saved = commit(next, false)

      closeFailedSpan((span) => {
        span?.addEvent('flow.retry', {
          'flow.retry.delay_ms': delayMs,
          'flow.retry.suspended': suspended,
          'error.type': meta.type,
        })

        warn('Flow node retry scheduled', {
          'flow.id': definition.id,
          runID: saved.runID,
          node: nodeID,
          kind: kind.kind,
          attempt: attempt.count,
          delayMs,
          suspended,
          ...meta,
        })
      })

      events.fire('retry', { node: nodeID, delayMs, runState: saved })

      if (suspended) {
        events.fire('suspend', { node: nodeID, runState: saved })

        status(saved)
      }

      return saved
    }

    async function* drive(): AsyncGenerator<RunState, RunState> {
      let recovering = mode === 'recover'

      try {
        while (state.status === 'running' || state.status === 'suspended') {
          if (signal?.aborted) {
            yield abort()
            break
          }

          const frame = required(state.frames[0], ['frames', 0])
          const nodeID = frame.node

          const node = required(
            Object.hasOwn(definition.nodes, nodeID) ? definition.nodes[nodeID] : undefined,
            ['frames', 0, 'node'],
          )

          const kind = required(kinds.get(node.kind), ['frames', 0, 'node'])
          const pending = state.pending

          const attempts = Object.hasOwn(frame.attempts, nodeID)
            ? frame.attempts[nodeID]
            : undefined

          if (state.status === 'suspended' && pending?.reason === 'suspend') {
            const invocationID = attempts?.invocationID ?? `${state.runID}:0:${frame.invocation}`

            try {
              const { result, staged } = await runOne({
                nodeID,
                kind,
                attempt: attempts?.count ?? 1,
                invocationID,
                pending,
                deadline: attempts?.deadline ? new Date(attempts.deadline).getTime() : undefined,
                timeoutMs: attempts?.policy.attemptTimeoutMs,
              })

              const saved = applyResult({ result, staged, nodeID, resumed: true })

              yield saved

              if (final(saved.status)) {
                break
              }
            } catch (error) {
              if (signal?.aborted) {
                yield abort()
                break
              }

              const saved = handleNodeError({ error, nodeID, node, kind, resumed: true })

              yield saved

              if (final(saved.status)) {
                break
              }
            }

            continue
          }

          if (attempts?.retryAt) {
            const remaining = new Date(attempts.retryAt).getTime() - now()

            if (attempts.deadline && now() >= new Date(attempts.deadline).getTime()) {
              yield nodeFail({
                nodeID,
                node,
                kind,
                reason: 'total_timeout',
                meta: attempts.lastFailure ?? { type: 'TimeoutInterruption' },
              })

              if (final(state.status)) {
                break
              }

              continue
            }

            if (
              recovering &&
              attempts.policy.suspendAfterMs !== undefined &&
              remaining > attempts.policy.suspendAfterMs
            ) {
              const next = clone(state)

              next.status = 'suspended'
              next.pending = { node: nodeID, reason: 'retry', resumeAt: attempts.retryAt }

              const saved = commit(next)

              events.fire('suspend', { node: nodeID, runState: saved })

              yield saved
              break
            }

            recovering = false

            if (remaining > 0) {
              try {
                await sleep(remaining, signal)
              } catch {
                if (signal?.aborted) {
                  yield abort()
                  break
                }
              }
            }

            if (signal?.aborted) {
              yield abort()
              break
            }
          }

          if (!attempts && state.steps >= (options.maxSteps ?? 1000)) {
            yield failure({ code: 'max_steps', nodeID })
            break
          }

          if (kind.retries && !attempts) {
            const next = clone(state)
            const frame = required(next.frames[0], ['frames', 0])

            const policy = clone(
              (node.retry as FlowRetryPolicy | undefined) ??
                (options.retryDefaults ? own(options.retryDefaults, kind.kind) : undefined) ?? {
                  maxAttempts: 1,
                },
            )

            frame.invocation++

            next.steps++

            frame.attempts[nodeID] = {
              invocationID: `${state.runID}:0:${frame.invocation}`,
              policy,
              count: 0,
              interruptions: 0,
              ...(policy.totalTimeoutMs !== undefined
                ? { deadline: toTimestamp(now() + policy.totalTimeoutMs) }
                : {}),
            }

            const saved = commit(next)

            events.fire('node:enter', { node: nodeID, runState: saved })

            yield saved
            continue
          }

          const current =
            state.frames[0] && Object.hasOwn(state.frames[0].attempts, nodeID)
              ? state.frames[0].attempts[nodeID]
              : undefined

          if (kind.retries && current) {
            if (current.deadline && now() >= new Date(current.deadline).getTime()) {
              yield nodeFail({
                nodeID,
                node,
                kind,
                reason: 'total_timeout',
                meta: current.lastFailure ?? { type: 'TimeoutInterruption' },
              })

              if (final(state.status)) {
                break
              }

              continue
            }

            if (recovering && state.inFlight) {
              if (current.interruptions >= (current.policy.maxInterruptions ?? 3)) {
                yield nodeFail({
                  nodeID,
                  node,
                  kind,
                  reason: 'interrupted',
                  meta: current.lastFailure ?? { type: 'Error' },
                })

                if (final(state.status)) {
                  break
                }

                continue
              }

              const next = clone(state)

              required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
                'frames',
                0,
                'attempts',
                nodeID,
              ]).interruptions++

              yield commit(next)
            } else {
              if (current.count >= current.policy.maxAttempts) {
                yield nodeFail({
                  nodeID,
                  node,
                  kind,
                  reason: 'attempts',
                  meta: current.lastFailure ?? { type: 'Error' },
                })

                if (final(state.status)) {
                  break
                }

                continue
              }

              const next = clone(state)

              const attempt = required(required(next.frames[0], ['frames', 0]).attempts[nodeID], [
                'frames',
                0,
                'attempts',
                nodeID,
              ])

              attempt.count++
              attempt.interruptions = 0
              delete attempt.retryAt

              next.status = 'running'
              delete next.pending
              next.inFlight = {
                node: nodeID,
                attempt: attempt.count,
                invocationID: attempt.invocationID,
              }

              yield commit(next)
            }

            recovering = false
          }

          const attempt =
            state.frames[0] && Object.hasOwn(state.frames[0].attempts, nodeID)
              ? state.frames[0].attempts[nodeID]
              : undefined

          if (!kind.retries) {
            events.fire('node:enter', { node: nodeID, runState: clone(state) })
          }

          const invocationID =
            attempt?.invocationID ?? `${state.runID}:0:${(state.frames[0]?.invocation ?? 0) + 1}`

          try {
            const { result, staged } = await runOne({
              nodeID,
              kind,
              attempt: attempt?.count ?? 1,
              invocationID,
              deadline: attempt?.deadline ? new Date(attempt.deadline).getTime() : undefined,
              timeoutMs: attempt?.policy.attemptTimeoutMs,
            })

            const saved = applyResult({ result, staged, nodeID, resumed: false })

            yield saved

            if (final(saved.status)) {
              break
            }
          } catch (error) {
            if (signal?.aborted) {
              yield abort()
              break
            }

            const saved = handleNodeError({ error, nodeID, node, kind, resumed: false })

            yield saved

            if (final(saved.status)) {
              break
            }
          }
        }
      } finally {
        status(state)
      }

      return clone(state)
    }

    function applyResult(params: ApplyResultParams): RunState {
      const { result, staged, nodeID, resumed } = params
      const next = clone(state)
      const frame = required(next.frames[0], ['frames', 0])
      const kind = required(kinds.get(definition.nodes[nodeID]?.kind ?? ''), ['frames', 0, 'node'])

      if (!kind.retries && !resumed) {
        frame.invocation++

        next.steps++
      }

      frame.state = staged.state
      frame.results = staged.results
      frame.loops = staged.loops

      if (!('suspend' in result)) {
        delete frame.attempts[nodeID]
      }

      delete next.inFlight
      delete next.pending
      next.status = 'running'

      if ('next' in result) {
        frame.node = result.next
      } else if ('end' in result) {
        next.status = 'ended'

        if (result.end.outcome !== undefined) {
          next.outcome = result.end.outcome
        }

        if (result.end.output !== undefined) {
          next.output = result.end.output
        }
      } else {
        next.status = 'suspended'
        next.pending = { node: nodeID, reason: 'suspend', ...result.suspend }
      }

      const saved = commit(next)

      if (saved.status === 'suspended') {
        events.fire('suspend', { node: nodeID, runState: saved })
      } else if (saved.status === 'ended') {
        events.fire('end', { runState: saved })
      } else {
        events.fire('node:exit', { node: nodeID, runState: saved })
      }

      return saved
    }

    const iterator = drive()
    let busy = false

    return {
      events,
      getState: () => clone(state),
      [Symbol.asyncIterator]() {
        return this
      },

      async next() {
        if (busy) {
          throw new Error('FlowRun.next() called concurrently')
        }

        busy = true

        try {
          return await withActiveContext(segmentContext, () => iterator.next())
        } finally {
          busy = false
        }
      },
    }
  }

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

function validatePolicy(policy: FlowRetryPolicy): void {
  assertRetryPolicy(policy)

  if (
    policy.maxInterruptions !== undefined &&
    (!Number.isInteger(policy.maxInterruptions) ||
      policy.maxInterruptions < 0 ||
      policy.maxInterruptions > 100)
  ) {
    throw new RangeError('Invalid interruption limit')
  }

  if (
    policy.suspendAfterMs !== undefined &&
    (policy.suspendAfterMs < 0 ||
      policy.suspendAfterMs > MAX_DELAY_MS ||
      !Number.isInteger(policy.suspendAfterMs) ||
      (policy.totalTimeoutMs !== undefined && policy.suspendAfterMs >= policy.totalTimeoutMs))
  ) {
    throw new RangeError('Invalid suspend threshold')
  }
}
