import type { FlowIssue, IssueParams } from './types.js'

/** Build a flow issue; severity defaults to `error`. */
export const issue = (params: IssueParams): FlowIssue => ({
  severity: params.severity ?? 'error',
  path: params.path,
  code: params.code,
  message: params.message,
  hint: params.hint,
})
