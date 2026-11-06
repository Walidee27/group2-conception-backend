import { Option } from '#/shared-kernel/option.ts'

export interface Session {
  tokenHash: string
  userId: string
  createdAt: Date
  expiresAt: Date
}

export interface IdentityRepository {
  userExists(id: string): Promise<boolean>
  createSession(session: Session): Promise<void>
  findSession(tokenHash: string, now: Date): Promise<Option<Session>>
  revokeSession(tokenHash: string, now: Date): Promise<void>
}
