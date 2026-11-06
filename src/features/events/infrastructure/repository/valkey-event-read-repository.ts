import type { RedisClient } from 'bun'
import * as v from 'valibot'
import type {
  EventFilter,
  EventProjectionRepository,
} from '#/features/events/application/ports.ts'
import type { Event } from '#/features/events/domain/event.ts'
import type { EventId } from '#/features/events/domain/ids.ts'
import {
  eventToDomain,
  eventToEntity,
} from '#/features/events/infrastructure/event-entity.ts'
import { matchesEventFilter } from '#/features/events/infrastructure/repository/event-predicates.ts'
import { Option } from '#/shared-kernel/option.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'

const snapshot = v.pipe(
  v.string(),
  v.parseJson(),
  v.array(
    v.strictObject({
      id: v.string(),
      title: v.string(),
      category: v.string(),
      starts_at: v.pipe(v.string(), v.isoTimestamp(), v.toDate()),
      capacity: v.number(),
      venue_id: v.string(),
    }),
  ),
)

// A separate, disposable read model. SET replaces the snapshot atomically, so
// readers never observe a partially rebuilt projection. No booking writes here.
export class ValkeyEventReadRepository implements EventProjectionRepository {
  constructor(
    private readonly client: RedisClient,
    private readonly key = 'events:read-model:v1',
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  private observed<Value>(
    operation: 'GET' | 'SET',
    command: () => Promise<Value>,
  ): Promise<Value> {
    return this.telemetry.operations.run(`${operation} ${this.key}`, command, {
      kind: 'client',
      attributes: {
        'db.system.name': 'valkey',
        'db.operation.name': operation,
      },
    })
  }

  async replaceEvents(events: readonly Event[]): Promise<void> {
    await this.observed('SET', () =>
      this.client.set(this.key, JSON.stringify(events.map(eventToEntity))),
    )
  }

  async listEvents(filter: EventFilter) {
    return (await this.read())
      .filter(matchesEventFilter(filter))
      .sort(
        (a, b) =>
          a.data.startsAt.getTime() - b.data.startsAt.getTime() ||
          a.data.id.localeCompare(b.data.id),
      )
  }

  async findEvent(id: EventId) {
    return Option.fromNullable(
      (await this.read()).find(({ data }) => data.id === id),
    )
  }

  private async read(): Promise<Event[]> {
    const raw = await this.observed('GET', () => this.client.get(this.key))
    if (raw === null) {
      return []
    }
    return v.parse(snapshot, raw).map(eventToDomain)
  }
}
