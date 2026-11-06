import { PostgresEventsUnitOfWork } from './postgres-events-unit-of-work.ts'
import { PostgresOutboxStore } from './postgres-outbox-store.ts'
import { RedisClient, SQL } from 'bun'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import { tracedSql } from '#/platform/observability/traced-sql.ts'
import { PostgresEventRepository } from '#/features/events/infrastructure/repository/postgres-event-repository.ts'
import { ValkeyEventRepository } from '#/features/events/infrastructure/repository/valkey-event-repository.ts'
import { FunctionalValkeyEventRepository } from '#/features/events/infrastructure/repository/valkey-event-repository-functional.ts'
import { UserId, VenueId } from '#/features/events/domain/ids.ts'
import {
  createKyselyDatabase,
  KyselyEventRepository,
} from '#/features/events/infrastructure/repository/kysely-event-repository.ts'
import {
  createDrizzleDatabase,
  DrizzleEventRepository,
} from '#/features/events/infrastructure/repository/drizzle-event-repository.ts'

const isAcceptedBackend = (backend: string) =>
  backend !== 'postgres' &&
  backend !== 'kysely' &&
  backend !== 'drizzle' &&
  backend !== 'valkey' &&
  backend !== 'valkey-functional'

export function createPersistence(
  backend: string,
  telemetry: Telemetry = noTelemetry,
) {
  if (isAcceptedBackend(backend)) {
    throw new Error(
      'EVENT_REPOSITORY must be postgres, kysely, drizzle, valkey or valkey-functional',
    )
  }
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgres://events:events@localhost:55432/events'
  if (backend === 'kysely') {
    const db = createKyselyDatabase(databaseUrl)
    return {
      repository: new KyselyEventRepository(db),
      close: () => db.destroy(),
    }
  }
  if (backend === 'drizzle') {
    const { db, close } = createDrizzleDatabase(databaseUrl)
    return { repository: new DrizzleEventRepository(db), close }
  }
  if (backend === 'postgres') {
    const sql = tracedSql(new SQL(databaseUrl), telemetry)
    return {
      repository: new PostgresEventRepository(sql),
      unitOfWork: new PostgresEventsUnitOfWork(sql, telemetry),
      outboxStore: new PostgresOutboxStore(sql),
      close: () => sql.close(),
    }
  }
  const valkey = new RedisClient(
    process.env.VALKEY_URL ?? 'redis://localhost:56379',
  )
  const Repository =
    backend === 'valkey-functional'
      ? FunctionalValkeyEventRepository
      : ValkeyEventRepository
  return {
    repository: new Repository(valkey, {
      users: new Set([
        UserId.makeUnsafe('01900000-0000-7000-8000-000000000001'),
        UserId.makeUnsafe('01900000-0000-7000-8000-000000000002'),
      ]),
      venues: new Set([
        VenueId.makeUnsafe('01900000-0000-7000-8000-000000000003'),
      ]),
    }),
    close: () => valkey.close(),
  }
}
