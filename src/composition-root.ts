import { InMemoryEventRepository } from '#/features/events/infrastructure/repository/in-memory-event-repository.ts'
import { OutboxDispatcher } from '#/features/events/application/outbox-dispatcher.ts'
import type { MiddlewareHandler } from 'hono'
import { Container } from '#/platform/di/container.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import { createApp } from '#/app.ts'
import { CreateEventUseCase } from '#/features/events/application/commands/create-event.ts'
import { UpdateEventUseCase } from '#/features/events/application/commands/update-event.ts'
import { ReserveEventUseCase } from '#/features/events/application/commands/reserve-event.ts'
import { CancelReservationUseCase } from '#/features/events/application/commands/cancel-reservation.ts'
import { ListEventsUseCase } from '#/features/events/application/queries/list-events.ts'
import { GetEventUseCase } from '#/features/events/application/queries/get-event.ts'
import { ListReservationsUseCase } from '#/features/events/application/queries/list-reservations.ts'
import { DemoIdentity } from '#/features/events/application/demo-identity.ts'
import type {
  Clock,
  EventsUnitOfWork,
  OutboxStore,
  EventRepository,
  EventProjectionRepository,
  IdGenerator,
} from '#/features/events/application/ports.ts'
import { createEventCommandController } from '#/features/events/controllers/commands/event-controller.ts'
import { createEventQueryController } from '#/features/events/controllers/queries/event-controller.ts'
import { SessionService } from '#/features/identity/application/session-service.ts'
import type { IdentityRepository } from '#/features/identity/application/ports.ts'
import { InMemoryIdentityRepository } from '#/features/identity/infrastructure/in-memory-identity-repository.ts'
import { sessionMiddleware } from '#/features/identity/routes/session-middleware.ts'
import { sessionRoutes } from '#/features/identity/routes/session-routes.ts'
import { makeId } from '#/features/events/domain/ids.ts'
import type { DomainEvent } from '#/features/events/contracts/events.ts'
import { NotificationService } from '#/features/notifications/application/notification-service.ts'
import type { NotificationRepository } from '#/features/notifications/application/ports.ts'
import {
  eventsSubscriber,
  type NotificationLogger,
} from '#/features/notifications/infrastructure/events-subscriber.ts'
import { InMemoryNotificationRepository } from '#/features/notifications/infrastructure/in-memory-notification-repository.ts'
import { createNotificationCommandController } from '#/features/notifications/controllers/commands/notification-controller.ts'
import { createNotificationQueryController } from '#/features/notifications/controllers/queries/notification-controller.ts'
import { createRecipientMiddleware } from '#/features/notifications/controllers/recipient.ts'
import { notificationRoutes } from '#/features/notifications/routes/notification-routes.ts'
import type { EventBus } from '#/shared-kernel/event-bus.ts'
import { InMemoryEventBus } from '#/platform/messaging/in-memory-event-bus.ts'
import { observabilityMiddleware } from '#/platform/observability/observability-middleware.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'
import { createEventsReadModelSubscriber } from '#/features/events/infrastructure/events-read-model-subscriber.ts'

import {
  rateLimitMiddleware,
  type RateLimitConfig,
} from '#/platform/rate-limit/http/rate-limit-middleware.ts'

export interface ContainerOptions {
  applicationSecretKey: string
  rateLimitConfig?: RateLimitConfig
  repository: EventRepository
  unitOfWork?: EventsUnitOfWork
  outboxStore?: OutboxStore
  identityRepository?: IdentityRepository
  readRepository?: EventProjectionRepository
  clock?: Clock
  ids?: IdGenerator
  eventBus?: EventBus<DomainEvent>
  notificationLogger?: NotificationLogger
  notificationRepository?: NotificationRepository
  telemetry?: Telemetry
}

