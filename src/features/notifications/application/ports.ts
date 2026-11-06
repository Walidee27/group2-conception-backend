import type {
  Notification,
  Recipient,
} from '#/features/notifications/domain/notification.ts'
import type { Option } from '#/shared-kernel/option.ts'

export interface NotificationRepository {
  findRecipient(bookingUserRef: string): Promise<Option<Recipient>>
  setInboxEnabled(recipientId: string, enabled: boolean): Promise<Recipient>
  // Atomically records both delivered and suppressed messages. Replay must not
  // resurrect a message that was suppressed by the recipient's preferences.
  recordOnce(
    messageId: string,
    recipientId: string,
    notification: Option<Notification>,
  ): Promise<boolean>
  list(recipientId: string): Promise<Notification[]>
  markRead(
    recipientId: string,
    notificationId: string,
    at: Date,
  ): Promise<Option<Notification>>
}
