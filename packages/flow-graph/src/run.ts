import { EventEmitter } from '@sozai/event'
import type { Logger } from '@sozai/log'
import type { Span } from '@sozai/otel'
import {
  formatTraceparent,
  isValidSpanID,
  isValidTraceID,
  parseTraceparent,
  SpanStatusCode,
  setSpanOnContext,
  withActiveContext,
} from '@sozai/otel'
import type { Runtime } from '@sozai/runtime'
import type { Schema, Validator } from '@sozai/schema'

import { nextInvocationID, top, topIndex } from './frames.js'
import type {
  InternalNodeResult,
  PushResult,
  ReferenceService,
  ReplaceResult,
} from './reference-kinds.js'
import type { PreparedFlow } from './resolver.js'
import type { FailureParams, HandleNodeErrorParams, NodeFailParams } from './retry-handling.js'
import { failNode, failRun, handleNodeError } from './retry-handling.js'
import { driveRunner } from './run-drive.js'
import type { RunOneParams, RunOneResult } from './run-execution.js'
import { NodeExecutor } from './run-execution.js'
import { clone, defaultMeta, final, required, tracer } from './run-utils.js'
import type {
  FlowDefinition,
  FlowEvents,
  FlowGraphOptions,
  FlowRun,
  NodeKind,
  ResumeEvent,
  RunState,
  StartParams,
} from './types.js'
import { popFrame } from './unwind.js'
import type { Scope } from './value.js'

export type FlowRunnerParams = {
  /** Definition snapshots by frame index; empty until `prepare` runs for resume and recover. */
  definitions: Array<FlowDefinition>
  /** Lazy phase run before the first transition: resolves and checks the frame definitions. */
  prepare?: (state: RunState) => Promise<Array<FlowDefinition>>
  initial: RunState
  mode: 'start' | 'resume' | 'recover'
  signal?: AbortSignal
  parentContext?: StartParams['parentContext']
  event?: ResumeEvent | { type: 'retry' }
  kinds: Map<string, NodeKind>
  /** Resolves, snapshots and validates referenced flows before a push. */
  references: ReferenceService
  validatorFor: (schema: Schema, strict?: boolean) => Validator<unknown>
  options: FlowGraphOptions
  now: () => number
  runtime: Runtime
  logger: Logger
  logError: (message: string, metadata: Record<string, unknown>) => void
  warn: (message: string, metadata: Record<string, unknown>) => void
}

type ApplyResultParams = {
  result: InternalNodeResult
  staged: Scope
  nodeID: string
  resumed: boolean
  /** Flow snapshot prepared by the executor for a `push` or `replace` result. */
  prepared?: PreparedFlow
}

export class FlowRunner {
  #definitions: Array<FlowDefinition>
  #prepare?: FlowRunnerParams['prepare']
  #options: FlowGraphOptions
  #kinds: Map<string, NodeKind>
  #references: ReferenceService
  #validatorFor: FlowRunnerParams['validatorFor']
  #now: () => number
  #runtime: Runtime
  #logger: Logger
  #logError: (message: string, metadata: Record<string, unknown>) => void
  #warn: (message: string, metadata: Record<string, unknown>) => void
  #state: RunState
  #events: EventEmitter<FlowEvents>
  #signal?: AbortSignal
  #mode: FlowRunnerParams['mode']
  #event?: FlowRunnerParams['event']
  #segment: Span
  #segmentContext: StartParams['parentContext']
  #failedSpan?: Span
  #segmentEnded = false
  /** Error type of the last lazy preparation when it rejected; cleared by a later successful one. */
  #prepareFailure?: string
  #runSignal: AbortSignal
  #executor: NodeExecutor

  constructor(params: FlowRunnerParams) {
    const {
      definitions,
      prepare,
      initial,
      mode,
      signal,
      parentContext,
      event,
      kinds,
      references,
      validatorFor,
      options,
      now,
      runtime,
      logger,
      logError,
      warn,
    } = params
    this.#definitions = definitions
    this.#prepare = prepare
    this.#options = options
    this.#kinds = kinds
    this.#references = references
    this.#validatorFor = validatorFor
    this.#now = now
    this.#runtime = runtime
    this.#logger = logger
    this.#logError = logError
    this.#warn = warn
    this.#state = clone(initial)
    this.#events = new EventEmitter<FlowEvents>()
    this.#signal = signal
    this.#mode = mode
    this.#event = event
    this.#runSignal = signal ?? new AbortController().signal

    const parsed =
      this.#mode === 'start'
        ? undefined
        : this.#state.origin && parseTraceparent(this.#state.origin.traceparent)

    const root = this.#state.frames[0]?.flow

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

    this.#segment = tracer.startSpan(
      'flow.segment',
      {
        attributes: {
          'flow.id': root?.id,
          'flow.version': root?.version,
          'flow.run.id': this.#state.runID,
          'flow.segment.kind': this.#mode,
        },
        links,
      },
      parentContext,
    )

