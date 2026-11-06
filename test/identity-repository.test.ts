import { Option } from '#/shared-kernel/option.ts'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { Session } from '#/features/identity/application/ports.ts'
import { given } from './support/given.ts'
import {
  alice,
  bob,
  unknownUser,
  identityRepositoryFactories,
  type IdentityRepositoryFixture,
} from './support/identity-repository-fixtures.ts'

const createdAt = new Date('2030-01-01T00:00:00Z')
const expiresAt = new Date('2030-01-02T00:00:00Z')
const session: Session = {
  tokenHash: 'a'.repeat(64),
  userId: alice,
  createdAt,
  expiresAt,
}

describe.each(identityRepositoryFactories)(
  'IdentityRepository contract: $name',
  ({ create }) => {
    let fixture: IdentityRepositoryFixture
    beforeAll(async () => {
      fixture = await create()
    })
    beforeEach(async () => {
      await fixture.reset()
    })
    afterAll(async () => {
      await fixture?.close()
    })

    test.each([
      { userId: alice, exists: true },
      { userId: bob, exists: true },
      { userId: unknownUser, exists: false },
    ])('user existence: $userId → $exists', ({ userId, exists }) =>
      given(() => fixture)
        .when(({ repository }) => repository.userExists(userId))
        .then((result) => {
          expect(result).toBe(exists)
        }),
    )

    test('an unknown token has no session', () =>
      given(() => fixture)
        .when(({ repository }) =>
          repository.findSession(session.tokenHash, createdAt),
        )
        .then((result) => {
          expect(result).toEqual(Option.none())
        }))

    async function aStoredSession() {
      await fixture.repository.createSession(session)
      return fixture
    }

    test('a stored session is visible with all its data to another client', () =>
      given(aStoredSession)
        .when(({ peer }) => peer.findSession(session.tokenHash, createdAt))
        .then((result) => {
          expect(result).toEqual(Option.some(session))
        }))

    test.each([
      {
        at: new Date('2030-01-01T23:59:59.999Z'),
        expected: Option.some(session),
      },
      { at: expiresAt, expected: Option.none() },
      { at: new Date('2030-01-02T00:00:00.001Z'), expected: Option.none() },
    ])('expiration boundary at $at', ({ at, expected }) =>
      given(aStoredSession)
        .when(({ peer }) => peer.findSession(session.tokenHash, at))
        .then((result) => {
          expect(result).toEqual(expected)
        }),
    )

    test('revocation by another client makes a session unavailable', () =>
      given(aStoredSession)
        .when(async ({ repository, peer }) => {
          await peer.revokeSession(session.tokenHash, createdAt)
          return repository.findSession(session.tokenHash, createdAt)
        })
        .then((result) => {
          expect(result).toEqual(Option.none())
        }))

    test('revocation leaves another session valid', () =>
      given(async () => {
        await aStoredSession()
        const other = { ...session, tokenHash: 'b'.repeat(64), userId: bob }
        await fixture.repository.createSession(other)
        return { ...fixture, other }
      })
        .when(async ({ repository, peer, other }) => {
          await peer.revokeSession(session.tokenHash, createdAt)
          return repository.findSession(other.tokenHash, createdAt)
        })
        .then((result, { other }) => {
          expect(result).toEqual(Option.some(other))
        }))

    test('repeated revocation is harmless', () =>
      given(aStoredSession)
        .when(async ({ repository, peer }) => {
          await repository.revokeSession(session.tokenHash, createdAt)
          await peer.revokeSession(session.tokenHash, createdAt)
          return repository.findSession(session.tokenHash, createdAt)
        })
        .then((result) => {
          expect(result).toEqual(Option.none())
        }))

    test('revoking an unknown token is harmless', () =>
      given(aStoredSession)
        .when(async ({ repository, peer }) => {
          await peer.revokeSession('c'.repeat(64), createdAt)
          return repository.findSession(session.tokenHash, createdAt)
        })
        .then((result) => {
          expect(result).toEqual(Option.some(session))
        }))
  },
)
