import { startTelemetry } from '#/telemetry.ts'
import * as v from 'valibot'
import { getConnInfo } from 'hono/bun'
import { Duration } from '#/shared-kernel/duration.ts'
import { tokenBucket } from '#/platform/rate-limit/domain/bucket-strategies.ts'
import {
  rateLimitByUserId,
  type RateLimitConfig,
} from '#/platform/rate-limit/http/rate-limit-middleware.ts'
import { PostgresIdentityRepository } from '#/features/identity/infrastructure/postgres-identity-repository.ts'
import { createContainer } from '#/composition-root.ts'
import { createPersistence } from '#/features/events/infrastructure/persistence.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import { RedisClient, SQL } from 'bun'
import { ValkeyEventReadRepository } from '#/features/events/infrastructure/repository/valkey-event-read-repository.ts'
import { PostgresNotificationRepository } from '#/features/notifications/infrastructure/postgres-notification-repository.ts'
import { tracedSql } from '#/platform/observability/traced-sql.ts'
import { startOutboxPolling } from '#/features/events/application/outbox-poller.ts'
import {
  observedStartup,
  watchFatalErrors,
} from '#/platform/observability/lifecycle.ts'

const telemetryRuntime = startTelemetry()
const { telemetry } = telemetryRuntime
watchFatalErrors(telemetry, telemetryRuntime.shutdown)
const applicationSecretKey = v.parse(
  v.pipe(
    v.string('APPLICATION_SECRET_KEY is required'),
    v.minLength(
      32,
      'APPLICATION_SECRET_KEY must contain at least 32 characters',
    ),
  ),
  process.env.APPLICATION_SECRET_KEY,
)

const persistence = createPersistence(
  process.env.EVENT_REPOSITORY ?? 'postgres',
  telemetry,
)
// Identity and Notifications share a connection but query separate schemas.
const notificationSql = tracedSql(
  new SQL(
    process.env.DATABASE_URL ??
      'postgres://events:events@localhost:55432/events',
  ),
  telemetry,
)
const readModelClient = new RedisClient(
  process.env.VALKEY_URL ?? 'redis://localhost:56379',
)
const readRepository = new ValkeyEventReadRepository(
  readModelClient,
  undefined,
  telemetry,
)
const rateLimitConfig: RateLimitConfig = {
  key: rateLimitByUserId((c) => getConnInfo(c).remote.address),
  bucket: tokenBucket(100, Duration.makeUnsafe(60_000)),
}
const container = createContainer({
  applicationSecretKey,
  rateLimitConfig,
  repository: persistence.repository,
  unitOfWork: persistence.unitOfWork,
  outboxStore: persistence.outboxStore,
  identityRepository: new PostgresIdentityRepository(notificationSql),
  readRepository,
  notificationRepository: new PostgresNotificationRepository(notificationSql),
  telemetry,
})
const { outboxStore } = persistence
telemetry.metrics.observe(
  'process.memory.usage',
  async () => process.memoryUsage().rss,
)
if (outboxStore) {
  telemetry.metrics.observe('outbox.pending', () => outboxStore.pendingCount())
  telemetry.metrics.observe('outbox.oldest_pending.age', () =>
    outboxStore.oldestPendingAge(),
  )
}
const app = container.resolve(TOKEN.App)
const { server, stopOutboxPolling } = await observedStartup(
  telemetry,
  async () => {
    // Load all stored events into the read model before accepting requests.
    await readRepository.replaceEvents(
      await persistence.repository.listEvents({}),
    )
    return {
      stopOutboxPolling: outboxStore
        ? startOutboxPolling(
            container.resolve(TOKEN.OutboxDispatcher),
            Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1_000),
            telemetry,
          )
        : async () => {},
      server: Bun.serve({
        hostname: '127.0.0.1',
        port: Number(process.env.PORT ?? 3000),
        fetch: app.fetch,
      }),
    }
  },
).catch(async () => {
  await telemetryRuntime.shutdown()
  process.exit(1)
})
console.log(`Events API listening on ${server.url}`)

async function shutdown(signal: string) {
  telemetry.logger.info('Arrêt de l’API', { signal })
  await server.stop()
  await stopOutboxPolling()
  container.resolve(TOKEN.NotificationSubscription)()
  container.resolve(TOKEN.EventReadModelSubscription)()
  readModelClient.close()
  await persistence.close()
  await notificationSql.close()
  await telemetryRuntime.shutdown()
  process.exit(0)
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
