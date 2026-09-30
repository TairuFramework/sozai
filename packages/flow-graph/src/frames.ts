import { FlowStateError } from './errors.js'
import type { Frame, RunState } from './types.js'

/** Index of the active (top) frame in the run's frame stack. */
export function topIndex(state: RunState): number {
  return state.frames.length - 1
}

/** Active (top) frame of the run's frame stack. */
export function top(state: RunState): Frame {
  const frame = state.frames[topIndex(state)]

  if (!frame) {
    throw new FlowStateError({
      issues: [{ message: 'Run state requires an active frame.', path: ['frames'] }],
    })
  }

  return frame
}

/** Increment the run-level invocation counter and return the new invocation ID. */
export function nextInvocationID(state: RunState): string {
  state.invocation++

  return `${state.runID}:${state.invocation}`
}

/** Default maximum number of frames, including the root frame. */
export const defaultMaxDepth = 16
