import type { NotificationRepository } from '#/features/notifications/application/ports.ts'
import type {
  Notification,
  Recipient,
} from '#/features/notifications/domain/notification.ts'
import { Option } from '#/shared-kernel/option.ts'

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly recipients = new Map<string, Recipient>()
  private readonly notifications = new Map<string, Notification>()
  private readonly processed = new Set<string>()

  constructor(recipients: readonly Recipient[] = []) {
    for (const recipient of recipients) {
      this.recipients.set(recipient.id, structuredClone(recipient))
    }
  }

  async findRecipient(bookingUserRef: string) {
    return Option.fromNullable(
      structuredClone(
        [...this.recipients.values()].find(
          (recipient) => recipient.bookingUserRef === bookingUserRef,
        ),
      ),
    )
  }

  async setInboxEnabled(recipientId: string, inboxEnabled: boolean) {
    const recipient = this.recipients.get(recipientId)
    if (!recipient) {
      throw new Error('Recipient not found')
    }
    const updated = { ...recipient, inboxEnabled }
    this.recipients.set(recipientId, updated)
    return structuredClone(updated)
  }

  async recordOnce(
    messageId: string,
    recipientId: string,
    notification: Option<Notification>,
  ) {
    const key = `${recipientId}:${messageId}`
    if (this.processed.has(key)) {
      return false
    }
    if (Option.isSome(notification)) {
      this.notifications.set(
        notification.value.id,
        structuredClone(notification.value),
      )
    }
    this.processed.add(key)
    return true
  }

  async list(recipientId: string) {
    return structuredClone(
      [...this.notifications.values()]
        .filter((notification) => notification.recipientId === recipientId)
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        ),
    )
  }

  async markRead(recipientId: string, notificationId: string, at: Date) {
    const notification = this.notifications.get(notificationId)
    if (!notification || notification.recipientId !== recipientId) {
      return Option.none<Notification>()
    }
    const updated = { ...notification, readAt: notification.readAt ?? at }
    this.notifications.set(notificationId, structuredClone(updated))
    return Option.some(structuredClone(updated))
  }
}
