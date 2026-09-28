import { EventEmitter } from '@sozai/event'
import type { Logger } from '@sozai/log'
import type { Span } from '@sozai/otel'
import {
  formatTraceparent,
  isValidSpanID,
  isValidTraceID,
  parseTraceparent,
  setSpanOnContext,
  withActiveContext,
} from '@sozai/otel'
import type { Runtime } from '@sozai/runtime'

import type { FailureParams, HandleNodeErrorParams, NodeFailParams } from './retry-handling.js'
import { failNode, failRun, handleNodeError } from './retry-handling.js'
import { driveRunner } from './run-drive.js'
import type { RunOneParams } from './run-execution.js'
import { NodeExecutor } from './run-execution.js'
import { clone, final, required, tracer } from './run-utils.js'
import type {
  FlowDefinition,
  FlowEvents,
  FlowGraphOptions,
  FlowRun,
  NodeKind,
  NodeResult,
  ResumeEvent,
  RunState,
  StartParams,
} from './types.js'
import type { Scope } from './value.js'

export type FlowRunnerParams = {
  definition: FlowDefinition
  initial: RunState
  mode: 'start' | 'resume' | 'recover'
  signal?: AbortSignal
  parentContext?: StartParams['parentContext']
  event?: ResumeEvent | { type: 'retry' }
  kinds: Map<string, NodeKind>
  options: FlowGraphOptions
  now: () => number
  runtime: Runtime
  logger: Logger
  logError: (message: string, metadata: Record<string, unknown>) => void
  warn: (message: string, metadata: Record<string, unknown>) => void
}

type ApplyResultParams = { result: NodeResult; staged: Scope; nodeID: string; resumed: boolean }

export class FlowRunner {
  #definition: FlowDefinition
  #options: FlowGraphOptions
  #kinds: Map<string, NodeKind>
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
  #runSignal: AbortSignal
  #executor: NodeExecutor

  constructor(params: FlowRunnerParams) {
    const {
      definition,
      initial,
      mode,
      signal,
      parentContext,
      event,
      kinds,
      options,
      now,
      runtime,
      logger,
      logError,
      warn,
    } = params
    this.#definition = definition
    this.#options = options
    this.#kinds = kinds
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
          'flow.id': this.#definition.id,
          'flow.version': this.#definition.version,
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

  get definition(): FlowDefinition {
    return this.#definition
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

  runOne(params: RunOneParams): Promise<{ result: NodeResult; staged: Scope }> {
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

    const frame = next.frames[0]

    const attempts =
      frame && Object.hasOwn(frame.attempts, frame.node) ? frame.attempts[frame.node] : undefined

    if (attempts) {
      delete attempts.retryAt
    }

    return this.commit(next)
  }

  applyResult(params: ApplyResultParams): RunState {
    const { result, staged, nodeID, resumed } = params
    const next = clone(this.#state)
    const frame = required(next.frames[0], ['frames', 0])
    const kind = required(this.#kinds.get(this.#definition.nodes[nodeID]?.kind ?? ''), [
      'frames',
      0,
      'node',
    ])

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

  run(): FlowRun {
    const iterator = driveRunner(this)
    let busy = false
    const events = this.#events
    const segmentContext = this.#segmentContext

    return {
      events,
      getState: () => clone(this.#state),
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
}
