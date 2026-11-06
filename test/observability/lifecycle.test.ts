import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { SpanStatusCode } from '@opentelemetry/api'
import { observedStartup } from '#/platform/observability/lifecycle.ts'
import { aTelemetryRuntime } from '../support/telemetry-fixture.ts'

let runtime: ReturnType<typeof aTelemetryRuntime>

beforeEach(() => {
  runtime = aTelemetryRuntime()
})

afterEach(() => runtime.finish())

test('un démarrage réussi produit un span, une durée et un log', async () => {
  const value = await observedStartup(runtime.telemetry, async () => 'prêt')
  await runtime.shutdown()
  expect(value).toBe('prêt')
  expect(runtime.span('api.startup').status.code).toBe(SpanStatusCode.UNSET)
  const [duration] = runtime.metric('api.startup.duration')
  expect(duration?.dataPoints[0]?.attributes).toEqual({ outcome: 'success' })
  expect(runtime.records.map(({ body }) => body)).toContain('API démarrée')
})

test('un démarrage en échec est visible et l’erreur remonte', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('PostgreSQL injoignable')
  await expect(
    observedStartup(runtime.telemetry, async () => {
      throw failure
    }),
  ).rejects.toBe(failure)
  await runtime.shutdown()
  log.mockRestore()
  expect(runtime.span('api.startup').status.code).toBe(SpanStatusCode.ERROR)
  const [duration] = runtime.metric('api.startup.duration')
  expect(duration?.dataPoints[0]?.attributes).toEqual({ outcome: 'failed' })
  const errors = runtime.records.filter(
    ({ severityText }) => severityText === 'ERROR',
  )
  expect(errors[0]?.attributes['exception.message']).toBe(
    'PostgreSQL injoignable',
  )
})
