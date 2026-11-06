import type { SQL } from 'bun'
import type { NotificationRepository } from '#/features/notifications/application/ports.ts'
import type {
  Notification,
  Recipient,
} from '#/features/notifications/domain/notification.ts'
import { Option } from '#/shared-kernel/option.ts'

const recipientColumns =
  'id, booking_user_ref AS "bookingUserRef", inbox_enabled AS "inboxEnabled"'
const notificationColumns = `id, recipient_id AS "recipientId", source_message_id AS "sourceMessageId",
  booking_ref AS "bookingRef", subject, body, created_at AS "createdAt", read_at AS "readAt"`

// All SQL stays in notifications.*. No joins or foreign keys to events.*.
export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly sql: SQL) {}

  async findRecipient(bookingUserRef: string) {
    const rows = await this.sql.unsafe<Recipient[]>(
      `SELECT ${recipientColumns} FROM notifications.recipients WHERE booking_user_ref = $1`,
      [bookingUserRef],
    )
    return Option.fromNullable(rows[0])
  }

  async setInboxEnabled(recipientId: string, enabled: boolean) {
    const rows = await this.sql.unsafe<Recipient[]>(
      `UPDATE notifications.recipients SET inbox_enabled = $2 WHERE id = $1 RETURNING ${recipientColumns}`,
      [recipientId, enabled],
    )
    if (!rows[0]) {
      throw new Error('Recipient not found')
    }
    return rows[0]
  }

  async recordOnce(
    messageId: string,
    recipientId: string,
    notification: Option<Notification>,
  ) {
    return this.sql.begin(async (tx) => {
      const inserted =
        await tx`INSERT INTO notifications.processed_messages (recipient_id, message_id)
        VALUES (${recipientId}, ${messageId}) ON CONFLICT DO NOTHING RETURNING message_id`
      if (!inserted.length) {
        return false
      }
      if (Option.isNone(notification)) {
        return true
      }
      const n = notification.value
      await tx`INSERT INTO notifications.inbox
        (id, recipient_id, source_message_id, booking_ref, subject, body, created_at)
        VALUES (${n.id}, ${n.recipientId}, ${n.sourceMessageId}, ${n.bookingRef}, ${n.subject}, ${n.body}, ${n.createdAt})`
      return true
    })
  }

  async list(recipientId: string) {
    return this.sql.unsafe<Notification[]>(
      `SELECT ${notificationColumns} FROM notifications.inbox WHERE recipient_id = $1 ORDER BY created_at, id`,
      [recipientId],
    )
  }

  async markRead(recipientId: string, notificationId: string, at: Date) {
    const rows = await this.sql.unsafe<Notification[]>(
      `UPDATE notifications.inbox SET read_at = COALESCE(read_at, $3)
       WHERE id = $1 AND recipient_id = $2 RETURNING ${notificationColumns}`,
      [notificationId, recipientId, at],
    )
    return Option.fromNullable(rows[0])
  }
}
