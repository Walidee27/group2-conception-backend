import { Option } from '#/shared-kernel/option.ts'
import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import * as v from 'valibot'
import { SessionService } from '#/features/identity/application/session-service.ts'
import { InMemoryIdentityRepository } from '#/features/identity/infrastructure/in-memory-identity-repository.ts'
import { sessionSchema } from '#/features/identity/routes/session-routes.ts'
import { given } from '../support/given.ts'

const alice = '01900000-0000-7000-8000-000000000001'
const unknownUser = '01900000-0000-7000-8000-000000000099'
const createdAt = new Date('2030-01-01T00:00:00Z')
const tokenPattern = /^[0-9a-f]{64}$/
const applicationSecretKey = 'test-application-secret-key-not-for-production'

function anIdentityApplication() {
  let now = createdAt
  const repository = new InMemoryIdentityRepository(new Set([alice]))
  const service = new SessionService(
    repository,
    applicationSecretKey,
    () => now,
  )
  return {
    repository,
    service,
    advanceTo(at: Date) {
      now = at
    },
  }
}

async function anExistingSession() {
  const fixture = anIdentityApplication()
  const session = v.parse(sessionSchema, await fixture.service.create(alice))
  return { ...fixture, session }
}

test('session creation rejects an unknown user', () =>
  given(anIdentityApplication)
    .when(({ service }) => service.create(unknownUser))
    .then((result) => {
      expect(result).toBeUndefined()
    }))

test('session creation issues an opaque bearer token valid for 24 hours', () =>
  given(anIdentityApplication)
    .when(({ service }) => service.create(alice))
    .then((result) => {
      expect(result).toEqual({
        token: expect.stringMatching(tokenPattern),
        tokenType: 'Bearer',
        expiresAt: '2030-01-02T00:00:00.000Z',
      })
    }))

test('each session creation issues a different token', () =>
  given(anExistingSession)
    .when(({ service }) => service.create(alice))
    .then((result, { session }) => {
      const second = v.parse(sessionSchema, result)
      expect(second.token).not.toBe(session.token)
    }))

test('session creation persists the HMAC-SHA-256 digest rather than the bearer token', () =>
  given(anIdentityApplication)
    .when(({ service }) => service.create(alice))
    .then(async (result, { repository }) => {
      const session = v.parse(sessionSchema, result)
      const tokenHash = createHmac('sha256', applicationSecretKey)
        .update(session.token)
        .digest('hex')
      expect(await repository.findSession(tokenHash, createdAt)).toEqual(
        Option.some({
          tokenHash,
          userId: alice,
          createdAt,
          expiresAt: new Date('2030-01-02T00:00:00Z'),
        }),
      )
      expect(await repository.findSession(session.token, createdAt)).toEqual(
        Option.none(),
      )
    }))

test('another service with the same application secret key can resolve a session', () =>
  given(anExistingSession)
    .when(({ repository, session }) =>
      new SessionService(
        repository,
        applicationSecretKey,
        () => createdAt,
      ).resolve(session.token),
    )
    .then((result) => {
      expect(result).toBe(alice)
    }))

test('another application secret key cannot resolve an existing session', () =>
  given(anExistingSession)
    .when(({ repository, session }) =>
      new SessionService(
        repository,
        'another-application-secret-key-for-testing',
        () => createdAt,
      ).resolve(session.token),
    )
    .then((result) => {
      expect(result).toBeUndefined()
    }))

test('another application secret key cannot revoke an existing session', () =>
  given(anExistingSession)
    .when(async ({ repository, service, session }) => {
      const peer = new SessionService(
        repository,
        'another-application-secret-key-for-testing',
        () => createdAt,
      )
      await peer.revoke(session.token)
      return service.resolve(session.token)
    })
    .then((result) => {
      expect(result).toBe(alice)
    }))

test('a valid session resolves to its user', () =>
  given(anExistingSession)
    .when(({ service, session }) => service.resolve(session.token))
    .then((result) => {
      expect(result).toBe(alice)
    }))

test.each([
  '',
  'bad',
  'a'.repeat(63),
  'a'.repeat(65),
  'A'.repeat(64),
  'g'.repeat(64),
  'a'.repeat(64),
])('an invalid or unknown token cannot resolve a user: %s', (token) =>
  given(anExistingSession)
    .when(({ service }) => service.resolve(token))
    .then((result) => {
      expect(result).toBeUndefined()
    }),
)

test.each([
  { at: new Date('2030-01-01T23:59:59.999Z'), expected: alice },
  { at: new Date('2030-01-02T00:00:00Z'), expected: undefined },
])('session resolution at the expiry boundary: $at', ({ at, expected }) =>
  given(async () => {
    const fixture = await anExistingSession()
    fixture.advanceTo(at)
    return fixture
  })
    .when(({ service, session }) => service.resolve(session.token))
    .then((result) => {
      expect(result).toBe(expected)
    }),
)

test('revoking a session prevents it from resolving a user', () =>
  given(anExistingSession)
    .when(async ({ service, session }) => {
      await service.revoke(session.token)
      return service.resolve(session.token)
    })
    .then((result) => {
      expect(result).toBeUndefined()
    }))

test('revoking one session leaves another session for the same user valid', () =>
  given(async () => {
    const fixture = await anExistingSession()
    const other = v.parse(sessionSchema, await fixture.service.create(alice))
    return { ...fixture, other }
  })
    .when(async ({ service, session, other }) => {
      await service.revoke(session.token)
      return service.resolve(other.token)
    })
    .then((result) => {
      expect(result).toBe(alice)
    }))
