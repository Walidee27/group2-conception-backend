import { expect, spyOn, test } from 'bun:test'
import {
  createOpenTelemetry,
  type TelemetrySources,
} from '#/platform/observability/open-telemetry.ts'
import { startTelemetry } from '#/telemetry.ts'
import { noTelemetry } from '#/shared-kernel/telemetry.ts'

const broken = (): never => {
  throw new Error('adapter')
}
const brokenSources: TelemetrySources = {
  tracer: broken,
  meter: broken,
  logger: broken,
}

test('une panne de l’adaptateur ne change pas le résultat de l’opération', async () => {
  const telemetry = createOpenTelemetry(brokenSources)
  let calls = 0
  const result = await telemetry.operations.run('reserve', async () => {
    calls += 1
    return 7
  })
  expect(result).toBe(7)
  expect(calls).toBe(1)
})

test('une panne de l’adaptateur ne masque pas l’erreur métier d’origine', async () => {
  const telemetry = createOpenTelemetry(brokenSources)
  const failure = new Error('métier')
  expect(
    telemetry.operations.run('reserve', async () => {
      throw failure
    }),
  ).rejects.toBe(failure)
})

test('métriques et logs ne lèvent jamais quand l’adaptateur est en panne', () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const { logger, metrics } = createOpenTelemetry(brokenSources)
  expect(() => {
    metrics.increment('events.commands')
    metrics.adjust('http.server.active_requests', 1)
    metrics.record('http.server.request.duration', 0.1)
    metrics.observe('outbox.pending', async () => 1)
    logger.info('info')
    logger.warn('warn')
    logger.error('error', new Error('cause'))
  }).not.toThrow()
  log.mockRestore()
})

test('sans SDK, les ports ne font rien et renvoient le résultat', async () => {
  expect(await noTelemetry.operations.run('op', async () => 3)).toBe(3)
  expect(noTelemetry.operations.carrier()).toEqual({})
})

test('deux appels à shutdown partagent la même promesse', async () => {
  const runtime = startTelemetry({
    serviceName: 'test',
    spanExporter: {
      export: (_batch, done) => done({ code: 0 }),
      shutdown: async () => {},
      forceFlush: async () => {},
    },
    metricExporter: {
      export: (_batch, done) => done({ code: 0 }),
      forceFlush: async () => {},
      shutdown: async () => {},
    },
    logExporter: {
      export: (_batch, done) => done({ code: 0 }),
      shutdown: async () => {},
      forceFlush: async () => {},
    },
  })
  const first = runtime.shutdown()
  expect(runtime.shutdown()).toBe(first)
  await first
})

test('shutdown respecte son délai même si l’exporteur reste bloqué', async () => {
  const runtime = startTelemetry({
    serviceName: 'test',
    shutdownTimeoutMs: 50,
    spanExporter: {
      export: (_batch, done) => done({ code: 0 }),
      shutdown: () => new Promise(() => {}),
      forceFlush: async () => {},
    },
    metricExporter: {
      export: (_batch, done) => done({ code: 0 }),
      forceFlush: async () => {},
      shutdown: async () => {},
    },
    logExporter: {
      export: (_batch, done) => done({ code: 0 }),
      shutdown: async () => {},
      forceFlush: async () => {},
    },
  })
  const startedAt = performance.now()
  await runtime.shutdown()
  expect(performance.now() - startedAt).toBeLessThan(2_000)
})
