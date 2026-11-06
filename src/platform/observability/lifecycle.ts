import type { Telemetry } from '#/shared-kernel/telemetry.ts'

export async function observedStartup<Value>(
  telemetry: Telemetry,
  start: () => Promise<Value>,
): Promise<Value> {
  const startedAt = performance.now()
  const elapsed = () => (performance.now() - startedAt) / 1000
  try {
    const value = await telemetry.operations.run('api.startup', start)
    telemetry.metrics.record('api.startup.duration', elapsed(), {
      outcome: 'success',
    })
    telemetry.logger.info('API démarrée')
    return value
  } catch (error) {
    telemetry.metrics.record('api.startup.duration', elapsed(), {
      outcome: 'failed',
    })
    telemetry.logger.error('Échec du démarrage de l’API', error)
    throw error
  }
}

export function watchFatalErrors(
  telemetry: Telemetry,
  stop: () => Promise<void>,
): void {
  const fatal = async (error: unknown) => {
    telemetry.logger.error('Erreur fatale, arrêt de l’API', error)
    await stop()
    process.exit(1)
  }
  process.once('uncaughtException', fatal)
  process.once('unhandledRejection', fatal)
}
