import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  test,
} from 'bun:test'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { createContainer } from '#/composition-root.ts'
import { PostgresEventsUnitOfWork } from '#/features/events/infrastructure/postgres-events-unit-of-work.ts'
import { PostgresOutboxStore } from '#/features/events/infrastructure/postgres-outbox-store.ts'
import { PostgresEventRepository } from '#/features/events/infrastructure/repository/postgres-event-repository.ts'
import { PostgresIdentityRepository } from '#/features/identity/infrastructure/postgres-identity-repository.ts'
import { PostgresNotificationRepository } from '#/features/notifications/infrastructure/postgres-notification-repository.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import { tracedSql } from '#/platform/observability/traced-sql.ts'
import { startPostgresOutboxDatabase } from '../support/postgres-outbox-fixture.ts'
import { aTelemetryRuntime } from '../support/telemetry-fixture.ts'

const alice = '01900000-0000-7000-8000-000000000001'
const seededEvent = '01900000-0000-7000-8000-000000000004'

let database: Awaited<ReturnType<typeof startPostgresOutboxDatabase>>
let runtime: ReturnType<typeof aTelemetryRuntime>

beforeAll(async () => {
  database = await startPostgresOutboxDatabase()
}, 60_000)

afterAll(async () => {
  await database.close()
})

beforeEach(async () => {
  runtime = aTelemetryRuntime()
  await database.sql`TRUNCATE events.outbox, events.reservations`
  await database.sql`TRUNCATE notifications.inbox, notifications.processed_messages`
})

afterEach(() => runtime.finish())

