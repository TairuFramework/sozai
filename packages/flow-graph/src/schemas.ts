import type { Schema } from '@sozai/schema'

import type { NodeKind } from './types.js'

type MakeNodeSchemaParams = {
  kind: string
  required: Array<string>
  properties: Record<string, unknown>
  retries?: boolean
}

const describeSchema = (description: string, extra: Record<string, unknown> = {}) => ({
  description,
  ...extra,
})

const segment = {
  type: 'string',
  not: { enum: ['__proto__', 'constructor', 'prototype'] },
  description: 'Safe path segment',
}

const path = {
  type: 'array',
  items: segment,
  minItems: 1,
  description: 'Scope-rooted path',
  examples: [['state', 'count']],
}

const json: Record<string, unknown> = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: { $ref: '#/definitions/json' } },
    { type: 'object', additionalProperties: { $ref: '#/definitions/json' } },
  ],
}

const value = {
  oneOf: [
    { type: 'object', required: ['ref'], properties: { ref: path }, additionalProperties: false },
    {
      type: 'object',
      required: ['value'],
      properties: { value: { $ref: '#/definitions/json' } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['object'],
      properties: {
        object: {
          type: 'object',
          propertyNames: segment,
          additionalProperties: { $ref: '#/definitions/value' },
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['array'],
      properties: { array: { type: 'array', items: { $ref: '#/definitions/value' } } },
      additionalProperties: false,
    },
  ],
}

const valueFilter = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    isNull: { type: 'boolean' },
    equalTo: { allOf: [{ $ref: '#/definitions/json' }, { not: { type: 'null' } }] },
    notEqualTo: { allOf: [{ $ref: '#/definitions/json' }, { not: { type: 'null' } }] },
    in: { type: 'array', minItems: 1, items: { $ref: '#/definitions/json' } },
    notIn: { type: 'array', minItems: 1, items: { $ref: '#/definitions/json' } },
    lessThan: { type: ['number', 'string'] },
    lessThanOrEqualTo: { type: ['number', 'string'] },
    greaterThan: { type: ['number', 'string'] },
    greaterThanOrEqualTo: { type: ['number', 'string'] },
    contains: { type: 'string' },
    includesAll: { type: 'array', minItems: 1, items: { type: ['string', 'number'] } },
    includesAny: { type: 'array', minItems: 1, items: { type: ['string', 'number'] } },
    presence: { enum: ['null', 'nonNull', 'empty', 'nonEmpty', 'nullOrEmpty'] },
  },
}

const filter = {
  oneOf: [
    {
      type: 'object',
      required: ['path', 'is'],
      properties: { path, is: valueFilter },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['and'],
      properties: { and: { type: 'array', minItems: 1, items: { $ref: '#/definitions/filter' } } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['or'],
      properties: { or: { type: 'array', minItems: 1, items: { $ref: '#/definitions/filter' } } },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['not'],
      properties: { not: { $ref: '#/definitions/filter' } },
      additionalProperties: false,
    },
  ],
}

/** JSON Schema for a persisted retry policy. */
export const retryPolicySchema = {
  type: 'object',
  required: ['maxAttempts'],
  additionalProperties: false,
  properties: {
    maxAttempts: { type: 'integer', minimum: 1, maximum: 100 },
    attemptTimeoutMs: { type: 'integer', minimum: 0, maximum: 2147483647 },
    totalTimeoutMs: { type: 'integer', minimum: 0, maximum: 2147483647 },
    suspendAfterMs: { type: 'integer', minimum: 0, maximum: 2147483647 },
    maxInterruptions: { type: 'integer', minimum: 0, maximum: 100 },
    backoff: {
      type: 'object',
      required: ['initialMs'],
      additionalProperties: false,
      properties: {
        initialMs: { type: 'integer', minimum: 0, maximum: 2147483647 },
        multiplier: { type: 'number', minimum: 1 },
        maxMs: { type: 'integer', minimum: 0, maximum: 2147483647 },
        jitter: { type: 'boolean' },
      },
    },
  },
}

const string = describeSchema('Node ID or label', { type: 'string', minLength: 1 })

const base = { description: describeSchema('Human-readable purpose', { type: 'string' }) }

const valueReference = { $ref: '#/definitions/value' }

const filterReference = { $ref: '#/definitions/filter' }

const values = { type: 'object', propertyNames: segment, additionalProperties: valueReference }

const makeNodeSchema = (params: MakeNodeSchemaParams) => ({
  type: 'object',
  required: ['kind', ...params.required],
  additionalProperties: false,
  properties: {
    kind: { const: params.kind, description: 'Node kind' },
    ...base,
    ...params.properties,
    ...(params.retries ? { retry: retryPolicySchema } : {}),
  },
  description: `${params.kind} node`,
  examples: [{ kind: params.kind }],
})

/** JSON Schemas for executable built-in node kinds. */
export const builtinSchemas = {
  branch: makeNodeSchema({
    kind: 'branch',
    required: ['cases', 'default'],
    properties: {
      cases: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['when', 'to'],
          additionalProperties: false,
          properties: { when: filterReference, to: string },
        },
      },
      default: string,
    },
  }) as Schema,
  set: makeNodeSchema({
    kind: 'set',
    required: ['assign', 'next'],
    properties: {
      assign: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['path', 'value'],
          additionalProperties: false,
          properties: { path, value: valueReference },
        },
      },
      next: string,
    },
  }) as Schema,
  loop: makeNodeSchema({
    kind: 'loop',
    required: ['maxIterations', 'while', 'body', 'exit'],
    properties: {
      maxIterations: { type: 'integer', minimum: 1 },
      while: filterReference,
      body: string,
      exit: string,
      onExhausted: string,
    },
  }) as Schema,
  action: makeNodeSchema({
    kind: 'action',
    required: ['name', 'next'],
    properties: { name: string, args: values, next: string, onError: string },
    retries: true,
  }) as Schema,
  input: makeNodeSchema({
    kind: 'input',
    required: ['next'],
    properties: {
      prompt: valueReference,
      schema: { type: 'object' },
      next: string,
      timeout: {
        type: 'object',
        required: ['afterMs', 'to'],
        additionalProperties: false,
        properties: { afterMs: { type: 'integer', minimum: 0, maximum: 2147483647 }, to: string },
      },
    },
  }) as Schema,
  end: makeNodeSchema({
    kind: 'end',
    required: [],
    properties: { outcome: string, output: values },
  }) as Schema,
} satisfies Record<string, Schema>

