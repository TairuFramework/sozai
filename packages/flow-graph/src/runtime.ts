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
  NodeKind,
  NodeResult,
  RecoverParams,
  ResumeEvent,
  ResumeParams,
  RunError,
  RunState,
  StartParams,
} from './types.js'
import type { Scope } from './value.js'
import { resolveValue } from './value.js'

const clone = <T>(value: T): T => structuredClone(value)
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new FlowStateError()
  return value
}
const requireJSON = (value: unknown): void => {
  if (!isJSONValue(value)) throw new FlowNodeFailure({ code: 'invalid_value' })
}
const tracer = createTracerFactory('sozai', '0.1.0')('flow-graph')
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

export function createFlowGraph(options: FlowGraphOptions = {}): FlowGraph {
  const now = options.now ?? Date.now
  const runtime = options.runtime ?? createRuntime()
  const logger = options.logger ?? getSozaiLogger('flow-graph')
  const kinds = new Map<string, NodeKind>()
  for (const registered of [...builtinKinds(options.actions, now), ...(options.kinds ?? [])]) {
    const kind = registered as NodeKind
    if (kinds.has(kind.kind)) throw new TypeError(`Duplicate node kind: ${kind.kind}`)
    if (kind.resultSchema) {
      let shape: { properties?: Record<string, unknown> } | undefined
      try {
        shape = kind.resultSchema({ kind: kind.kind }) as typeof shape
      } catch {
        /* A schema may depend on node fields unavailable at registration. */
      }
      if (shape?.properties?.error)
        throw new TypeError('resultSchema cannot declare top-level error')
    }
    kinds.set(kind.kind, kind)
  }
  for (const [key, policy] of Object.entries(options.retryDefaults ?? {})) {
    if (!kinds.get(key)?.retries) throw new TypeError(`Retry default for non-retrying kind: ${key}`)
    validatePolicy(policy)
  }
  const authoringSchema = makeDefinitionSchema([...kinds.values()])
  const storageSchema = makeDefinitionSchema([...kinds.values()], true)
  const check = (definition: unknown) =>
    checkDefinition(definition, kinds, options.actions, authoringSchema, storageSchema)
  const logError = (message: string, metadata: Record<string, unknown>) => {
    if (isSetup()) traceLogger(logger).error(message, metadata)
    else console.error(`[@sozai/flow-graph] ${message}`, metadata)
  }
  const warn = (message: string, metadata: Record<string, unknown>) =>
    traceLogger(logger).warn(message, metadata)
  const verifyDefinition = (definition: FlowDefinition): string => {
    const result = check(definition)
    if (!result.ok) {
      logError('Invalid flow definition', {
        'flow.id': definition?.id,
        code: 'invalid_definition',
        issues: result.issues.map((i) => i.code),
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
    } catch {
      logError('Invalid run state', { 'flow.id': definition.id, code: 'invalid_state' })
      // biome-ignore lint/style/useErrorCause: invalid run state may contain private input; omit it from the thrown error
      throw new FlowStateError()
    }
    assertVersion(definition, runState, digest)
  }
  function makeRun(
    definition: FlowDefinition,
    initial: RunState,
    mode: 'start' | 'resume' | 'recover',
    signal?: AbortSignal,
    parentContext?: StartParams['parentContext'],
    event?: ResumeEvent | { type: 'retry' },
  ): FlowRun {
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
      } else fn(undefined)
    }
    if (mode === 'start') {
      const sc = segment.spanContext()
      const traceparent = formatTraceparent(sc.traceId, sc.spanId, sc.traceFlags)
      if (traceparent) state.origin = { traceparent }
    }
    let segmentEnded = false
    const status = (next: RunState) => {
      if (segmentEnded) return
      segmentEnded = true
      segment.setAttribute('flow.status', next.status)
      segment.setAttribute('flow.steps', next.steps)
      if (next.outcome) segment.setAttribute('flow.outcome', next.outcome)
      segment.end()
    }
    const commit = (next: RunState, close = true): RunState => {
      next.revision = state.revision + 1
      state = clone(next)
      if (close && final(state.status)) status(state)
      return clone(state)
    }
    const abort = (): RunState => {
      closeFailedSpan(() => {})
      const next = clone(state)
      next.status = 'aborted'
      delete next.inFlight
      delete next.pending
      const a = next.frames[0]?.attempts[next.frames[0]?.node]
      if (a) delete a.retryAt
      return commit(next)
    }
    const failure = (
      code: string,
      nodeID: string,
      detail?: Partial<RunError>,
      meta?: ErrorMetadata,
    ): RunState => {
      const next = clone(state)
      next.status = 'error'
      delete next.inFlight
      delete next.pending
      const a = next.frames[0]?.attempts[nodeID]
      if (a) delete a.retryAt
      if (code === 'loop_exhausted') delete next.frames[0]?.loops[nodeID]
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
          if (meta) span.setAttribute('error.type', meta.type)
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
      if (meta) segment.setAttribute('error.type', meta.type)
      status(saved)
      return saved
    }
    const nodeFail = (
      nodeID: string,
      node: FlowNode,
      kind: NodeKind,
      reason: RunError['reason'],
      meta: ErrorMetadata,
    ): RunState => {
      const attempts = state.frames[0]?.attempts[nodeID]
      const count = attempts?.count ?? 1
      if (typeof node.onError === 'string') {
        const next = clone(state)
        const frame = required(next.frames[0])
        frame.results[nodeID] = {
          error: {
            type: meta.type,
            ...(meta.code ? { code: meta.code } : {}),
            ...(meta.status !== undefined ? { status: meta.status } : {}),
            reason: required(reason),
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
      return failure('node_failed', nodeID, { reason, attempts: count }, meta)
    }
    let activeSignal = signal ?? new AbortController().signal
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
          const node = required(definition.nodes[params.node])
          if (event && mode === 'resume' && state.pending?.reason === 'suspend' && !kind.resume)
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
          const generation = activeGeneration
          const produced =
            event && mode === 'resume' && state.pending?.reason === 'suspend'
              ? await required(kind.resume)(node, required(activeContext), event as ResumeEvent)
              : await kind.execute(node, required(activeContext))
          if (generation === activeGeneration) currentResult = produced
          const nextID = 'next' in produced ? produced.next : undefined
          return nextID && definition.nodes[nextID]
            ? {
                status: 'action' as const,
                state: flowState,
                action: { name: definition.nodes[nextID]?.kind, params: { node: nextID } },
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
    const runOne = async (
      nodeID: string,
      kind: NodeKind,
      attempt: number,
      invocationID: string,
      pending?: RunState['pending'],
      deadline?: number,
      timeoutMs?: number,
    ): Promise<{ result: NodeResult; staged: Scope }> => {
      activeGeneration++
      const frame = required(state.frames[0])
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
            activeSignal = attemptSignal
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
              signal: activeSignal,
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
            if (signal?.aborted) throw signal.reason
            const flowValue = outcome.value
            if (flowValue?.status === 'error') {
              flow = createGenerator({
                handlers,
                state: state as unknown as Record<string, unknown>,
                signal,
              })
              throw flowValue.error
            }
            if (flowValue?.status === 'aborted') throw signal?.reason
            const result = currentResult as NodeResult | undefined
            if (!result) throw new FlowNodeFailure({ code: 'invalid_value' })
            return result
          })
        const result = kind.retries
          ? await raceAttempt({ fn: execute, signal, timeoutMs, deadline, now })
          : await execute(activeSignal)
        requireJSON(result)
        requireJSON(staged.state)
        requireJSON(staged.results)
        requireJSON(staged.loops)
        if ('suspend' in result) {
          if (
            !kind.resume ||
            (result.suspend.deadline && !isCanonicalTimestamp(result.suspend.deadline))
          )
            throw new FlowNodeFailure({ code: 'invalid_suspend' })
        } else if ('next' in result) {
          if (
            !kind
              .targets(required(definition.nodes[nodeID]))
              .some((edge) => edge.id === result.next)
          )
            throw new FlowNodeFailure({ code: 'invalid_target' })
          nodeSpan.setAttribute('flow.next', result.next)
          if ('result' in result) staged.results[nodeID] = result.result as JSONValue
        } else if (!('end' in result)) throw new FlowNodeFailure({ code: 'invalid_value' })
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
          nodeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      } finally {
        if (thrown && !options.recordErrorMessages)
          nodeSpan.setAttribute('error.type', defaultMeta(thrown).type)
        if (!thrown) nodeSpan.end()
      }
    }
    function handleNodeError(
      error: unknown,
      nodeID: string,
      node: FlowNode,
      kind: NodeKind,
      resumed: boolean,
    ): RunState {
      if (!kind.retries && !resumed) {
        const entered = clone(state)
        entered.steps++
        required(entered.frames[0]).invocation++
        state = entered
      }
      const meta = sanitize(error, kind)
      if (
        error instanceof FlowNodeFailure &&
        ['invalid_value', 'invalid_target', 'invalid_suspend', 'loop_exhausted'].includes(
          error.code,
        )
      )
        return failure(error.code, nodeID, undefined, meta)
      const attempt = required(state.frames[0]).attempts[nodeID]
      if (!attempt) return nodeFail(nodeID, node, kind, 'non_retryable', meta)
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
      const reason = expired
        ? 'total_timeout'
        : !decision
          ? 'non_retryable'
          : attempt.count >= attempt.policy.maxAttempts
            ? 'attempts'
            : undefined
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
        required(required(next.frames[0]).attempts[nodeID]).lastFailure = meta
        delete next.inFlight
        state = next
        return nodeFail(nodeID, node, kind, terminalReason, meta)
      }
      const suspended =
        attempt.policy.suspendAfterMs !== undefined && delayMs > attempt.policy.suspendAfterMs
      const next = clone(state)
      const updated = required(required(next.frames[0]).attempts[nodeID])
      updated.lastFailure = meta
      updated.retryAt = toTimestamp(retryAt)
      delete next.inFlight
      delete next.pending
      next.status = suspended ? 'suspended' : 'running'
      if (suspended) next.pending = { node: nodeID, reason: 'retry', resumeAt: updated.retryAt }
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
      let _resumeEvent = event
      try {
        while (state.status === 'running' || state.status === 'suspended') {
          if (signal?.aborted) {
            yield abort()
            break
          }
          const frame = required(state.frames[0])
          const nodeID = frame.node
          const node = required(definition.nodes[nodeID])
          const kind = required(kinds.get(node.kind))
          const pending = state.pending
          const attempts = frame.attempts[nodeID]
          if (state.status === 'suspended' && pending?.reason === 'suspend') {
            const invocationID = attempts?.invocationID ?? `${state.runID}:0:${frame.invocation}`
            try {
              const { result, staged } = await runOne(
                nodeID,
                kind,
                attempts?.count ?? 1,
                invocationID,
                pending,
                attempts?.deadline ? new Date(attempts.deadline).getTime() : undefined,
                attempts?.policy.attemptTimeoutMs,
              )
              _resumeEvent = undefined
              const saved = applyResult(result, staged, nodeID, true)
              yield saved
              if (final(saved.status)) break
            } catch (error) {
              if (signal?.aborted) {
                yield abort()
                break
              }
              const saved = handleNodeError(error, nodeID, node, kind, true)
              yield saved
              if (final(saved.status)) break
            }
            continue
          }
          if (attempts?.retryAt) {
            const remaining = new Date(attempts.retryAt).getTime() - now()
            if (attempts.deadline && now() >= new Date(attempts.deadline).getTime()) {
              yield nodeFail(
                nodeID,
                node,
                kind,
                'total_timeout',
                attempts.lastFailure ?? { type: 'TimeoutInterruption' },
              )
              if (final(state.status)) break
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
            if (remaining > 0)
              try {
                await sleep(remaining, signal)
              } catch {
                if (signal?.aborted) {
                  yield abort()
                  break
                }
              }
            if (signal?.aborted) {
              yield abort()
              break
            }
          }
          if (!attempts && state.steps >= (options.maxSteps ?? 1000)) {
            yield failure('max_steps', nodeID)
            break
          }
          if (kind.retries && !attempts) {
            const next = clone(state)
            const f = required(next.frames[0])
            const policy = clone(
              (node.retry as FlowRetryPolicy | undefined) ??
                options.retryDefaults?.[kind.kind] ?? { maxAttempts: 1 },
            )
            f.invocation++
            next.steps++
            f.attempts[nodeID] = {
              invocationID: `${state.runID}:0:${f.invocation}`,
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
          const current = state.frames[0]?.attempts[nodeID]
          if (kind.retries && current) {
            if (recovering && state.inFlight) {
              if (current.interruptions >= (current.policy.maxInterruptions ?? 3)) {
                yield nodeFail(
                  nodeID,
                  node,
                  kind,
                  'interrupted',
                  current.lastFailure ?? { type: 'Error' },
                )
                if (final(state.status)) break
                continue
              }
              const next = clone(state)
              required(required(next.frames[0]).attempts[nodeID]).interruptions++
              yield commit(next)
            } else {
              if (current.deadline && now() >= new Date(current.deadline).getTime()) {
                yield nodeFail(
                  nodeID,
                  node,
                  kind,
                  'total_timeout',
                  current.lastFailure ?? { type: 'TimeoutInterruption' },
                )
                if (final(state.status)) break
                continue
              }
              if (current.count >= current.policy.maxAttempts) {
                yield nodeFail(
                  nodeID,
                  node,
                  kind,
                  'attempts',
                  current.lastFailure ?? { type: 'Error' },
                )
                if (final(state.status)) break
                continue
              }
              const next = clone(state)
              const a = required(required(next.frames[0]).attempts[nodeID])
              a.count++
              a.interruptions = 0
              delete a.retryAt
              next.status = 'running'
              delete next.pending
              next.inFlight = { node: nodeID, attempt: a.count, invocationID: a.invocationID }
              yield commit(next)
            }
            recovering = false
          }
          const a = state.frames[0]?.attempts[nodeID]
          const invocationID =
            a?.invocationID ?? `${state.runID}:0:${(state.frames[0]?.invocation ?? 0) + 1}`
          try {
            const { result, staged } = await runOne(
              nodeID,
              kind,
              a?.count ?? 1,
              invocationID,
              undefined,
              a?.deadline ? new Date(a.deadline).getTime() : undefined,
              a?.policy.attemptTimeoutMs,
            )
            const saved = applyResult(result, staged, nodeID, false)
            yield saved
            if (final(saved.status)) break
          } catch (error) {
            if (signal?.aborted) {
              yield abort()
              break
            }
            const saved = handleNodeError(error, nodeID, node, kind, false)
            yield saved
            if (final(saved.status)) break
          }
        }
      } finally {
        status(state)
      }
      return clone(state)
    }
    function applyResult(
      result: NodeResult,
      staged: Scope,
      nodeID: string,
      resumed: boolean,
    ): RunState {
      const next = clone(state)
      const f = required(next.frames[0])
      const kind = required(kinds.get(definition.nodes[nodeID]?.kind ?? ''))
      if (!kind.retries && !resumed) {
        f.invocation++
        next.steps++
      }
      f.state = staged.state
      f.results = staged.results
      f.loops = staged.loops
      if (!('suspend' in result)) delete f.attempts[nodeID]
      delete next.inFlight
      delete next.pending
      next.status = 'running'
      if ('next' in result) f.node = result.next
      else if ('end' in result) {
        next.status = 'ended'
        if (result.end.outcome !== undefined) next.outcome = result.end.outcome
        if (result.end.output !== undefined) next.output = result.end.output
      } else {
        next.status = 'suspended'
        next.pending = { node: nodeID, reason: 'suspend', ...result.suspend }
      }
      const saved = commit(next)
      if (saved.status === 'suspended') events.fire('suspend', { node: nodeID, runState: saved })
      else if (saved.status === 'ended') events.fire('end', { runState: saved })
      else events.fire('node:exit', { node: nodeID, runState: saved })
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
        if (busy) throw new Error('FlowRun.next() called concurrently')
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
    if (
      !isJSONValue(input) ||
      (params.definition.input &&
        createValidator(params.definition.input)(input) instanceof ValidationError)
    )
      throw new FlowInputError()
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
    return makeRun(params.definition, state, 'start', params.signal, params.parentContext)
  }
  function resume(params: ResumeParams): FlowRun {
    const digest = verifyDefinition(params.definition)
    validateState(params.definition, params.runState, digest)
    if (params.runState.status !== 'suspended') throw new FlowResumeError()
    const pending = required(params.runState.pending)
    if (
      pending.reason === 'retry'
        ? params.event.type !== 'retry'
        : params.event.type !== 'value' && params.event.type !== 'timeout'
    )
      throw new FlowResumeError()
    if (params.event.type === 'retry' && now() < new Date(required(pending.resumeAt)).getTime())
      throw new FlowResumeError()
    if (
      params.event.type === 'timeout' &&
      (!pending.deadline || now() < new Date(pending.deadline).getTime())
    )
      throw new FlowResumeError()
    if (
      params.event.type === 'value' &&
      (!isJSONValue(params.event.value) ||
        (pending.schema &&
          createValidator(pending.schema)(params.event.value) instanceof ValidationError))
    )
      throw new FlowInputError()
    return makeRun(
      params.definition,
      params.runState,
      'resume',
      params.signal,
      params.parentContext,
      params.event,
    )
  }
  function recover(params: RecoverParams): FlowRun {
    const digest = verifyDefinition(params.definition)
    validateState(params.definition, params.runState, digest)
    if (params.runState.status !== 'running') throw new FlowStateError()
    return makeRun(
      params.definition,
      params.runState,
      'recover',
      params.signal,
      params.parentContext,
    )
  }
  async function run(params: StartParams) {
    const flow = start(params)
    for await (const _state of flow) {
      /* commit notifications are available from start() */
    }
    const runState = flow.getState()
    return {
      status: runState.status,
      ...(runState.outcome ? { outcome: runState.outcome } : {}),
      ...(runState.output ? { output: runState.output } : {}),
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
  )
    throw new RangeError('Invalid interruption limit')
  if (
    policy.suspendAfterMs !== undefined &&
    (policy.suspendAfterMs < 0 ||
      policy.suspendAfterMs > MAX_DELAY_MS ||
      !Number.isInteger(policy.suspendAfterMs) ||
      (policy.totalTimeoutMs !== undefined && policy.suspendAfterMs >= policy.totalTimeoutMs))
  )
    throw new RangeError('Invalid suspend threshold')
}
