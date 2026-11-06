import { expect, test } from 'bun:test'
import { anExistingEvent } from '../support/application-fixture.ts'
import { given } from '../support/given.ts'
import { TOKEN } from '#/platform/di/tokens.ts'
import { Result } from '#/shared-kernel/result.ts'

test('a reservation commits without contacting an unavailable bus', () =>
  given(async () => {
    const app = await anExistingEvent()
    app.container.resolve(TOKEN.EventBus).publish = async () => {
      throw new Error('bus unavailable')
    }
    return app
  })
    .when(({ services, event, alice }) =>
      services.reserve.execute({
        eventId: event.data.id,
        userId: alice,
        quantity: 1,
      }),
    )
    .then(async (result, { repository, alice, drain }) => {
      expect(Result.isSuccess(result)).toBe(true)
      expect(await repository.listReservations(alice)).toHaveLength(1)
      await expect(drain()).rejects.toThrow('bus unavailable')
    }))