for (const schema of Object.values(builtinSchemas)) {
  Object.assign(schema, { definitions: { json, value, filter } })
}

const reserved = [
  makeNodeSchema({
    kind: 'call',
    required: ['flow', 'next'],
    properties: {
      flow: string,
      version: { type: 'integer', minimum: 0 },
      input: values,
      next: string,
      onError: string,
    },
    retries: true,
  }),
  makeNodeSchema({
    kind: 'goto',
    required: ['flow'],
    properties: { flow: string, version: { type: 'integer', minimum: 0 }, input: values },
  }),
  makeNodeSchema({
    kind: 'loop',
    required: ['maxIterations', 'while', 'body', 'exit'],
    properties: {
      maxIterations: { type: 'integer', minimum: 1 },
      while: filterReference,
      body: {
        type: 'object',
        required: ['flow'],
        additionalProperties: false,
        properties: { flow: string, version: { type: 'integer', minimum: 0 } },
      },
      exit: string,
      onExhausted: string,
    },
  }),
]

function annotateFields(schema: Record<string, unknown>): Schema {
  const root = structuredClone(schema)

  const walk = (item: unknown): void => {
    if (!item || typeof item !== 'object') {
      return
    }

    if (Array.isArray(item)) {
      for (const nested of item) {
        walk(nested)
      }

      return
    }

    const shape = item as Record<string, unknown>
    const properties = shape.properties as Record<string, Record<string, unknown>> | undefined

    if (properties) {
      for (const [key, property] of Object.entries(properties)) {
        if (property.description === undefined) {
          property.description = key
        }

        walk(property)
      }
    }

    for (const key of [
      'oneOf',
      'anyOf',
      'allOf',
      'items',
      'additionalProperties',
      'propertyNames',
      'not',
    ]) {
      walk(shape[key])
    }

    if (shape.definitions && typeof shape.definitions === 'object') {
      for (const value of Object.values(shape.definitions)) {
        walk(value)
      }
    }
  }

  walk(root)

  return root as unknown as Schema
}

