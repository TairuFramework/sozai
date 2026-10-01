import { assertRetryPolicy, MAX_DELAY_MS } from '@sozai/async'
import { isJSONValue } from '@sozai/json'
import type { Schema, Validator } from '@sozai/schema'
import { createValidator } from '@sozai/schema'

import { builtinKinds } from './kinds.js'
import type { ReferenceService } from './reference-kinds.js'
import type { FlowGraphOptions, FlowRetryPolicy, NodeKind } from './types.js'

export function createKindRegistry(
  options: FlowGraphOptions,
  now: () => number,
  references: ReferenceService,
): Map<string, NodeKind> {
  if (
    options.maxDepth !== undefined &&
    (!Number.isInteger(options.maxDepth) || options.maxDepth < 1)
  ) {
    throw new RangeError('Invalid maximum depth')
  }

  const kinds = new Map<string, NodeKind>()

  const builtins = builtinKinds({ actions: options.actions, now, references })

  for (const registered of [...builtins, ...(options.kinds ?? [])]) {
    const kind = registered as unknown as NodeKind

    if (kinds.has(kind.kind)) {
      throw new TypeError(`Duplicate node kind: ${kind.kind}`)
    }

    // Shared caches key schemas by canonical JSON; the default path tolerates non-JSON values.
    if (options.validators !== undefined && !isJSONValue(kind.schema)) {
      throw new TypeError(`Kind ${kind.kind} schema is not JSON`)
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

    if (key === 'call' && policy.attemptTimeoutMs !== undefined) {
      throw new TypeError('Call retry defaults cannot set attemptTimeoutMs')
    }

    validatePolicy(policy)
  }

  return kinds
}

export function createValidatorLookup(): (schema: Schema, strict?: boolean) => Validator<unknown> {
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
