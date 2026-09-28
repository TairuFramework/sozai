import type { JSONValue } from '@sozai/json'

import type { Path, Scope } from './value.js'
import { readPath } from './value.js'

export type ValueFilter = {
  isNull?: boolean
  equalTo?: JSONValue
  notEqualTo?: JSONValue
  in?: Array<JSONValue>
  notIn?: Array<JSONValue>
  lessThan?: number | string
  lessThanOrEqualTo?: number | string
  greaterThan?: number | string
  greaterThanOrEqualTo?: number | string
  contains?: string
  includesAll?: Array<string | number>
  includesAny?: Array<string | number>
  presence?: 'null' | 'nonNull' | 'empty' | 'nonEmpty' | 'nullOrEmpty'
}
export type Filter =
  | { path: Path; is: ValueFilter }
  | { and: Array<Filter> }
  | { or: Array<Filter> }
  | { not: Filter }

const equal = (left: JSONValue, right: JSONValue): boolean => {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((v, i) => equal(v, right[i] as JSONValue))
  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) =>
          Object.hasOwn(right, key) && equal(left[key] as JSONValue, right[key] as JSONValue),
      )
    )
  }
  return false
}
const empty = (value: JSONValue): boolean =>
  value === '' || (Array.isArray(value) && value.length === 0)
const order = (subject: JSONValue, operand: number | string, op: string): boolean => {
  if (
    typeof subject !== typeof operand ||
    (typeof subject !== 'number' && typeof subject !== 'string')
  )
    return false
  if (op === 'lessThan') return subject < operand
  if (op === 'lessThanOrEqualTo') return subject <= operand
  if (op === 'greaterThan') return subject > operand
  return subject >= operand
}

export function evaluateFilter(filter: Filter, scope: Scope): boolean {
  try {
    if ('and' in filter)
      return filter.and.length > 0 && filter.and.every((part) => evaluateFilter(part, scope))
    if ('or' in filter)
      return filter.or.length > 0 && filter.or.some((part) => evaluateFilter(part, scope))
    if ('not' in filter) return !evaluateFilter(filter.not, scope)
    const subject = readPath(filter.path, scope)
    return Object.entries(filter.is).every(([operator, operand]) => {
      if (operator === 'isNull') return (subject === null) === operand
      if (operator === 'presence') {
        if (operand === 'null') return subject === null
        if (operand === 'nonNull') return subject !== null
        if (operand === 'empty') return empty(subject)
        if (operand === 'nonEmpty') return subject !== null && !empty(subject)
        return subject === null || empty(subject)
      }
      if (subject === null) return false
      if (operator === 'equalTo') return equal(subject, operand as JSONValue)
      if (operator === 'notEqualTo') return !equal(subject, operand as JSONValue)
      if (operator === 'in')
        return (operand as Array<JSONValue>).some((item) => equal(subject, item))
      if (operator === 'notIn')
        return !(operand as Array<JSONValue>).some((item) => equal(subject, item))
      if (operator === 'contains')
        return typeof subject === 'string' && subject.includes(operand as string)
      if (operator === 'includesAll')
        return (
          Array.isArray(subject) &&
          (operand as Array<JSONValue>).every((item) => subject.some((v) => equal(v, item)))
        )
      if (operator === 'includesAny')
        return (
          Array.isArray(subject) &&
          (operand as Array<JSONValue>).some((item) => subject.some((v) => equal(v, item)))
        )
      return order(subject, operand as number | string, operator)
    })
  } catch {
    return false
  }
}
