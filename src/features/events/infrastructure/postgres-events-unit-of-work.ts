import type { SQL } from 'bun'
import type {
  ApplicationError,
  EventRepository,
  EventsUnitOfWork,
  OutboxWriter,
} from '#/features/events/application/ports.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'
import { Result, type Failure } from '#/shared-kernel/result.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import { PostgresEventRepository } from './repository/postgres-event-repository.ts'

// A normal return from Bun's transaction callback commits, including a Failure.
// This private signal forces rollback without exposing business failures as throws.
class RollbackResult {
  constructor(readonly result: Failure<ApplicationError>) {}
}

export class PostgresOutboxWriter implements OutboxWriter {
  constructor(
    private readonly tx: SQL,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  append(envelope: EventEnvelope<DomainEvent>): Promise<void> {
    const { operations } = this.telemetry
    return operations.run(
      'send events.outbox',
      async () => {
        const traceContext = operations.carrier()
        const traced = Object.keys(traceContext).length
          ? { ...envelope, traceContext }
          : envelope
        await this.tx`INSERT INTO events.outbox (message_id, envelope)
          VALUES (${envelope.messageId}, ${traced}::jsonb)`
      },
      {
        kind: 'producer',
        attributes: {
          'messaging.system.name': 'postgres_outbox',
          'messaging.operation.name': 'send',
          'messaging.operation.type': 'send',
          'messaging.destination.name': 'events.outbox',
          'messaging.message.id': envelope.messageId,
        },
      },
    )
  }
}

export class PostgresEventsUnitOfWork implements EventsUnitOfWork {
  constructor(
    private readonly sql: SQL,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  async run<Value>(
    work: (scope: {
      events: EventRepository
      outbox: OutboxWriter
    }) => Promise<Result<Value, ApplicationError>>,
  ): Promise<Result<Value, ApplicationError>> {
    try {
      return await this.sql.begin(async (tx) => {
        const result = await work({
          events: new PostgresEventRepository(tx, true),
          outbox: new PostgresOutboxWriter(tx, this.telemetry),
        })
        if (Result.isFailure(result)) {
          throw new RollbackResult(result)
        }
        return result
      })
    } catch (cause) {
      if (cause instanceof RollbackResult) {
        return cause.result
      }
      throw cause
    }
  }
}
