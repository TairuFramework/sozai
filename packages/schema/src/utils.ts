import type { Schema } from './types.js'

/**
 * Decode a single JSON Pointer reference token (RFC 6901): `~1` -> `/`, `~0` -> `~`.
 * `~1` must be replaced before `~0`.
 */
export function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function resolveReference(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#')) {
    throw new Error(`Invalid reference format: ${ref}`)
  }

  const segments = ref.split('/').slice(1)
  let current: unknown = root
  for (const segment of segments) {
    let key: string
    try {
      key = unescapePointer(decodeURIComponent(segment))
    } catch (cause) {
      // A malformed percent-escape (e.g. a lone `%`) makes decodeURIComponent
      // throw a raw URIError; surface the traversal's own error shape instead.
      throw new Error(`Invalid reference segment: ${segment}`, { cause })
    }
    if (current == null || typeof current !== 'object') {
      throw new Error(`Invalid reference path: ${ref}`)
    }
    if (!Object.hasOwn(current, key)) {
      throw new Error(`Invalid reference segment: ${key}`)
    }
    current = (current as Record<string, unknown>)[key]
    if (current == null) {
      throw new Error(`Reference not found: ${ref}`)
    }
  }
  return current as Schema
}

export function resolveSchema(root: Schema, schema: Schema): Schema {
  const ref = schema.$ref
  return ref ? resolveReference(root, ref) : schema
}

const SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
])
const SCHEMA_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'items', 'oneOf', 'prefixItems'])
const SCHEMA_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
])
const DEFINITION_REFERENCE = /^#\/(?<keyword>definitions|\$defs)\/(?<token>[^/]+)(?<rest>.*)$/

type SchemaObject = Record<string, unknown>
type DefinitionScope = { path: string; schema: SchemaObject }

function isSchemaObject(value: unknown): value is SchemaObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

function rebaseReference(ref: string, scopes: Array<DefinitionScope>): string {
  const groups = DEFINITION_REFERENCE.exec(ref)?.groups
  if (groups == null) {
    return ref
  }
  const { keyword = '', token = '', rest = '' } = groups
  const name = unescapePointer(token)
  const scope = scopes.findLast(({ schema }) => {
    const definitions = schema[keyword]
    return isSchemaObject(definitions) && Object.hasOwn(definitions, name)
  })
  return scope == null ? ref : `#${scope.path}/${keyword}/${token}${rest}`
}

function rebaseSchema(schema: unknown, path: string, scopes: Array<DefinitionScope>): unknown {
  // Schemas declaring an $id are their own resource: AJV resolves their references locally.
  if (!isSchemaObject(schema) || typeof schema.$id === 'string') {
    return schema
  }
  const currentScopes =
    isSchemaObject(schema.definitions) || isSchemaObject(schema.$defs)
      ? [...scopes, { path, schema }]
      : scopes
  const rebased: SchemaObject = {}
  for (const [key, value] of Object.entries(schema)) {
    const valuePath = `${path}/${escapePointer(key)}`
    if (key === '$ref' && typeof value === 'string') {
      rebased[key] = rebaseReference(value, currentScopes)
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isSchemaObject(value)) {
      rebased[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          rebaseSchema(child, `${valuePath}/${escapePointer(name)}`, currentScopes),
        ]),
      )
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      rebased[key] = value.map((child, index) =>
        rebaseSchema(child, `${valuePath}/${index}`, currentScopes),
      )
    } else if (SCHEMA_KEYWORDS.has(key)) {
      rebased[key] = rebaseSchema(value, valuePath, currentScopes)
    } else {
      // Annotations, constants, defaults and extension values are data, not schema locations.
      rebased[key] = value
    }
  }
  return rebased
}

/**
 * Rebase root-local `#/definitions/...` and `#/$defs/...` references against their nearest
 * definition scope, so a schema's references keep resolving once it is embedded in another schema.
 * Call it on the composed schema: references are rewritten as pointers from its root.
 * Only schema locations are traversed, and subschemas declaring an `$id` are left unchanged.
 * Other root references such as `#` or `#/properties/...` are not rebased.
 * The source schema is not mutated.
 */
export function rebaseDefinitionReferences(schema: Schema): Schema {
  return rebaseSchema(schema, '', []) as Schema
}
