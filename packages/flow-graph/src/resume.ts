import { isJSONValue } from '@sozai/json'
import type { Schema, Validator } from '@sozai/schema'
import { ValidationError } from '@sozai/schema'

import { FlowResumeError } from './errors.js'
import { required } from './run-utils.js'
import type { Pending, ResumeParams } from './types.js'

type ValidateResumeEventParams = {
  event: ResumeParams['event']
  pending: Pending
  now: () => number
  validatorFor: (schema: Schema) => Validator<unknown>
}

export function validateResumeEvent(params: ValidateResumeEventParams): void {
  const { event, pending, now, validatorFor } = params

  if (
    pending.reason === 'retry'
      ? event.type !== 'retry'
      : event.type !== 'value' && event.type !== 'timeout' && event.type !== 'decline'
  ) {
    throw new FlowResumeError({
      issues: [
        { message: 'Resume event type does not match pending work.', path: ['event', 'type'] },
      ],
    })
  }

  if (
    event.type === 'retry' &&
    now() < new Date(required(pending.resumeAt, ['pending', 'resumeAt'])).getTime()
  ) {
    throw new FlowResumeError({
      issues: [{ message: 'Retry resume time has not arrived.', path: ['pending', 'resumeAt'] }],
    })
  }

  if (
    event.type === 'timeout' &&
    (!pending.deadline || now() < new Date(pending.deadline).getTime())
  ) {
    throw new FlowResumeError({
      issues: [{ message: 'Input deadline has not arrived.', path: ['pending', 'deadline'] }],
    })
  }

  if (
    event.type === 'decline' &&
    event.reason !== undefined &&
    event.reason !== 'decline' &&
    event.reason !== 'cancel'
  ) {
    throw new FlowResumeError({
      issues: [{ message: 'Decline reason is not recognised.', path: ['event', 'reason'] }],
    })
  }

  if (event.type === 'value') {
    if (!isJSONValue(event.value)) {
      throw new FlowResumeError({
        issues: [{ message: 'Resume value must be a JSON value.', path: ['event', 'value'] }],
      })
    }

    if (pending.schema) {
      const result = validatorFor(pending.schema)(event.value)

      if (result instanceof ValidationError) {
        throw new FlowResumeError({ issues: result.issues })
      }
    }
  }
}
