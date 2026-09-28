import { assertRetryPolicy, MAX_DELAY_MS } from '@sozai/async'
import type { Schema, Validator } from '@sozai/schema'
import { createValidator } from '@sozai/schema'

import { builtinKinds } from './kinds.js'
import type { FlowGraphOptions, FlowRetryPolicy, NodeKind } from './types.js'

export function createKindRegistry(
  options: FlowGraphOptions,
  now: () => number,
): Map<string, NodeKind> {
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

export function createValidatorCache(): (schema: Schema, strict?: boolean) => Validator<unknown> {
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
