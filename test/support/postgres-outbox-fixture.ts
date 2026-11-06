import { SQL } from 'bun'
import { GenericContainer, Wait } from 'testcontainers'
import { Event } from '#/features/events/domain/event.ts'
import {
  EventId,
  ReservationId,
  UserId,
  VenueId,
  makeId,
} from '#/features/events/domain/ids.ts'
import { PostgresEventRepository } from '#/features/events/infrastructure/repository/postgres-event-repository.ts'
import { PostgresEventsUnitOfWork } from '#/features/events/infrastructure/postgres-events-unit-of-work.ts'
import { PostgresOutboxStore } from '#/features/events/infrastructure/postgres-outbox-store.ts'
import { OutboxDispatcher } from '#/features/events/application/outbox-dispatcher.ts'
import { ReserveEventUseCase } from '#/features/events/application/commands/reserve-event.ts'
import { CreateEventUseCase } from '#/features/events/application/commands/create-event.ts'
import { CancelReservationUseCase } from '#/features/events/application/commands/cancel-reservation.ts'
import { UpdateEventUseCase } from '#/features/events/application/commands/update-event.ts'
import { InMemoryEventBus } from '#/platform/messaging/in-memory-event-bus.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventEnvelope } from '#/shared-kernel/event-envelope.ts'
import { Result } from '#/shared-kernel/result.ts'

const alice = UserId.makeUnsafe('01900000-0000-7000-8000-000000000001')
const venueId = VenueId.makeUnsafe('01900000-0000-7000-8000-000000000003')
const clock = { now: () => new Date('2030-01-01T00:00:00Z') }
const ids = { next: makeId }

export async function startPostgresOutboxDatabase() {
  const container = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({
      POSTGRES_DB: 'events',
      POSTGRES_USER: 'events',
      POSTGRES_PASSWORD: 'events',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage('database system is ready to accept connections', 2),
    )
    .start()
  const url = `postgres://events:events@${container.getHost()}:${container.getMappedPort(5432)}/events`
  const sql = new SQL(url)
  const peer = new SQL(url)
  const close = async () => {
    try {
      await Promise.all([sql.close(), peer.close()])
    } finally {
      await container.stop()
    }
  }
  try {
    // init.sql owns BEGIN/COMMIT, so it must run on one reserved connection.
    const connection = await sql.reserve()
    try {
      await connection.unsafe(
        await Bun.file(new URL('../../sql/init.sql', import.meta.url)).text(),
      )
    } finally {
      connection.release()
    }
  } catch (cause) {
    await close()
    throw cause
  }
  return {
    url,
    sql,
    peer,
    close,
    reset: async () => {
      await sql`TRUNCATE events.outbox, events.reservations, events.events`
    },
  }
}

export function anOutboxApplication(
  database: Awaited<ReturnType<typeof startPostgresOutboxDatabase>>,
) {
  const { sql, peer } = database
  const unitOfWork = new PostgresEventsUnitOfWork(sql)
  const bus = new InMemoryEventBus<DomainEvent>(true)
  const store = new PostgresOutboxStore(sql)
  const messages: EventEnvelope<DomainEvent>[] = []
  for (const tag of [
    'EventCreated',
    'EventUpdated',
    'EventReserved',
    'ReservationCancelled',
  ] as const) {
    bus.subscribe(tag, (message) => {
      messages.push(message)
    })
  }
  const event = Result.getOrThrow(
    Event.create({
      id: EventId.make(),
      title: 'Outbox lesson',
      category: 'gaming',
      startsAt: new Date('2030-01-02T18:00:00Z'),
      capacity: 1,
      venueId,
    }),
  )
  const message: EventEnvelope<DomainEvent> = {
    messageId: makeId<string>(),
    occurredAt: clock.now(),
    version: 1,
    event: {
      _tag: 'EventReserved',
      content: {
        eventId: event.data.id,
        reservationId: ReservationId.make(),
        userId: alice,
        quantity: 1,
      },
    },
  }
  return {
    alice,
    clock,
    event,
    message,
    messages,
    bus,
    unitOfWork,
    store,
    repository: new PostgresEventRepository(sql),
    peerRepository: new PostgresEventRepository(peer),
    peerStore: new PostgresOutboxStore(peer),
    dispatcher: new OutboxDispatcher(store, bus),
    create: new CreateEventUseCase(unitOfWork, clock, ids),
    update: new UpdateEventUseCase(unitOfWork, clock, ids),
    reserve: new ReserveEventUseCase(unitOfWork, clock, ids),
    reserveWithFailingOutbox: new ReserveEventUseCase(
      {
        run: (work) =>
          unitOfWork.run((scope) =>
            work({
              events: scope.events,
              outbox: {
                append: async (envelope) => {
                  await scope.outbox.append(envelope)
                  // A real uniqueness violation, after the reservation was written.
                  await scope.outbox.append(envelope)
                },
              },
            }),
          ),
      },
      clock,
      ids,
    ),
    peerReserve: new ReserveEventUseCase(
      new PostgresEventsUnitOfWork(peer),
      clock,
      ids,
    ),
    cancel: new CancelReservationUseCase(unitOfWork, clock, ids),
    async storedEvents() {
      return peer`SELECT * FROM events.events`
    },
    async storedReservations() {
      return peer`SELECT * FROM events.reservations`
    },
    async pendingMessages() {
      return peer`SELECT * FROM events.outbox WHERE published_at IS NULL`
    },
    async storedMessages() {
      return peer`SELECT * FROM events.outbox`
    },
    async enqueueMessage() {
      return unitOfWork.run(async ({ outbox }) => {
        await outbox.append(message)
        return Result.succeed(undefined)
      })
    },
  }
}

export function aSignal() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
