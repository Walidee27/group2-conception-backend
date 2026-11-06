import { observedCommand } from '#/features/events/application/observed-command.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import type { CommandHandler } from '#/shared-kernel/command-handler.ts'
import { Result } from '#/shared-kernel/result.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'
import type { ApplicationError } from '#/features/events/application/ports.ts'
import type {
  Event,
  EventData,
  EventInput,
} from '#/features/events/domain/event.ts'
import type { EventId } from '#/features/events/domain/ids.ts'
import type {
  Clock,
  EventsUnitOfWork,
  IdGenerator,
} from '#/features/events/application/ports.ts'

export interface UpdateEventCommand {
  id: EventId
  patch: Partial<EventInput>
}

export class UpdateEventUseCase implements CommandHandler<
  UpdateEventCommand,
  Result<Event, ApplicationError>
> {
  constructor(
    private readonly unitOfWork: EventsUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  execute(command: UpdateEventCommand) {
    return observedCommand(this.telemetry, 'UpdateEvent', () =>
      this.perform(command),
    )
  }

  private async perform({ id, patch }: UpdateEventCommand) {
    return this.unitOfWork.run(async ({ events, outbox }) => {
      const result = await events.updateEvent(id, (event, seats) =>
        event.update(patch, seats, this.clock.now()),
      )
      if (Result.isSuccess(result)) {
        const event = result.value.data
        await outbox.append(this.envelope(event))
      }
      return result
    })
  }

  private envelope(event: Readonly<EventData>): EventEnvelope<DomainEvent> {
    return {
      messageId: this.ids.next<string>(),
      occurredAt: this.clock.now(),
      version: 1,
      event: {
        _tag: 'EventUpdated',
        content: {
          eventId: event.id,
          title: event.title,
          category: event.category,
          startsAt: event.startsAt,
          capacity: event.capacity.value,
          venueId: event.venueId,
        },
      },
    }
  }
}