/** Build a definition schema from registered node kinds. */
export function makeDefinitionSchema(kinds: Array<NodeKind>, storage = false): Schema {
  return annotateFields({
    type: 'object',
    required: ['id', 'name', 'version', 'start', 'nodes'],
    additionalProperties: false,
    properties: {
      id: describeSchema('Stable flow identifier', {
        type: 'string',
        minLength: 1,
        examples: ['support/triage'],
      }),
      name: string,
      version: describeSchema('Integer edit version', { type: 'integer', minimum: 0 }),
      description: base.description,
      input: describeSchema('Run input JSON Schema', { type: 'object' }),
      start: string,
      nodes: {
        type: 'object',
        minProperties: 1,
        propertyNames: segment,
        additionalProperties: {
          oneOf: [...kinds.map((kind) => kind.schema), ...(storage ? reserved : [])],
        },
      },
    },
    definitions: { json, value, filter },
    examples: [
      {
        id: 'example',
        name: 'Example',
        version: 1,
        start: 'done',
        nodes: { done: { kind: 'end' } },
      },
    ],
  })
}

/** Pattern for canonical millisecond UTC timestamps. */
export const timestampPattern = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'

const timestamp = { type: 'string', pattern: timestampPattern }

const metadata = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string' },
    code: { type: 'string' },
    status: { type: 'number' },
    retryAfterMs: { type: 'number' },
  },
}

const attempts = {
  type: 'object',
  required: ['invocationID', 'policy', 'count', 'interruptions'],
  additionalProperties: false,
  properties: {
    invocationID: { type: 'string' },
    policy: retryPolicySchema,
    count: { type: 'integer', minimum: 0 },
    interruptions: { type: 'integer', minimum: 0 },
    deadline: timestamp,
    retryAt: timestamp,
    lastFailure: metadata,
  },
}

const frame = {
  type: 'object',
  required: ['flow', 'node', 'input', 'state', 'results', 'loops', 'invocation', 'attempts'],
  additionalProperties: false,
  properties: {
    flow: {
      type: 'object',
      required: ['id', 'version', 'digest'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        version: { type: 'integer' },
        digest: { type: 'string' },
      },
    },
    node: { type: 'string' },
    input: { $ref: '#/definitions/json' },
    state: { type: 'object', additionalProperties: { $ref: '#/definitions/json' } },
    results: { type: 'object', additionalProperties: { $ref: '#/definitions/json' } },
    loops: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    invocation: { type: 'integer', minimum: 0 },
    attempts: { type: 'object', additionalProperties: attempts },
    continuation: {
      type: 'object',
      required: ['kind', 'callerNode', 'returnTo'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['call', 'loopBody'] },
        callerNode: { type: 'string' },
        returnTo: { type: 'string' },
        onError: { type: 'string' },
      },
    },
  },
}

/** JSON Schema for persisted run state. */
export const runStateSchema = {
  type: 'object',
  required: ['runID', 'revision', 'status', 'frames', 'steps'],
  additionalProperties: false,
  properties: {
    runID: { type: 'string' },
    revision: { type: 'integer', minimum: 0 },
    status: { enum: ['running', 'suspended', 'ended', 'error', 'aborted'] },
    frames: { type: 'array', minItems: 1, items: frame },
    steps: { type: 'integer', minimum: 0 },
    inFlight: {
      type: 'object',
      required: ['node', 'attempt', 'invocationID'],
      additionalProperties: false,
      properties: {
        node: { type: 'string' },
        attempt: { type: 'integer', minimum: 1 },
        invocationID: { type: 'string' },
      },
    },
    origin: {
      type: 'object',
      required: ['traceparent'],
      additionalProperties: false,
      properties: { traceparent: { type: 'string' } },
    },
    pending: {
      type: 'object',
      required: ['node', 'reason'],
      additionalProperties: false,
      properties: {
        node: { type: 'string' },
        reason: { enum: ['suspend', 'retry'] },
        prompt: { $ref: '#/definitions/json' },
        schema: { type: 'object' },
        data: { $ref: '#/definitions/json' },
        deadline: timestamp,
        resumeAt: timestamp,
      },
    },
    outcome: { type: 'string' },
    output: { type: 'object', additionalProperties: { $ref: '#/definitions/json' } },
    error: {
      type: 'object',
      required: ['code', 'name'],
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        name: { type: 'string' },
        node: { type: 'string' },
        reason: { enum: ['attempts', 'total_timeout', 'non_retryable', 'interrupted'] },
        attempts: { type: 'integer', minimum: 0 },
        lastFailure: metadata,
      },
    },
  },
  definitions: { json },
} as Schema
