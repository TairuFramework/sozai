import { MAX_DELAY_MS } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import { createTracerFactory } from '@sozai/otel'

import { FlowStateError } from './errors.js'
import { FlowNodeFailure } from './kinds.js'
import type { ErrorMetadata, NodeAttempts, NodeKind, RunState } from './types.js'

export const tracer = createTracerFactory('sozai')('flow-graph')

export const clone = <Value>(value: Value): Value => structuredClone(value)

export const own = <Value>(values: Record<string, Value>, key: string): Value | undefined =>
  Object.hasOwn(values, key) ? values[key] : undefined

export const required = <Value>(value: Value | undefined, path: Array<string | number>): Value => {
  if (value === undefined) {
    throw new FlowStateError({
      issues: [{ message: 'Required run state field is missing.', path }],
    })
  }

  return value
}

export const retryFailureReason = (
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

export const requireJSON = (value: unknown): void => {
  if (!isJSONValue(value)) {
    throw new FlowNodeFailure({ code: 'invalid_value' })
  }
}

export const final = (status: RunState['status']) =>
  status === 'ended' || status === 'error' || status === 'aborted' || status === 'suspended'

export const defaultMeta = (error: unknown): ErrorMetadata => ({
  type: error instanceof Error ? error.name : 'Error',
})

export const sanitize = (error: unknown, kind: NodeKind): ErrorMetadata => {
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
