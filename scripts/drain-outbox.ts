import { startTelemetry } from '#/telemetry.ts'
import { tracedSql } from '#/platform/observability/traced-sql.ts'
import { RedisClient, SQL } from 'bun'
import { createContainer } from '#/composition-root.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import { PostgresEventRepository } from '#/features/events/infrastructure/repository/postgres-event-repository.ts'
import { PostgresEventsUnitOfWork } from '#/features/events/infrastructure/postgres-events-unit-of-work.ts'
import { PostgresOutboxStore } from '#/features/events/infrastructure/postgres-outbox-store.ts'
import { ValkeyEventReadRepository } from '#/features/events/infrastructure/repository/valkey-event-read-repository.ts'
import { PostgresNotificationRepository } from '#/features/notifications/infrastructure/postgres-notification-repository.ts'

const telemetryRuntime = startTelemetry()
const { telemetry } = telemetryRuntime
const client = new SQL(
  process.env.DATABASE_URL ?? 'postgres://events:events@localhost:55432/events',
)
const sql = tracedSql(client, telemetry)
const redis = new RedisClient(
  process.env.VALKEY_URL ?? 'redis://localhost:56379',
)
try {
  const container = createContainer({
    // No HTTP server or sessions are created by this script.
    applicationSecretKey: process.env.APPLICATION_SECRET_KEY ?? '',
    repository: new PostgresEventRepository(sql),
    unitOfWork: new PostgresEventsUnitOfWork(sql, telemetry),
    outboxStore: new PostgresOutboxStore(sql),
    readRepository: new ValkeyEventReadRepository(redis, undefined, telemetry),
    notificationRepository: new PostgresNotificationRepository(sql),
    telemetry,
  })
  console.log(
    `Delivered ${await container.resolve(TOKEN.OutboxDispatcher).drain(Number(process.argv[2] ?? 100))} messages`,
  )
} finally {
  redis.close()
  await client.close()
  await telemetryRuntime.shutdown()
}
