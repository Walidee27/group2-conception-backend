import type {
  EventReadRepository,
  EventProjectionRepository,
} from '#/features/events/application/ports.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventBus } from '#/shared-kernel/event-bus.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'

// Reload committed state rather than replaying potentially stale event payloads.
// Queue refreshes so concurrent publications cannot overwrite a newer snapshot
// with an earlier read in this process. A failed refresh must not poison the queue.
export function createEventsReadModelSubscriber(
  source: EventReadRepository,
  projection: EventProjectionRepository,
  telemetry: Telemetry = noTelemetry,
) {
  let pending = Promise.resolve()
  const refresh = () => {
    const next = pending.then(() =>
      telemetry.operations.run('refresh events read model', async () => {
        try {
          const events = await source.listEvents({})
          await projection.replaceEvents(events)
          telemetry.metrics.increment('events.read_model.refreshes', {
            outcome: 'success',
          })
        } catch (error) {
          telemetry.metrics.increment('events.read_model.refreshes', {
            outcome: 'failed',
          })
          throw error
        }
      }),
    )
    pending = next.catch(() => {})
    return next
  }

  return {
    refresh,
    subscribe(bus: EventBus<DomainEvent>) {
      const stops = [
        bus.subscribe('EventCreated', refresh),
        bus.subscribe('EventUpdated', refresh),
      ]
      return () => {
        for (const stop of stops) {
          stop()
        }
      }
    },
  }
}
