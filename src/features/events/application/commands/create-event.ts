import { observedCommand } from '#/features/events/application/observed-command.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import {
  Event,
  EventData,
  type EventInput,
} from '#/features/events/domain/event.ts'
import type { CommandHandler } from '#/shared-kernel/command-handler.ts'
import type { ApplicationError } from '#/features/events/application/ports.ts'
import type { EventId } from '#/features/events/domain/ids.ts'
import { InvalidInput } from '#/features/events/domain/errors.ts'
import { Result } from '#/shared-kernel/result.ts'
import type {
  Clock,
  EventsUnitOfWork,
  IdGenerator,
} from '#/features/events/application/ports.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'

export class CreateEventUseCase implements CommandHandler<
  EventInput,
  Result<Event, ApplicationError>
> {
  constructor(
    private readonly unitOfWork: EventsUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  execute(input: EventInput) {
    return observedCommand(this.telemetry, 'CreateEvent', () =>
      this.perform(input),
    )
  }

  private async perform(input: EventInput) {
    const result = Event.create({ ...input, id: this.ids.next<EventId>() })
    const now = this.clock.now()
    if (Result.isFailure(result)) {
      return result
    }
    if (result.value.data.startsAt <= now) {
      return Result.fail(new InvalidInput('Event must start in the future'))
    }
    return this.unitOfWork.run(async ({ events, outbox }) => {
      const persisted = await events.createEvent(result.value)
      if (Result.isSuccess(persisted)) {
        const success = persisted.value.data
        await outbox.append(this.envelope(success))
      }
      return persisted
    })
  }

  private envelope(event: EventData): EventEnvelope<DomainEvent> {
    return {
      messageId: this.ids.next<string>(),
      occurredAt: this.clock.now(),
      version: 1,
      event: eventCreated(event),
    }
  }
}

const eventCreated = (success: Readonly<EventData>) => ({
  _tag: 'EventCreated' as const,
  content: {
    eventId: success.id,
    title: success.title,
    category: success.category,
    startsAt: success.startsAt,
    capacity: success.capacity.value,
    venueId: success.venueId,
  },
})