function anObservedApi() {
  const { telemetry } = runtime
  const sql = tracedSql(database.sql, telemetry)
  const store = new PostgresOutboxStore(sql)
  const container = createContainer({
    applicationSecretKey: 'test-application-secret-key-not-for-production',
    repository: new PostgresEventRepository(sql),
    unitOfWork: new PostgresEventsUnitOfWork(sql, telemetry),
    outboxStore: store,
    identityRepository: new PostgresIdentityRepository(sql),
    notificationRepository: new PostgresNotificationRepository(sql),
    telemetry,
  })
  const app = container.resolve(TOKEN.App)
  return {
    store,
    app,
    drain: () => container.resolve(TOKEN.OutboxDispatcher).drain(),
    async login() {
      const response = await app.request('/user/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: alice }),
      })
      return ((await response.json()) as { token: string }).token
    },
    reserve(token: string, quantity: number) {
      return app.request(`/events/${seededEvent}/reservations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ quantity }),
      })
    },
  }
}

test('une réservation reste dans une seule trace, du HTTP à la notification', async () => {
  const api = anObservedApi()
  const token = await api.login()
  expect((await api.reserve(token, 1)).status).toBe(201)
  expect(await api.store.pendingCount()).toBe(1)
  expect(await api.store.oldestPendingAge()).toBeGreaterThanOrEqual(0)
  const [stored] = await database.sql<
    { envelope: { traceContext: { traceparent: string } } }[]
  >`SELECT envelope FROM events.outbox`
  expect(stored?.envelope.traceContext.traceparent).toMatch(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
  )
  expect(await api.drain()).toBe(1)
  expect(await api.store.pendingCount()).toBe(0)
  await runtime.shutdown()

  const server = runtime.span('POST /events/:eventId/reservations')
  const command = runtime.span('ReserveEvent')
  const lock = runtime.span('SELECT events.events')
  const insert = runtime.span('INSERT events.reservations')
  const send = runtime.span('send events.outbox')
  const process = runtime.span('process EventReserved')
  const inbox = runtime.span('INSERT notifications.inbox')

  const traceId = server.spanContext().traceId
  for (const span of [command, lock, insert, send, process, inbox]) {
    expect(span.spanContext().traceId).toBe(traceId)
  }
  expect(server.kind).toBe(SpanKind.SERVER)
  expect(command.parentSpanContext?.spanId).toBe(server.spanContext().spanId)
  expect(lock.parentSpanContext?.spanId).toBe(command.spanContext().spanId)
  expect(lock.kind).toBe(SpanKind.CLIENT)
  expect(lock.attributes['db.system.name']).toBe('postgresql')
  expect(send.kind).toBe(SpanKind.PRODUCER)
  expect(process.kind).toBe(SpanKind.CONSUMER)
  expect(process.parentSpanContext?.spanId).toBe(send.spanContext().spanId)
  expect(inbox.parentSpanContext?.spanId).toBe(process.spanContext().spanId)
})

test('une place refusée n’est pas une erreur de span, mais un résultat compté', async () => {
  const api = anObservedApi()
  const token = await api.login()
  expect((await api.reserve(token, 21)).status).toBe(409)
  await runtime.shutdown()
  expect(runtime.span('ReserveEvent').status.code).toBe(SpanStatusCode.UNSET)
  const [commands] = runtime.metric('events.commands')
  expect(commands?.dataPoints[0]?.attributes).toEqual({
    command: 'ReserveEvent',
    outcome: 'conflict',
  })
})

test('un message relivré est compté comme doublon, pas comme nouvelle notification', async () => {
  const api = anObservedApi()
  const token = await api.login()
  await api.reserve(token, 1)
  await api.drain()
  await database.sql`UPDATE events.outbox SET published_at = NULL`
  expect(await api.drain()).toBe(1)
  await runtime.shutdown()
  const [deliveries] = runtime.metric('notifications.deliveries')
  const points = (deliveries?.dataPoints ?? []) as {
    attributes: Record<string, unknown>
    value: unknown
  }[]
  const count = (outcome: string) =>
    points.find(({ attributes }) => attributes.outcome === outcome)?.value
  expect(count('delivered')).toBe(1)
  expect(count('duplicate')).toBe(1)
  const [rows] = await database.sql<
    { total: number }[]
  >`SELECT count(*)::int AS total FROM notifications.inbox`
  expect(rows?.total).toBe(1)
})

test('la télémétrie ne contient ni jeton, ni email, ni identifiant utilisateur', async () => {
  const api = anObservedApi()
  const token = await api.login()
  await api.reserve(token, 21)
  await api.reserve(token, 1)
  await api.drain()
  await runtime.shutdown()
  const exported = JSON.stringify({
    spans: runtime.spans.map(({ name, attributes, events }) => ({
      name,
      attributes,
      events,
    })),
    logs: runtime.records.map(({ body, attributes }) => ({ body, attributes })),
    metrics: runtime
      .metric('events.commands')
      .map(({ dataPoints }) => JSON.stringify(dataPoints)),
  })
  expect(exported).not.toContain(token)
  expect(exported).not.toContain(alice)
  expect(exported).not.toContain('alice@example.com')
  expect(exported).not.toContain('Authorization')
})

test('chaque requête SQL d’une route GET est tracée, avec son texte sans ses valeurs', async () => {
  const api = anObservedApi()
  const token = await api.login()
  await api.reserve(token, 1)
  const response = await api.app.request('/me/reservations', {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  await runtime.shutdown()
  const route = runtime.span('GET /me/reservations')
  const queries = runtime.spans.filter(
    ({ parentSpanContext }) =>
      parentSpanContext?.spanId === route.spanContext().spanId,
  )
  expect(queries.map(({ name }) => name)).toEqual([
    'SELECT identity.sessions',
    'SELECT events.users',
    'SELECT events.reservations',
  ])
  for (const query of queries) {
    expect(query.kind).toBe(SpanKind.CLIENT)
    expect(query.attributes['db.system.name']).toBe('postgresql')
    expect(query.attributes['db.query.text']).toContain('$1')
    expect(query.attributes['db.query.text']).not.toContain(alice)
  }
  const [duration] = runtime.metric('db.client.operation.duration')
  expect(duration?.descriptor.unit).toBe('s')
  expect(
    JSON.stringify(duration?.dataPoints.map(({ attributes }) => attributes)),
  ).toContain('"db.collection.name":"events.reservations"')
  expect(JSON.stringify(duration?.dataPoints)).not.toContain('db.query.text')
})

test('une requête SQL sans opération parente ne crée pas de trace', async () => {
  const sql = tracedSql(database.sql, runtime.telemetry)
  await sql`SELECT 1`
  await runtime.shutdown()
  expect(runtime.spans).toEqual([])
})
