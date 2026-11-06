import type { SQL } from 'bun'
import { Option } from '#/shared-kernel/option.ts'
import type { IdentityRepository, Session } from '../application/ports.ts'

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly sql: SQL) {}
  async userExists(id: string) {
    const [row] = await this.sql<
      { found: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM identity.users WHERE id = ${id}) AS found`

    return row?.found ?? false
  }
  async createSession(session: Session) {
    await this
      .sql`INSERT INTO identity.sessions (token_hash, user_id, created_at, expires_at)
      VALUES (${session.tokenHash}, ${session.userId}, ${session.createdAt}, ${session.expiresAt})`
  }
  async findSession(tokenHash: string, now: Date): Promise<Option<Session>> {
    const [row] = await this.sql<
      {
        token_hash: string
        user_id: string
        created_at: Date
        expires_at: Date
      }[]
    >`SELECT token_hash, user_id, created_at, expires_at FROM identity.sessions
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > ${now}`
    if (!row) {
      return Option.none()
    }
    return Option.some({
      tokenHash: row.token_hash,
      userId: row.user_id,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at),
    })
  }
  async revokeSession(tokenHash: string, now: Date) {
    await this
      .sql`UPDATE identity.sessions SET revoked_at = COALESCE(revoked_at, ${now}) WHERE token_hash = ${tokenHash}`
  }
}
