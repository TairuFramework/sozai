import type { FlowCheckResult, FlowDefinition, FlowIssue, IssueParams } from './types.js'

/** Build a flow issue; severity defaults to `error`. */
export const issue = (params: IssueParams): FlowIssue => ({
  severity: params.severity ?? 'error',
  path: params.path,
  code: params.code,
  message: params.message,
  hint: params.hint,
})

/** Build a check result: failure with every issue when any is an error, else success with warnings. */
export function checkResult(
  definition: unknown,
  issues: ReadonlyArray<FlowIssue>,
): FlowCheckResult {
  if (issues.some((item) => item.severity === 'error')) {
    return { issues: [...issues] }
  }

  return { value: definition as FlowDefinition, warnings: [...issues] }
}
