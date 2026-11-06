import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { observabilityMiddleware } from '#/platform/observability/observability-middleware.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import { anApplication } from '../support/application-fixture.ts'
import { aTelemetryRuntime } from '../support/telemetry-fixture.ts'

let runtime: ReturnType<typeof aTelemetryRuntime>

beforeEach(() => {
  runtime = aTelemetryRuntime()
})

afterEach(() => runtime.finish())

function anObservedApp() {
  const app = new Hono()
  app.use('*', observabilityMiddleware(runtime.telemetry.metrics))
  app.get('/events/:eventId', (c) => c.json({ id: c.req.param('eventId') }))
  app.get('/missing/:id', (c) => c.json({}, 404))
  app.get('/broken', () => {
    throw new TypeError('secret detail')
  })
  app.onError((_error, c) => c.json({ code: 'INTERNAL_ERROR' }, 500))
  return app
}

test('le span SERVER porte la route normalisée, jamais l’URL dans son nom', async () => {
  await anObservedApp().request('/events/42?category=gaming')
  await runtime.shutdown()
  const span = runtime.span('GET /events/:eventId')
  expect(span.kind).toBe(SpanKind.SERVER)
  expect(span.status.code).toBe(SpanStatusCode.UNSET)
  expect(span.attributes['http.route']).toBe('/events/:eventId')
  expect(span.attributes['http.response.status_code']).toBe(200)
  expect(span.attributes['url.path']).toBe('/events/42')
  expect(span.attributes['url.query']).toBeUndefined()
})

test('un 4xx reste sans erreur côté serveur', async () => {
  await anObservedApp().request('/missing/1')
  await runtime.shutdown()
  const span = runtime.span('GET /missing/:id')
  expect(span.attributes['http.response.status_code']).toBe(404)
  expect(span.status.code).toBe(SpanStatusCode.UNSET)
  expect(span.attributes['error.type']).toBeUndefined()
})

test('un 5xx passe le span en erreur avec le type de l’exception', async () => {
  await anObservedApp().request('/broken')
  await runtime.shutdown()
  const span = runtime.span('GET /broken')
  expect(span.status.code).toBe(SpanStatusCode.ERROR)
  expect(span.attributes['error.type']).toBe('TypeError')
})

test('une route inconnue garde un nom de span à faible cardinalité', async () => {
  await anObservedApp().request('/inconnue/019')
  await runtime.shutdown()
  const span = runtime.span('GET')
  expect(span.attributes['http.route']).toBeUndefined()
})

test('un traceparent valide rattache la requête à la trace du client', async () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
  await anObservedApp().request('/events/1', {
    headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
  })
  await runtime.shutdown()
  expect(runtime.span('GET /events/:eventId').spanContext().traceId).toBe(
    traceId,
  )
})

test('un traceparent invalide est ignoré', async () => {
  const response = await anObservedApp().request('/events/1', {
    headers: { traceparent: 'pas-un-contexte' },
  })
  await runtime.shutdown()
  expect(response.status).toBe(200)
  expect(runtime.span('GET /events/:eventId').parentSpanContext).toBeUndefined()
})

test('les métriques HTTP suivent les conventions et les frontières recommandées', async () => {
  await anObservedApp().request('/events/42')
  await runtime.shutdown()
  const [duration] = runtime.metric('http.server.request.duration')
  expect(duration?.descriptor.unit).toBe('s')
  const point = duration?.dataPoints[0] as {
    attributes: Record<string, unknown>
    value: { buckets: { boundaries: number[] } }
  }
  expect(point.attributes).toEqual({
    'http.request.method': 'GET',
    'url.scheme': 'http',
    'http.response.status_code': 200,
    'http.route': '/events/:eventId',
  })
  expect(point.value.buckets.boundaries).toEqual([
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
  ])
  const [active] = runtime.metric('http.server.active_requests')
  expect(active?.dataPoints[0]?.value).toBe(0)
})

test('une erreur inconnue produit un seul log, relié à la trace de la requête', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const fixture = anApplication({ telemetry: runtime.telemetry })
  fixture.repository.listReservations = () => {
    throw new TypeError('secret detail')
  }
  const app = fixture.container.resolve(TOKEN.App)
  const headers = await fixture.headersFor(fixture.alice)
  const response = await app.request('/me/reservations', { headers })
  await runtime.shutdown()
  log.mockRestore()
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('secret detail')
  const span = runtime.span('GET /me/reservations')
  const errors = runtime.records.filter(
    ({ severityText }) => severityText === 'ERROR',
  )
  expect(errors).toHaveLength(1)
  expect(errors[0]?.attributes['exception.type']).toBe('TypeError')
  expect(errors[0]?.spanContext?.traceId).toBe(span.spanContext().traceId)
  expect(errors[0]?.spanContext?.spanId).toBe(span.spanContext().spanId)
})

test('un 401 d’authenticate reste visible, avec sa route normalisée', async () => {
  const fixture = anApplication({ telemetry: runtime.telemetry })
  const response = await fixture.container
    .resolve(TOKEN.App)
    .request('/me/reservations', {
      headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
    })
  await runtime.shutdown()
  expect(response.status).toBe(401)
  const span = runtime.span('GET /me/reservations')
  expect(span.attributes['http.response.status_code']).toBe(401)
  expect(span.status.code).toBe(SpanStatusCode.UNSET)
})
