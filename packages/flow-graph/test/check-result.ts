import { expect } from 'vitest'

import type { FlowCheckResult, FlowIssue } from '../src/index.js'

/** Every issue a check reported, whether it passed or failed. */
export function reportedIssues(result: FlowCheckResult): ReadonlyArray<FlowIssue> {
  return result.issues ?? result.warnings
}

/** Issues of a failing check; fails the test when the check passed. */
export function failedIssues(result: FlowCheckResult): ReadonlyArray<FlowIssue> {
  expect(result.issues).toBeDefined()

  return result.issues ?? []
}

/** Warnings of a passing check; fails the test when the check failed. */
export function passedWarnings(result: FlowCheckResult): Array<FlowIssue> {
  expect(result.issues).toBeUndefined()

  return result.issues ? [] : result.warnings
}
