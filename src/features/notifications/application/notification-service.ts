import type { NotificationRepository } from '#/features/notifications/application/ports.ts'
import {
  composeNotification,
  type BookingNotice,
  type Notification,
  type Recipient,
} from '#/features/notifications/domain/notification.ts'
import { Option } from '#/shared-kernel/option.ts'
import { noTelemetry, type Telemetry } from '#/shared-kernel/telemetry.ts'

// No Events imports, entities, repositories or business rules.
export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly nextId: () => string,
    private readonly now: () => Date,
    private readonly telemetry: Telemetry = noTelemetry,
  ) {}

  async receive(notice: BookingNotice): Promise<void> {
    const recipient = await this.repository.findRecipient(notice.bookingUserRef)
    // Enrollment belongs to Notifications. A booking does not create a recipient.
    if (Option.isNone(recipient)) {
      this.count('unknown_recipient')
      return
    }
    const notification = this.notificationFor(notice, recipient.value)
    const recorded = await this.repository.recordOnce(
      notice.sourceMessageId,
      recipient.value.id,
      notification,
    )
    if (!recorded) {
      this.count('duplicate')
      return
    }
    this.count(Option.isSome(notification) ? 'delivered' : 'suppressed')
  }

  private count(outcome: string) {
    this.telemetry.metrics.increment('notifications.deliveries', { outcome })
  }

  recipient(bookingUserRef: string) {
    return this.repository.findRecipient(bookingUserRef)
  }

  preferences(recipientId: string, inboxEnabled: boolean) {
    return this.repository.setInboxEnabled(recipientId, inboxEnabled)
  }

  inbox(recipientId: string) {
    return this.repository.list(recipientId)
  }

  markRead(recipientId: string, notificationId: string) {
    return this.repository.markRead(recipientId, notificationId, this.now())
  }

  private notificationFor(
    notice: BookingNotice,
    recipient: Recipient,
  ): Option<Notification> {
    if (!recipient.inboxEnabled) {
      return Option.none()
    }
    return Option.some(composeNotification(notice, recipient, this.nextId()))
  }
}
