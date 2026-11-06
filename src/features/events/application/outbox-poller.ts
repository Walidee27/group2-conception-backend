import type { OutboxDispatcher } from './outbox-dispatcher.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'

export function startOutboxPolling(
  dispatcher: Pick<OutboxDispatcher, 'drain'>,
  intervalMs: number,
  telemetry: Telemetry = noTelemetry,
  stopTimeoutMs = 5_000,
): () => Promise<void> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    try {
      await dispatcher.drain()
    } catch {
      telemetry.logger.warn('Cycle de livraison interrompu, nouvel essai prévu')
    }
    if (!stopped) {
      timer = setTimeout(() => {
        running = tick()
      }, intervalMs)
    }
  }
  let running = tick()
  return async () => {
    stopped = true
    clearTimeout(timer)
    let deadline: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      running,
      new Promise((resolve) => {
        deadline = setTimeout(resolve, stopTimeoutMs)
      }),
    ])
    clearTimeout(deadline)
  }
}
