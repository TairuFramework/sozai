import type { FlowIssue } from './types.js'

export class FlowDefinitionError extends Error {
  #issues: Array<FlowIssue>
  constructor(params: FlowDefinitionErrorParams) {
    super('Invalid flow definition')
    this.name = 'FlowDefinitionError'
    this.#issues = params.issues
  }
  get issues(): Array<FlowIssue> {
    return this.#issues
  }
}
export class FlowInputError extends Error {
  constructor() {
    super('Invalid flow input')
    this.name = 'FlowInputError'
  }
}
export class FlowStateError extends Error {
  constructor() {
    super('Invalid flow run state')
    this.name = 'FlowStateError'
  }
}
export class FlowVersionMismatchError extends Error {
  constructor() {
    super('Flow definition does not match run state')
    this.name = 'FlowVersionMismatchError'
  }
}
export class FlowResumeError extends Error {
  constructor() {
    super('Invalid flow resume event')
    this.name = 'FlowResumeError'
  }
}
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

export type FlowDefinitionErrorParams = { issues: Array<FlowIssue> }
export type FlowRetryableErrorParams = { message?: string; afterMs?: number }
