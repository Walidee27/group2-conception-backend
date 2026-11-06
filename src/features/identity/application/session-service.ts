import { createHmac, randomBytes } from 'node:crypto'
import type { IdentityRepository } from './ports.ts'
import { Option } from '#/shared-kernel/option.ts'

const lifetimeMs = 24 * 60 * 60 * 1000
const tokenPattern = /^[0-9a-f]{64}$/

// Anyone who knows an existing user ID can log in. This demo does not verify identity.
export class SessionService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly applicationSecretKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(userId: string) {
    if (!(await this.repository.userExists(userId))) {
      return undefined
    }
    const token = randomBytes(32).toString('hex')
    const createdAt = this.now()
    const expiresAt = new Date(createdAt.getTime() + lifetimeMs)
    await this.repository.createSession({
      tokenHash: this.hash(token),
      userId,
      createdAt,
      expiresAt,
    })
    return {
      token,
      tokenType: 'Bearer' as const,
      expiresAt: expiresAt.toISOString(),
    }
  }

  async resolve(token: string) {
    if (!tokenPattern.test(token)) {
      return undefined
    }
    const session = await this.repository.findSession(
      this.hash(token),
      this.now(),
    )
    if (Option.isSome(session)) {
      return session.value.userId
    }
  }

  async revoke(token: string) {
    await this.repository.revokeSession(this.hash(token), this.now())
  }

  private hash(token: string) {
    return createHmac('sha256', this.applicationSecretKey)
      .update(token)
      .digest('hex')
  }
}
