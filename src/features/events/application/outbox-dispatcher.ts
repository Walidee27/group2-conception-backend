import type { OutboxStore } from './ports.ts'
import type { EventBus } from '#/shared-kernel/event-bus.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'

export class OutboxDispatcher {
  constructor(
    private readonly store: OutboxStore,
    private readonly bus: EventBus<DomainEvent>,
    private readonly telemetry: Telemetry = noTelemetry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Bounded manual exercise. Stop on failure; the next drain retries that message.
  async drain(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('Invalid drain limit')
    }
    let delivered = 0
    while (
      delivered < limit &&
      (await this.store.deliverNext((message) => this.deliver(message)))
    ) {
      delivered++
    }
    return delivered
  }

  private deliver(message: EventEnvelope<DomainEvent>): Promise<void> {
    const eventType = message.event._tag
    const { logger, metrics, operations } = this.telemetry
    return operations.run(
      `process ${eventType}`,
      async () => {
        try {
          await this.bus.publish(message)
        } catch (error) {
          metrics.increment('outbox.deliveries', {
            'event.type': eventType,
            outcome: 'failed',
          })
          logger.error('Échec de livraison d’un message', error, {
            'messaging.message.id': message.messageId,
            'event.type': eventType,
          })
          throw error
        }
        metrics.increment('outbox.deliveries', {
          'event.type': eventType,
          outcome: 'delivered',
        })
        metrics.record(
          'outbox.delivery.lag',
          (this.now().getTime() - message.occurredAt.getTime()) / 1000,
          { 'event.type': eventType },
        )
      },
      {
        kind: 'consumer',
        parent: message.traceContext,
        attributes: {
          'messaging.system.name': 'postgres_outbox',
          'messaging.operation.name': 'process',
          'messaging.operation.type': 'process',
          'messaging.destination.name': 'events.outbox',
          'messaging.message.id': message.messageId,
        },
      },
    )
  }
}
