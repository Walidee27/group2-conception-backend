import { observedCommand } from '#/features/events/application/observed-command.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import type { CommandHandler } from '#/shared-kernel/command-handler.ts'
import type { ApplicationError } from '#/features/events/application/ports.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'
import {
  Reservation,
  ReservationData,
} from '#/features/events/domain/reservation.ts'
import type {
  EventId,
  ReservationId,
  UserId,
} from '#/features/events/domain/ids.ts'
import { Option } from '#/shared-kernel/option.ts'
import { Result } from '#/shared-kernel/result.ts'
import type {
  Clock,
  EventsUnitOfWork,
  IdGenerator,
} from '#/features/events/application/ports.ts'

export interface ReserveEventCommand {
  eventId: EventId
  userId: UserId
  quantity: number
}

export class ReserveEventUseCase implements CommandHandler<
  ReserveEventCommand,
  Result<Reservation, ApplicationError>
> {
  constructor(
    private readonly unitOfWork: EventsUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  execute(input: ReserveEventCommand) {
    return observedCommand(this.telemetry, 'ReserveEvent', () =>
      this.perform(input),
    )
  }

  private async perform(input: ReserveEventCommand) {
    return this.unitOfWork.run(async ({ events, outbox }) => {
      const result = await events.reserve(input.eventId, (event, seats) => {
        const now = this.clock.now()
        const checked = event.checkReservation(input.quantity, seats, now)
        if (Result.isFailure(checked)) {
          return checked
        }
        return Result.succeed(
          new Reservation({
            ...input,
            id: this.ids.next<ReservationId>(),
            createdAt: now,
            cancelledAt: Option.none(),
          }),
        )
      })
      if (Result.isSuccess(result)) {
        const reservation = result.value.data
        await outbox.append(this.envelope(reservation))
      }
      return result
    })
  }

  private envelope(event: ReservationData): EventEnvelope<DomainEvent> {
    return {
      messageId: this.ids.next<string>(),
      occurredAt: this.clock.now(),
      version: 1,
      event: eventReserved(event),
    }
  }
}

const eventReserved = (reservation: Readonly<ReservationData>) => ({
  _tag: 'EventReserved' as const,
  content: {
    reservationId: reservation.id,
    eventId: reservation.eventId,
    userId: reservation.userId,
    quantity: reservation.quantity,
  },
})
