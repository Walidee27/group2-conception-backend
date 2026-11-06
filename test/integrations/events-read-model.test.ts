import { afterAll, beforeAll, expect, test } from 'bun:test'
import { RedisClient } from 'bun'
import { GenericContainer } from 'testcontainers'
import { createContainer } from '#/composition-root.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import { ValkeyEventReadRepository } from '#/features/events/infrastructure/repository/valkey-event-read-repository.ts'
import { createEventsReadModelSubscriber } from '#/features/events/infrastructure/events-read-model-subscriber.ts'
import { Event } from '#/features/events/domain/event.ts'
import { InMemoryEventBus } from '#/platform/messaging/in-memory-event-bus.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import type { EventProjectionRepository } from '#/features/events/application/ports.ts'
import { Option } from '#/shared-kernel/option.ts'
import { Result } from '#/shared-kernel/result.ts'
import { anApplication } from '../support/application-fixture.ts'

let client: RedisClient
let close = async () => {}
beforeAll(async () => {
  const container = await new GenericContainer('valkey/valkey:8-alpine')
    .withExposedPorts(6379)
    .start()
  client = new RedisClient(
    `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
  )
  close = async () => {
    client.close()
    await container.stop()
  }
}, 60_000)
afterAll(async () => {
  await close()
})

test('event queries use Valkey while writes and seat checks use the authoritative repository', async () => {
  const fixture = anApplication()
  const projection = new ValkeyEventReadRepository(
    client,
    'test:read-model:commands',
  )
  await projection.replaceEvents([])
  const container = createContainer({
    applicationSecretKey: 'test-application-secret-key-not-for-production',
    repository: fixture.repository,
    readRepository: projection,
    clock: { now: () => new Date('2030-01-01') },
    notificationLogger: { log() {} },
  })
  const event = Result.getOrThrow(
    await container
      .resolve(TOKEN.CreateEventUseCase)
      .execute(fixture.eventInput),
  )
  await container.resolve(TOKEN.OutboxDispatcher).drain()
  expect(
    Option.getOrNull(await projection.findEvent(event.data.id))?.data,
  ).toEqual(event.data)
  const updated = Result.getOrThrow(
    await container
      .resolve(TOKEN.UpdateEventUseCase)
      .execute({ id: event.data.id, patch: { title: 'Updated' } }),
  )
  await container.resolve(TOKEN.OutboxDispatcher).drain()
  expect(
    Option.getOrNull(await projection.findEvent(event.data.id))?.data,
  ).toEqual(updated.data)
  expect(await projection.listEvents({ category: 'other' })).toEqual([])
  expect(
    await projection.listEvents({ after: fixture.eventInput.startsAt }),
  ).toEqual([])

  // Commands must check capacity even if the read model is missing or stale.
  await projection.replaceEvents([])
  expect(await container.resolve(TOKEN.ListEventsUseCase).execute({})).toEqual(
    [],
  )
  const reserve = container.resolve(TOKEN.ReserveEventUseCase)
  expect(
    Result.isSuccess(
      await reserve.execute({
        eventId: event.data.id,
        userId: fixture.alice,
        quantity: 1,
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      await reserve.execute({
        eventId: event.data.id,
        userId: fixture.bob,
        quantity: 1,
      }),
    ),
  ).toBe(true)

  // Rebuilding restores the read model from stored events.
  const subscriber = createEventsReadModelSubscriber(
    fixture.repository,
    projection,
  )
  await subscriber.refresh()
  expect(
    await container.resolve(TOKEN.GetEventUseCase).execute(event.data.id),
  ).toEqual(Result.succeed(updated))
  container.resolve(TOKEN.EventReadModelSubscription)()
  await container
    .resolve(TOKEN.UpdateEventUseCase)
    .execute({ id: event.data.id, patch: { title: 'Not projected' } })
  expect(
    Option.getOrNull(await projection.findEvent(event.data.id))?.data.title,
  ).toBe('Updated')
})

test('refreshes are serialized, recover after failure, and ignore stale message payloads', async () => {
  const fixture = anApplication()
  const event = await fixture.createEvent()
  const saved: (readonly Event[])[] = []
  let fail = true
  const projection: EventProjectionRepository = {
    listEvents: async () => [],
    findEvent: async () => Option.none(),
    replaceEvents: async (events) => {
      if (fail) {
        fail = false
        throw new Error('Valkey unavailable')
      }
      saved.push(events)
    },
  }
  const subscriber = createEventsReadModelSubscriber(
    fixture.repository,
    projection,
  )
  await expect(subscriber.refresh()).rejects.toThrow('Valkey unavailable')
  await Promise.all([subscriber.refresh(), subscriber.refresh()])
  expect(saved).toHaveLength(2)
  const bus = new InMemoryEventBus<DomainEvent>()
  const stop = subscriber.subscribe(bus)
  await bus.publish({
    messageId: 'replayed',
    version: 1,
    occurredAt: new Date(),
    event: {
      _tag: 'EventUpdated',
      content: {
        ...fixture.eventInput,
        capacity: 99,
        eventId: event.data.id,
        title: 'stale',
      },
    },
  })
  expect(saved[2]?.[0]?.data.title).toBe(event.data.title)
  stop()
})
