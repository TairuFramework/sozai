import { onAbort } from '@sozai/async'

export function linkSignal(params: { parent?: AbortSignal; timeoutMS: number }): {
  signal: AbortSignal
  timedOut(): boolean
  dispose(): void
} {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return
    timedOut = true
    controller.abort(new Error('Request timed out'))
  }, params.timeoutMS)
  const unsubscribe = onAbort(params.parent, () => controller.abort(params.parent?.reason))
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      unsubscribe()
    },
  }
}