    this.#segmentContext = setSpanOnContext(parentContext, this.#segment)

    if (this.#mode === 'start') {
      const spanContext = this.#segment.spanContext()

      const traceparent = formatTraceparent(
        spanContext.traceId,
        spanContext.spanId,
        spanContext.traceFlags,
      )

      if (traceparent) {
        this.#state.origin = { traceparent }
      }
    }

    this.#executor = new NodeExecutor({ runner: this })
  }

  /** Definition snapshots by frame index. */
  get definitions(): Array<FlowDefinition> {
    return this.#definitions
  }

  /** Definition snapshot of the active (top) frame. */
  get activeDefinition(): FlowDefinition {
    const index = topIndex(this.#state)

    return required(this.#definitions[index], ['frames', index, 'flow'])
  }

  /** Replace the definition snapshots together with a stack change. */
  replaceDefinitions(definitions: Array<FlowDefinition>): void {
    this.#definitions = definitions
  }

  get references(): ReferenceService {
    return this.#references
  }

  get options(): FlowGraphOptions {
    return this.#options
  }

  get kinds(): Map<string, NodeKind> {
    return this.#kinds
  }

  get now(): () => number {
    return this.#now
  }

  get runtime(): Runtime {
    return this.#runtime
  }

  get logger(): Logger {
    return this.#logger
  }

  get state(): RunState {
    return this.#state
  }

  get events(): EventEmitter<FlowEvents> {
    return this.#events
  }

  get signal(): AbortSignal | undefined {
    return this.#signal
  }

  get validatorFor(): FlowRunnerParams['validatorFor'] {
    return this.#validatorFor
  }

  get mode(): FlowRunnerParams['mode'] {
    return this.#mode
  }

  get event(): FlowRunnerParams['event'] {
    return this.#event
  }

  get segment(): Span {
    return this.#segment
  }

  get segmentContext(): StartParams['parentContext'] {
    return this.#segmentContext
  }

  get runSignal(): AbortSignal {
    return this.#runSignal
  }

  /**
   * Run the lazy preparation phase until it succeeds; nothing is committed when it fails. An
   * aborted run skips it, or ignores its rejection, and the drive loop commits `aborted`.
   */
  async prepare(): Promise<void> {
    const prepare = this.#prepare

    if (!prepare || this.#signal?.aborted) {
      return
    }

    try {
      this.#definitions = await prepare(clone(this.#state))
    } catch (error) {
      if (this.#signal?.aborted) {
        return
      }

      // `error.type` is set when the segment ends, so a later successful retry leaves none.
      this.#prepareFailure = defaultMeta(error).type

      // As on node spans, exceptions may carry private data and are recorded only when allowed.
      if (this.#options.recordErrorMessages) {
        this.#segment.recordException(error instanceof Error ? error : new Error(String(error)))
      }

      throw error
    }

    this.#prepare = undefined
    this.#prepareFailure = undefined
  }

  /** End the segment span without committing; it is an error when the last preparation failed. */
  end(): void {
    if (this.#segmentEnded) {
      return
    }

    if (this.#prepareFailure !== undefined) {
      this.#segment.setStatus({ code: SpanStatusCode.ERROR })
      this.#segment.setAttribute('error.type', this.#prepareFailure)
    }

    this.status(this.#state)
  }

  replaceState(next: RunState): void {
    this.#state = next
  }

  setFailedSpan(span: Span): void {
    this.#failedSpan = span
  }

  logError(message: string, metadata: Record<string, unknown>): void {
    this.#logError(message, metadata)
  }

  warn(message: string, metadata: Record<string, unknown>): void {
    this.#warn(message, metadata)
  }

  failure(params: FailureParams): RunState {
    return failRun(this, params)
  }

  nodeFail(params: NodeFailParams): RunState {
    return failNode(this, params)
  }

  handleNodeError(params: HandleNodeErrorParams): RunState {
    return handleNodeError(this, params)
  }

  runOne(params: RunOneParams): Promise<RunOneResult> {
    return this.#executor.runOne(params)
  }

  closeFailedSpan(fn: (span: Span | undefined) => void): void {
    const span = this.#failedSpan

    if (span) {
      withActiveContext(setSpanOnContext(this.#segmentContext, span), () => fn(span))

      span.end()

      this.#failedSpan = undefined
    } else {
      fn(undefined)
    }
  }

  status(next: RunState): void {
    if (this.#segmentEnded) {
      return
    }

    this.#segmentEnded = true

    this.#segment.setAttribute('flow.status', next.status)
    this.#segment.setAttribute('flow.steps', next.steps)

    if (next.outcome) {
      this.#segment.setAttribute('flow.outcome', next.outcome)
    }

    this.#segment.end()
  }

  commit(next: RunState, close = true): RunState {
    next.revision = this.#state.revision + 1
    this.#state = clone(next)

    if (close && final(this.#state.status)) {
      this.status(this.#state)
    }

    return clone(this.#state)
  }

  abort(): RunState {
    this.closeFailedSpan(() => {})

    const next = clone(this.#state)

    next.status = 'aborted'
    delete next.inFlight
    delete next.pending

    const frame = top(next)

    const attempts = Object.hasOwn(frame.attempts, frame.node)
      ? frame.attempts[frame.node]
      : undefined

    if (attempts) {
      delete attempts.retryAt
    }

    return this.commit(next)
  }

  applyResult(params: ApplyResultParams): RunState {
    const { result, staged, nodeID, resumed, prepared } = params
    const next = clone(this.#state)
    const frame = top(next)
    const kind = required(this.#kinds.get(this.activeDefinition.nodes[nodeID]?.kind ?? ''), [
      'frames',
      topIndex(next),
      'node',
    ])

    if (!kind.retries && !resumed) {
      nextInvocationID(next)

      next.steps++
    }

    frame.state = staged.state
    frame.results = staged.results
    frame.loops = staged.loops

    delete next.inFlight
    delete next.pending
    next.status = 'running'

    if ('push' in result) {
      return this.#push({ next, result, prepared: required(prepared, ['frames', topIndex(next)]) })
    }

    if ('replace' in result) {
      return this.#replace({
        next,
        nodeID,
        result,
        prepared: required(prepared, ['frames', topIndex(next)]),
      })
    }

    if (!('suspend' in result)) {
      delete frame.attempts[nodeID]
    }

    if ('next' in result) {
      frame.node = result.next
    } else if ('end' in result && topIndex(next) > 0) {
      // The callee's end step and the pop are one commit.
      return popFrame({
        runner: this,
        state: next,
        output: result.end.output ?? {},
        outcome: result.end.outcome,
      })
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

    const saved = this.commit(next)

    if (saved.status === 'suspended') {
      this.#events.fire('suspend', { node: nodeID, runState: saved })
    } else if (saved.status === 'ended') {
      this.#events.fire('end', { runState: saved })
    } else {
      this.#events.fire('node:exit', { node: nodeID, runState: saved })
    }

    return saved
  }

  #push(params: { next: RunState; result: PushResult; prepared: PreparedFlow }): RunState {
    const { next, result, prepared } = params

    // The caller keeps attempts[callerNode] (without retryAt) for call retries.
    next.frames.push({
      flow: prepared.pin,
      node: prepared.definition.start,
      input: result.push.input,
      state: {},
      results: {},
      loops: {},
      attempts: {},
      continuation: result.push.continuation,
    })

    this.#definitions = [...this.#definitions, prepared.definition]

    // No node:enter here: the drive loop fires it when the callee start runs.
    return this.commit(next)
  }

  #replace(params: {
    next: RunState
    nodeID: string
    result: ReplaceResult
    prepared: PreparedFlow
  }): RunState {
    const { next, nodeID, result, prepared } = params
    const index = topIndex(next)
    const { continuation } = top(next)

    // A fresh frame keeps the replaced frame's continuation; a root goto repins the root.
    next.frames[index] = {
      flow: prepared.pin,
      node: prepared.definition.start,
      input: result.replace.input,
      state: {},
      results: {},
      loops: {},
      attempts: {},
      ...(continuation ? { continuation } : {}),
    }

    this.#definitions = [...this.#definitions.slice(0, index), prepared.definition]

    if (index === 0) {
      // The segment span describes the root flow, which a root goto repins.
      this.#segment.setAttribute('flow.id', prepared.pin.id)
      this.#segment.setAttribute('flow.version', prepared.pin.version)
    }

    const saved = this.commit(next)

    // The drive loop fires node:enter when the target start runs.
    this.#events.fire('node:exit', { node: nodeID, runState: saved })

    return saved
  }

  run(): FlowRun {
    const iterator = driveRunner(this)
    const prepare = () => this.prepare()
    const end = () => this.end()
    const getState = () => clone(this.#state)
    let busy = false
    let closed = false
    const events = this.#events
    const segmentContext = this.#segmentContext

    return {
      events,
      getState,
      [Symbol.asyncIterator]() {
        return this
      },

      async next() {
        if (busy) {
          throw new Error('FlowRun.next() called concurrently')
        }

        if (closed) {
          return { done: true, value: getState() }
        }

        busy = true

        try {
          // Runs outside the generator so a rejection leaves the run retryable.
          await withActiveContext(segmentContext, prepare)

          return await withActiveContext(segmentContext, () => iterator.next())
        } finally {
          busy = false
        }
      },

      async return() {
        if (busy) {
          throw new Error('FlowRun.return() called concurrently')
        }

        if (!closed) {
          closed = true

          end()

          await iterator.return(getState())
        }

        return { done: true, value: getState() }
      },
    }
  }
}
