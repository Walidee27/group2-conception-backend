import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GenericContainer, Wait } from 'testcontainers'
import { startPostgresOutboxDatabase } from '../support/postgres-outbox-fixture.ts'

const secret = 'test-application-secret-key-not-for-production'
const alice = '01900000-0000-7000-8000-000000000001'
const seededEvent = '01900000-0000-7000-8000-000000000004'
const json = { 'Content-Type': 'application/json' }

let database: Awaited<ReturnType<typeof startPostgresOutboxDatabase>>
let valkey: Awaited<ReturnType<GenericContainer['start']>>
let collector: ReturnType<typeof Bun.serve>
let databaseUrl: string
const received = new Map<string, string>()

beforeAll(async () => {
  database = await startPostgresOutboxDatabase()
  databaseUrl = database.url
  valkey = await new GenericContainer('valkey/valkey:alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start()
  collector = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url)
      const body = Buffer.from(await request.arrayBuffer()).toString('latin1')
      received.set(pathname, (received.get(pathname) ?? '') + body)
      return new Response(new Uint8Array(0), {
        headers: { 'Content-Type': 'application/x-protobuf' },
      })
    },
  })
}, 120_000)

afterAll(async () => {
  await collector?.stop(true)
  await valkey?.stop()
  await database?.close()
})

function startApi(port: number, env: Record<string, string> = {}) {
  return Bun.spawn(['bun', 'src/bootstrap.ts'], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      APPLICATION_SECRET_KEY: secret,
      DATABASE_URL: databaseUrl,
      VALKEY_URL: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
      EVENT_REPOSITORY: 'postgres',
      OTEL_SERVICE_NAME: 'events-api',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
      OUTBOX_POLL_INTERVAL_MS: '50',
      OTEL_METRIC_EXPORT_INTERVAL: '100',
      ...env,
    },
  })
}

async function eventually<Value>(
  read: () => Promise<Value>,
  accept: (value: Value) => boolean,
): Promise<Value> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read().catch(() => undefined)
    if (value !== undefined && accept(value)) {
      return value
    }
    await Bun.sleep(100)
  }
  throw new Error('Condition jamais atteinte')
}

test('le vrai processus répond, livre l’outbox, exporte sa télémétrie et s’arrête proprement', async () => {
  const port = 39471
  const base = `http://127.0.0.1:${port}`
  const api = startApi(port)
  await eventually(
    () => fetch(`${base}/openapi.json`).then(({ status }) => status),
    (status) => status === 200,
  )

  const login = await fetch(`${base}/user/auth`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ userId: alice }),
  })
  const { token } = (await login.json()) as { token: string }
  const authorized = { ...json, Authorization: `Bearer ${token}` }
  const reserve = (quantity: number) =>
    fetch(`${base}/events/${seededEvent}/reservations`, {
      method: 'POST',
      headers: authorized,
      body: JSON.stringify({ quantity }),
    })

  expect((await fetch(`${base}/events`)).status).toBe(200)
  expect((await reserve(1)).status).toBe(201)
  expect((await reserve(999)).status).toBe(409)
  const denied = await fetch(`${base}/me/reservations`, {
    headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
  })
  expect(denied.status).toBe(401)

  const inbox = await eventually(
    async () =>
      (await (
        await fetch(`${base}/me/notifications`, { headers: authorized })
      ).json()) as unknown[],
    (items) => items.length === 1,
  )
  expect(inbox).toHaveLength(1)

  const created = await fetch(`${base}/events`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      title: 'Concert',
      category: 'music',
      startsAt: '2099-01-01T20:00:00Z',
      capacity: 5,
      venueId: '01900000-0000-7000-8000-000000000003',
    }),
  })
  const { id } = (await created.json()) as { id: string }
  await eventually(
    () => fetch(`${base}/events/${id}`).then(({ status }) => status),
    (status) => status === 200,
  )

  await eventually(
    async () => received.get('/v1/metrics') ?? '',
    (metrics) => metrics.includes('outbox.pending'),
  )
  api.kill('SIGTERM')
  expect(await api.exited).toBe(0)

  const traces = received.get('/v1/traces') ?? ''
  for (const name of [
    'api.startup',
    'POST /events/:eventId/reservations',
    'GET /events',
    'ReserveEvent',
    'SELECT events.events',
    'INSERT events.reservations',
    'send events.outbox',
    'process EventReserved',
    'INSERT notifications.inbox',
    'GET events:read-model:v1',
    'db.query.text',
  ]) {
    expect(traces).toContain(name)
  }
  const metrics = received.get('/v1/metrics') ?? ''
  for (const name of [
    'api.startup.duration',
    'http.server.request.duration',
    'events.commands',
    'outbox.deliveries',
    'notifications.deliveries',
    'outbox.pending',
    'outbox.oldest_pending.age',
    'db.client.operation.duration',
    'process.memory.usage',
  ]) {
    expect(metrics).toContain(name)
  }
  const logs = received.get('/v1/logs') ?? ''
  expect(logs).toContain(Buffer.from('API démarrée').toString('latin1'))
  expect(logs).toContain(Buffer.from('Arrêt de l’API').toString('latin1'))
  for (const signal of [traces, metrics, logs]) {
    expect(signal).not.toContain(token)
    expect(signal).not.toContain('alice@example.com')
  }
}, 60_000)

test('un démarrage impossible se termine avec un code d’erreur et un log', async () => {
  received.delete('/v1/logs')
  const api = startApi(39472, {
    DATABASE_URL: 'postgres://events:events@127.0.0.1:1/events',
  })
  expect(await api.exited).toBe(1)
  expect(received.get('/v1/logs') ?? '').toContain(
    Buffer.from('Échec du démarrage').toString('latin1'),
  )
}, 60_000)
