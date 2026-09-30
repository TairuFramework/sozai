/** Annotation and container keywords that place no constraint on a value. */
export const ANNOTATION_KEYS: ReadonlySet<string> = new Set([
  'title',
  'description',
  '$comment',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$id',
  '$schema',
  '$anchor',
  'definitions',
  '$defs',
])

const REF_PATTERN = /^#\/(definitions|\$defs)\/([^/]+)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether a schema places no constraint on the values it describes: `true`, or an object carrying
 * only annotation keywords.
 */
export function isUnconstrainedSchema(schema: unknown): boolean {
  if (schema === true) {
    return true
  }

  return isRecord(schema) && Object.keys(schema).every((key) => ANNOTATION_KEYS.has(key))
}

function resolveRef(root: unknown, schema: unknown): unknown {
  const visited = new Set<string>()
  let current = schema

  while (isRecord(current) && typeof current.$ref === 'string') {
    const ref = current.$ref

    if (visited.has(ref)) {
      return undefined
    }

    visited.add(ref)

    const match = REF_PATTERN.exec(ref)
    const definitions = match && isRecord(root) ? root[match[1] as string] : undefined

    if (!match || !isRecord(definitions) || !Object.hasOwn(definitions, match[2] as string)) {
      return undefined
    }

    current = definitions[match[2] as string]
  }

  return current
}

function childSchema(schema: Record<string, unknown>, key: string): unknown {
  const { properties, items, additionalProperties } = schema

  if (isRecord(properties) && Object.hasOwn(properties, key)) {
    return properties[key]
  }

  if (/^(0|[1-9]\d*)$/.test(key) && (items === true || isRecord(items))) {
    return items
  }

  return additionalProperties === true || isRecord(additionalProperties)
    ? additionalProperties
    : undefined
}

/**
 * Whether a result path can be reached in a schema. Local `#/definitions/*` and `#/$defs/*`
 * references resolve against `schema` as the root; unconstrained sub-schemas accept any deeper path.
 */
export function schemaHasPath(schema: unknown, path: Array<string>): boolean {
  let current = resolveRef(schema, schema)

  for (const part of path) {
    if (isUnconstrainedSchema(current)) {
      return true
    }

    if (!isRecord(current)) {
      return false
    }

    current = resolveRef(schema, childSchema(current, part))
  }

  return current !== undefined && current !== false
}
