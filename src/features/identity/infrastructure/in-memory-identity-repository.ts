import type { IdentityRepository, Session } from '../application/ports.ts'
import { Option } from '#/shared-kernel/option.ts'
// import { setInterval } from 'node:timers';

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly sessions = new Map<string, Session>()
  constructor(
    private readonly users: ReadonlySet<string> = new Set([
      '01900000-0000-7000-8000-000000000001',
      '01900000-0000-7000-8000-000000000002',
    ]),
  ) {
    // setInterval(() => {
    //   const now = new Date()
    //   this.sessions.forEach((v, k) => {
    //     if (v.expiresAt > now) {
    //       this.sessions.delete(k)
    //     }
    //   })
    // }, 100_000)
  }
  async userExists(id: string) {
    return this.users.has(id)
  }
  async createSession(session: Session) {
    this.sessions.set(session.tokenHash, session)
  }
  async findSession(tokenHash: string, now: Date): Promise<Option<Session>> {
    const session = this.sessions.get(tokenHash)
    return session && session.expiresAt > now
      ? Option.some(session)
      : Option.none()
  }
  async revokeSession(tokenHash: string, _now: Date) {
    this.sessions.delete(tokenHash)
  }
}