// Only the composition root resolves tokens. Application code receives ordinary dependencies.
export function createContainer(options: ContainerOptions): Container {
  const container = new Container()
  const telemetry = options.telemetry ?? noTelemetry
  container
    .singleton(TOKEN.EventRepository, () => options.repository)
    .singleton(TOKEN.EventsUnitOfWork, () => {
      if (options.unitOfWork) {
        return options.unitOfWork
      }
      if (options.repository instanceof InMemoryEventRepository) {
        return options.repository
      }
      throw new Error(
        'This command requires an EventsUnitOfWork; use the postgres adapter',
      )
    })
    .singleton(TOKEN.OutboxDispatcher, (c) => {
      const store =
        options.outboxStore ??
        (options.repository instanceof InMemoryEventRepository
          ? options.repository
          : undefined)
      if (!store) {
        throw new Error('An OutboxStore is required')
      }
      return new OutboxDispatcher(
        store,
        c.resolve(TOKEN.EventBus),
        telemetry,
        () => c.resolve(TOKEN.Clock).now(),
      )
    })
    .singleton(
      TOKEN.SessionService,
      (c) =>
        new SessionService(
          options.identityRepository ?? new InMemoryIdentityRepository(),
          options.applicationSecretKey,
          () => c.resolve(TOKEN.Clock).now(),
        ),
    )
    .singleton(
      TOKEN.EventReadRepository,
      () => options.readRepository ?? options.repository,
    )
    .singleton(TOKEN.EventReadModelSubscription, (c) => {
      if (!options.readRepository) {
        return () => {}
      }
      return createEventsReadModelSubscriber(
        options.repository,
        options.readRepository,
        telemetry,
      ).subscribe(c.resolve(TOKEN.EventBus))
    })
    .singleton(TOKEN.Clock, () => options.clock ?? { now: () => new Date() })
    .singleton(TOKEN.IdGenerator, () => options.ids ?? { next: makeId })
    .singleton(
      TOKEN.EventBus,
      () => options.eventBus ?? new InMemoryEventBus<DomainEvent>(true),
    )
    .singleton(
      TOKEN.NotificationRepository,
      () =>
        options.notificationRepository ?? new InMemoryNotificationRepository(),
    )
    .singleton(
      TOKEN.NotificationService,
      (c) =>
        new NotificationService(
          c.resolve(TOKEN.NotificationRepository),
          () => c.resolve(TOKEN.IdGenerator).next<string>(),
          () => c.resolve(TOKEN.Clock).now(),
          telemetry,
        ),
    )
    .singleton(TOKEN.NotificationSubscription, (c) => {
      const notifications = c.resolve(TOKEN.NotificationService)
      const bus = c.resolve(TOKEN.EventBus)
      const listener = eventsSubscriber(
        notifications,
        options.notificationLogger ?? {
          log: (message, envelope) =>
            telemetry.logger.info(message, {
              'messaging.message.id': envelope.messageId,
            }),
        },
      )
      const unsubscribe = [
        bus.subscribe('EventCreated', listener),
        bus.subscribe('EventUpdated', listener),
        bus.subscribe('EventReserved', listener),
        bus.subscribe('ReservationCancelled', listener),
      ]
      return () => {
        for (const stop of unsubscribe) {
          stop()
        }
      }
    })
    .singleton(
      TOKEN.Identity,
      (c) => new DemoIdentity(c.resolve(TOKEN.EventRepository)),
    )
    .singleton(
      TOKEN.CreateEventUseCase,
      (c) =>
        new CreateEventUseCase(
          c.resolve(TOKEN.EventsUnitOfWork),
          c.resolve(TOKEN.Clock),
          c.resolve(TOKEN.IdGenerator),
          telemetry,
        ),
    )
    .singleton(
      TOKEN.UpdateEventUseCase,
      (c) =>
        new UpdateEventUseCase(
          c.resolve(TOKEN.EventsUnitOfWork),
          c.resolve(TOKEN.Clock),
          c.resolve(TOKEN.IdGenerator),
          telemetry,
        ),
    )
    .singleton(
      TOKEN.ReserveEventUseCase,
      (c) =>
        new ReserveEventUseCase(
          c.resolve(TOKEN.EventsUnitOfWork),
          c.resolve(TOKEN.Clock),
          c.resolve(TOKEN.IdGenerator),
          telemetry,
        ),
    )
    .singleton(
      TOKEN.CancelReservationUseCase,
      (c) =>
        new CancelReservationUseCase(
          c.resolve(TOKEN.EventsUnitOfWork),
          c.resolve(TOKEN.Clock),
          c.resolve(TOKEN.IdGenerator),
          telemetry,
        ),
    )
    .singleton(
      TOKEN.ListEventsUseCase,
      (c) => new ListEventsUseCase(c.resolve(TOKEN.EventReadRepository)),
    )
    .singleton(
      TOKEN.GetEventUseCase,
      (c) => new GetEventUseCase(c.resolve(TOKEN.EventReadRepository)),
    )
    .singleton(
      TOKEN.ListReservationsUseCase,
      (c) => new ListReservationsUseCase(c.resolve(TOKEN.EventRepository)),
    )
    .singleton(TOKEN.EventCommandController, (c) =>
      createEventCommandController({
        identity: c.resolve(TOKEN.Identity),
        clock: c.resolve(TOKEN.Clock),
        create: c.resolve(TOKEN.CreateEventUseCase),
        update: c.resolve(TOKEN.UpdateEventUseCase),
        reserve: c.resolve(TOKEN.ReserveEventUseCase),
        cancel: c.resolve(TOKEN.CancelReservationUseCase),
      }),
    )
    .singleton(TOKEN.EventQueryController, (c) =>
      createEventQueryController({
        identity: c.resolve(TOKEN.Identity),
        clock: c.resolve(TOKEN.Clock),
        list: c.resolve(TOKEN.ListEventsUseCase),
        get: c.resolve(TOKEN.GetEventUseCase),
        reservationsFor: c.resolve(TOKEN.ListReservationsUseCase),
      }),
    )
    .singleton(TOKEN.NotificationCommandController, (c) =>
      createNotificationCommandController(c.resolve(TOKEN.NotificationService)),
    )
    .singleton(TOKEN.NotificationQueryController, (c) =>
      createNotificationQueryController(c.resolve(TOKEN.NotificationService)),
    )
    .singleton(TOKEN.App, (c) => {
      const middlewares: MiddlewareHandler[] = []
      if (options.rateLimitConfig) {
        const clock = c.resolve(TOKEN.Clock)
        const rateLimit = rateLimitMiddleware(options.rateLimitConfig, () =>
          clock.now(),
        )
        middlewares.push(rateLimit)
      }
      const app = createApp(
        c.resolve(TOKEN.EventCommandController),
        c.resolve(TOKEN.EventQueryController),
        observabilityMiddleware(telemetry.metrics),
        (error) =>
          telemetry.logger.error(
            'Erreur inattendue pendant une requête HTTP',
            error,
          ),
        sessionMiddleware(c.resolve(TOKEN.SessionService)),
        ...middlewares,
      )
      sessionRoutes(app, c.resolve(TOKEN.SessionService))
      notificationRoutes(
        app,
        c.resolve(TOKEN.NotificationCommandController),
        c.resolve(TOKEN.NotificationQueryController),
        createRecipientMiddleware(c.resolve(TOKEN.NotificationService)),
      )
      return app
    })

  // Subscribe once even when callers resolve a use case without resolving the HTTP app.
  container.resolve(TOKEN.NotificationSubscription)
  container.resolve(TOKEN.EventReadModelSubscription)
  return container
}
