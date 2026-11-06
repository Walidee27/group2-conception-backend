import { expect, test } from 'bun:test'
import { startOutboxPolling } from '#/features/events/application/outbox-poller.ts'
import { noTelemetry } from '#/shared-kernel/telemetry.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('la boucle relance la livraison après un échec', async () => {
  const warnings: string[] = []
  let calls = 0
  const stop = startOutboxPolling(
    {
      drain: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('Valkey indisponible')
        }
        return 0
      },
    },
    1,
    {
      ...noTelemetry,
      logger: { ...noTelemetry.logger, warn: (m) => warnings.push(m) },
    },
  )
  await wait(30)
  await stop()
  expect(calls).toBeGreaterThan(1)
  expect(warnings).toHaveLength(1)
})

test('stop attend la livraison en cours et ne relance plus rien', async () => {
  let calls = 0
  let finished = false
  const stop = startOutboxPolling(
    {
      drain: async () => {
        calls += 1
        await wait(20)
        finished = true
        return 0
      },
    },
    1,
  )
  await stop()
  expect(finished).toBe(true)
  const callsAtStop = calls
  await wait(20)
  expect(calls).toBe(callsAtStop)
})

test('stop rend la main même si une livraison reste bloquée', async () => {
  const stop = startOutboxPolling(
    { drain: () => new Promise<number>(() => {}) },
    1,
    noTelemetry,
    20,
  )
  const startedAt = performance.now()
  await stop()
  expect(performance.now() - startedAt).toBeLessThan(1_000)
})
