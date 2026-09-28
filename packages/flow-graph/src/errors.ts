import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { FlowIssue } from './types.js'

/** Issues found while checking a definition. */
export type FlowDefinitionErrorParams = { issues: ReadonlyArray<FlowIssue> }

/** Issues found while validating run input. */
export type FlowInputErrorParams = { issues: ReadonlyArray<StandardSchemaV1.Issue> }

/** Issues found while validating persisted state. */
export type FlowStateErrorParams = { issues: ReadonlyArray<StandardSchemaV1.Issue> }

/** Issues found while validating a resume event. */
export type FlowResumeErrorParams = { issues: ReadonlyArray<StandardSchemaV1.Issue> }

/** Optional retry delay requested by an action. */
export type FlowRetryableErrorParams = { message?: string; afterMs?: number }

/** Invalid flow definition with repairable issues. */
export class FlowDefinitionError extends Error implements StandardSchemaV1.FailureResult {
  #issues: ReadonlyArray<FlowIssue>

  constructor(params: FlowDefinitionErrorParams) {
    super('Invalid flow definition')

    this.name = 'FlowDefinitionError'
    this.#issues = params.issues
  }

  get issues(): ReadonlyArray<FlowIssue> {
    return this.#issues
  }
}

/** Input that fails JSON or definition schema validation. */
export class FlowInputError extends Error implements StandardSchemaV1.FailureResult {
  #issues: ReadonlyArray<StandardSchemaV1.Issue>

  constructor(params: FlowInputErrorParams) {
    super('Invalid flow input')

    this.name = 'FlowInputError'
    this.#issues = params.issues
  }

  get issues(): ReadonlyArray<StandardSchemaV1.Issue> {
    return this.#issues
  }
}

/** Persisted run state that fails schema or invariant validation. */
export class FlowStateError extends Error implements StandardSchemaV1.FailureResult {
  #issues: ReadonlyArray<StandardSchemaV1.Issue>

  constructor(params: FlowStateErrorParams) {
    super('Invalid flow run state')

    this.name = 'FlowStateError'
    this.#issues = params.issues
  }

  get issues(): ReadonlyArray<StandardSchemaV1.Issue> {
    return this.#issues
  }
}

/** Flow definition differs from the version pinned in run state. */
export class FlowVersionMismatchError extends Error {
  constructor() {
    super('Flow definition does not match run state')

    this.name = 'FlowVersionMismatchError'
  }
}

/** Resume event that does not match pending work. */
export class FlowResumeError extends Error implements StandardSchemaV1.FailureResult {
  #issues: ReadonlyArray<StandardSchemaV1.Issue>

  constructor(params: FlowResumeErrorParams) {
    super('Invalid flow resume event')

    this.name = 'FlowResumeError'
    this.#issues = params.issues
  }

  get issues(): ReadonlyArray<StandardSchemaV1.Issue> {
    return this.#issues
  }
}

/** Action failure that requests a retry. */
export class FlowRetryableError extends Error {
  #afterMs?: number

  constructor(params: FlowRetryableErrorParams = {}) {
    super(params.message)

    this.name = 'FlowRetryableError'
    this.#afterMs = params.afterMs
  }

  get afterMs(): number | undefined {
    return this.#afterMs
  }
}
