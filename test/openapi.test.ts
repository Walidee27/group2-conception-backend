import {
  authSchema,
  sessionSchema,
} from '#/features/identity/routes/session-routes.ts'
import { expect, test } from 'bun:test'
import { generateSpecs } from 'hono-openapi'
import * as v from 'valibot'
import { TOKEN } from '#/platform/di/tokens.ts'
import {
  eventResourceSchema,
  reservationResourceSchema,
} from '#/features/events/presentation/resources.ts'
import {
  createEventSchema,
  updateEventSchema,
  reservationSchema,
} from '#/features/events/validation.ts'
import { notificationDtoSchema } from '#/features/notifications/routes/documentation.ts'
import { preferencesSchema } from '#/features/notifications/validation.ts'
import { errorDtoSchema } from '#/platform/http/dtos.ts'
import { anApplication } from './support/application-fixture.ts'

function fixture() {
  return anApplication().container.resolve(TOKEN.App)
}

test('serves OpenAPI JSON and Scalar without requiring a demo identity', async () => {
  const app = fixture()
  const spec = await app.request('/openapi.json')
  expect(spec.status).toBe(200)
  expect(spec.headers.get('content-type')).toContain('application/json')
  const document = (await spec.json()) as any
  expect(document.openapi).toBe('3.1.0')
  expect(document.info.title).toBe('Events and notifications API')
  expect(document.components.securitySchemes.BearerSession).toMatchObject({
    type: 'http',
    scheme: 'bearer',
  })
  expect(document.paths['/docs']).toBeUndefined()
  expect(document.paths['/openapi.json']).toBeUndefined()
  // Notifications are mounted after createApp registers the documentation routes.
  expect(document.paths['/me/notifications'].get.operationId).toBe(
    'listMyNotifications',
  )

  const page = await app.request('/docs')
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toContain('text/html')
  expect(await page.text()).toContain('/openapi.json')
})

test('documents every operation with unique IDs, feature tags, examples and shared errors', async () => {
  const spec = await generateSpecs(fixture())
  const operations = Object.values(spec.paths).flatMap((path) =>
    [path?.get, path?.post, path?.patch, path?.delete].filter(
      (operation) => operation !== undefined,
    ),
  )
  expect(operations).toHaveLength(13)
  expect(
    new Set(operations.map((operation) => operation.operationId)).size,
  ).toBe(13)
  for (const operation of operations) {
    expect(operation.summary).toBeTruthy()
    expect(operation.tags).toHaveLength(1)
    expect(['Events', 'Reservations', 'Notifications', 'Identity']).toContain(
      operation.tags?.[0] ?? '',
    )
    expect(operation.responses?.['500']).toBeDefined()
    for (const response of Object.values(operation.responses ?? {})) {
      if ('$ref' in response) {
        throw new Error('Expected an inline response')
      }
      if (!response.content) {
        continue
      } // 204 responses have no body.
      const media = response.content?.['application/json']
      expect(media?.schema).toBeDefined()
      expect(media?.example ?? media?.examples).toBeDefined()
      expect(
        media?.example !== undefined && media?.examples !== undefined,
      ).toBe(false)
    }
  }
})

test('schemas preserve wire constraints and identity is only required on personal operations', async () => {
  const spec = await generateSpecs(fixture())
  const list = spec.paths['/events']?.get
  expect(list?.security).toEqual([{}, { BearerSession: [] }])
  expect(
    spec.paths['/events/{eventId}']?.get?.responses?.['200'],
  ).toMatchObject({
    content: {
      'application/json': {
        examples: {
          anonymous: { value: { _links: { self: { method: 'GET' } } } },
          authenticated: {
            value: {
              _links: {
                reserve: { method: 'POST' },
                reservations: { href: '/me/reservations' },
              },
            },
          },
        },
      },
    },
  })
  expect(list?.parameters).toMatchObject([
    {
      name: 'category',
      in: 'query',
      required: false,
      schema: { type: 'string' },
    },
    {
      name: 'after',
      in: 'query',
      required: false,
      schema: { type: 'string', format: 'date-time' },
    },
  ])
  const create = spec.paths['/events']?.post
  expect(create?.requestBody).toMatchObject({
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'category', 'startsAt', 'capacity', 'venueId'],
          properties: {
            startsAt: { type: 'string', format: 'date-time' },
            capacity: { type: 'integer', minimum: 1, maximum: 2147483647 },
            venueId: { type: 'string', pattern: expect.any(String) },
          },
        },
      },
    },
  })
  expect(create?.responses?.['201']).toMatchObject({
    headers: { Location: { schema: { type: 'string' } } },
  })
  const reserve = spec.paths['/events/{eventId}/reservations']?.post
  expect(reserve?.security).toEqual([{ BearerSession: [] }])
  expect(reserve?.parameters).toMatchObject([
    { name: 'eventId', in: 'path', required: true },
  ])
  for (const status of ['400', '401', '404', '409', '500']) {
    expect(reserve?.responses?.[status]).toBeDefined()
  }
})

test('all published request and response examples satisfy their Valibot contracts', async () => {
  const spec = await generateSpecs(fixture())
  const successSchemas: Record<string, v.GenericSchema> = {
    createSession: sessionSchema,
    listEvents: v.array(eventResourceSchema),
    createEvent: eventResourceSchema,
    getEvent: eventResourceSchema,
    updateEvent: eventResourceSchema,
    reserveEvent: reservationResourceSchema,
    cancelReservation: reservationResourceSchema,
    listMyReservations: v.array(reservationResourceSchema),
    listMyNotifications: v.array(notificationDtoSchema),
    getMyNotificationPreferences: preferencesSchema,
    updateMyNotificationPreferences: preferencesSchema,
    markMyNotificationRead: notificationDtoSchema,
  }
  const requestSchemas: Record<string, v.GenericSchema> = {
    createSession: authSchema,
    createEvent: createEventSchema,
    updateEvent: updateEventSchema,
    reserveEvent: reservationSchema,
    updateMyNotificationPreferences: preferencesSchema,
  }
  for (const path of Object.values(spec.paths)) {
    for (const operation of [
      path?.get,
      path?.post,
      path?.patch,
      path?.delete,
    ]) {
      if (!operation?.operationId) {
        continue
      }
      const body = operation.requestBody
      if (body && !('$ref' in body)) {
        const schema = requestSchemas[operation.operationId]
        if (!schema) {
          throw new Error(
            `Missing request contract for ${operation.operationId}`,
          )
        }
        v.parse(schema, body.content['application/json']?.example)
      }
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if ('$ref' in response) {
          throw new Error('Expected an inline response')
        }
        if (status === '204') {
          continue
        }
        const schema =
          Number(status) >= 400
            ? errorDtoSchema
            : successSchemas[operation.operationId]
        if (!schema) {
          throw new Error(
            `Missing response contract for ${operation.operationId}`,
          )
        }
        const media = response.content?.['application/json']
        if (media?.examples) {
          for (const example of Object.values(media.examples)) {
            if ('$ref' in example) {
              throw new Error('Expected an inline example')
            }
            v.parse(schema, example.value)
          }
        } else {
          v.parse(schema, media?.example)
        }
      }
    }
  }
})
