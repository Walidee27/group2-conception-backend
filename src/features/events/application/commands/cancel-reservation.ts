import { observedCommand } from '#/features/events/application/observed-command.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import type { CommandHandler } from '#/shared-kernel/command-handler.ts'
import { Result } from '#/shared-kernel/result.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'
import type {
  Reservation,
  ReservationData,
} from '#/features/events/domain/reservation.ts'
import type {
  ApplicationError,
  Clock,
  EventsUnitOfWork,
  IdGenerator,
} from '#/features/events/application/ports.ts'
import type { ReservationId, UserId } from '#/features/events/domain/ids.ts'

export interface CancelReservationCommand {
  id: ReservationId
  userId: UserId
}

export class CancelReservationUseCase implements CommandHandler<
  CancelReservationCommand,
  Result<Reservation, ApplicationError>
> {
  constructor(
    private readonly unitOfWork: EventsUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  execute(command: CancelReservationCommand) {
    return observedCommand(this.telemetry, 'CancelReservation', () =>
      this.perform(command),
    )
  }

  private async perform({ id, userId }: CancelReservationCommand) {
    return this.unitOfWork.run(async ({ events, outbox }) => {
      const result = await events.cancelReservation(id, userId, (reservation) =>
        reservation.cancel(this.clock.now()),
      )
      if (Result.isSuccess(result)) {
        const reservation = result.value.data
        await outbox.append(this.envelope(reservation))
      }
      return result
    })
  }

  private envelope(reservation: ReservationData): EventEnvelope<DomainEvent> {
    return {
      messageId: this.ids.next<string>(),
      occurredAt: this.clock.now(),
      version: 1,
      event: reservationCancelled(reservation),
    }
  }
}

const reservationCancelled = (reservation: Readonly<ReservationData>) => ({
  _tag: 'ReservationCancelled' as const,
  content: {
    reservationId: reservation.id,
    eventId: reservation.eventId,
    userId: reservation.userId,
    quantity: reservation.quantity,
  },
})
