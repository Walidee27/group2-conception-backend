import * as v from 'valibot'
import { sessionSchema } from '#/features/identity/routes/session-routes.ts'
import { InMemoryIdentityRepository } from '#/features/identity/infrastructure/in-memory-identity-repository.ts'
import { createContainer } from '#/composition-root.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'
import type { EventInput } from '#/features/events/domain/event.ts'
import { UserId, VenueId } from '#/features/events/domain/ids.ts'
import { InMemoryEventRepository } from '#/features/events/infrastructure/repository/in-memory-event-repository.ts'
import { Result } from '#/shared-kernel/result.ts'
import type { Telemetry } from '#/shared-kernel/telemetry.ts'

// Each scenario owns its repository and clock. No HTTP app or external storage.
export function anApplication(options: { telemetry?: Telemetry } = {}) {
  const alice = UserId.make()
  const bob = UserId.make()
  const venueId = VenueId.make()
  let now = new Date('2030-01-01T00:00:00Z')
  const repository = new InMemoryEventRepository({
    users: new Set([alice, bob]),
    venues: new Set([venueId]),
  })
  const notifications: EventEnvelope<DomainEvent>[] = []
  const container = createContainer({
    telemetry: options.telemetry,
    applicationSecretKey: 'test-application-secret-key-not-for-production',
    repository,
    identityRepository: new InMemoryIdentityRepository(new Set([alice, bob])),
    clock: { now: () => new Date(now) },
    notificationLogger: {
      log: (_message, event) => {
        notifications.push(event)
      },
    },
  })
  const services = {
    identity: container.resolve(TOKEN.Identity),
    read: {
      list: container.resolve(TOKEN.ListEventsUseCase),
      get: container.resolve(TOKEN.GetEventUseCase),
      reservationsFor: container.resolve(TOKEN.ListReservationsUseCase),
    },
    create: container.resolve(TOKEN.CreateEventUseCase),
    update: container.resolve(TOKEN.UpdateEventUseCase),
    reserve: container.resolve(TOKEN.ReserveEventUseCase),
    cancel: container.resolve(TOKEN.CancelReservationUseCase),
  }
  const eventInput: EventInput = {
    title: 'Game night',
    category: 'gaming',
    startsAt: new Date('2030-01-02T18:00:00Z'),
    capacity: 1,
    venueId,
  }

  return {
    alice,
    bob,
    venueId,
    repository,
    container,
    notifications,
    drain: (limit?: number) =>
      container.resolve(TOKEN.OutboxDispatcher).drain(limit),
    services,
    eventInput,
    async headersFor(userId: string) {
      const session = v.parse(
        sessionSchema,
        await container.resolve(TOKEN.SessionService).create(userId),
      )
      return { Authorization: `Bearer ${session.token}` }
    },
    advanceTo(date: Date) {
      now = new Date(date)
    },
    async createEvent(patch: Partial<EventInput> = {}) {
      return Result.getOrThrow(
        await services.create.execute({ ...eventInput, ...patch }),
      )
    },
  }
}

export async function anExistingEvent(patch: Partial<EventInput> = {}) {
  const application = anApplication()
  const event = await application.createEvent(patch)
  await application.drain()
  return { ...application, event }
}

export async function anEventWithReservation() {
  const application = await anExistingEvent({ capacity: 2 })
  const { event } = application
  const reservation = Result.getOrThrow(
    await application.services.reserve.execute({
      eventId: event.data.id,
      userId: application.alice,
      quantity: 2,
    }),
  )
  return { ...application, event, reservation }
}
