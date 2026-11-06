const baseUrl = 'http://127.0.0.1:3000'
const eventId = '01900000-0000-7000-8000-000000000004'
const userId = '01900000-0000-7000-8000-000000000001'
const venueId = '01900000-0000-7000-8000-000000000003'
const reservationId = '{{reservationId}}'

function request(name: string, method: string, path: string, body?: unknown) {
  return {
    name,
    request: {
      method,
      url: `${baseUrl}${path}`,
      header: [
        ...(body === undefined
          ? []
          : [{ key: 'Content-Type', value: 'application/json' }]),
        ...(path === '/user/auth' && method === 'POST'
          ? []
          : [{ key: 'Authorization', value: 'Bearer {{token}}' }]),
      ],
      ...(body === undefined
        ? {}
        : {
            body: {
              mode: 'raw',
              raw: JSON.stringify(body, null, 2),
              options: { raw: { language: 'json' } },
            },
          }),
    },
  }
}

const collection = {
  info: {
    name: 'Day 2: Events REST API',
    description:
      'Create a session first and copy its token into the token variable. Copy reservationId before cancelling.',
    schema:
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'reservationId', value: 'REPLACE_WITH_RESERVATION_ID' },
    { key: 'token', value: '' },
  ],
  item: [
    request('Create demo session', 'POST', '/user/auth', { userId }),
    request('Revoke current session', 'DELETE', '/user/auth'),
    request('List events', 'GET', '/events?category=gaming'),
    request('Create event', 'POST', '/events', {
      title: 'Game night',
      category: 'gaming',
      startsAt: '2099-06-15T18:00:00Z',
      capacity: 20,
      venueId,
    }),
    request('Read event', 'GET', `/events/${eventId}`),
    request('Update event', 'PATCH', `/events/${eventId}`, { capacity: 20 }),
    request(
      'Reserve seats as Alice',
      'POST',
      `/events/${eventId}/reservations`,
      { quantity: 2 },
    ),
    request('Read Alice reservations', 'GET', '/me/reservations'),
    request(
      'Cancel: replace reservationId first',
      'POST',
      `/reservations/${reservationId}/cancellation`,
    ),
    request(
      'Overbooking returns HTTP 409',
      'POST',
      `/events/${eventId}/reservations`,
      { quantity: 21 },
    ),
    request('Bad UUID returns HTTP 400', 'GET', '/events/invalid'),
  ],
}
await Bun.write(
  'demo/yaak.postman_collection.json',
  `${JSON.stringify(collection, null, 2)}\n`,
)
console.log('Generated demo/yaak.postman_collection.json')

export {}
