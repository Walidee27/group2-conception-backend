// Delivery metadata is separate from the business fact carried by the envelope.
export interface EventEnvelope<Event> {
  readonly messageId: string
  readonly occurredAt: Date
  readonly version: 1
  readonly event: Event
  readonly traceContext?: Readonly<Record<string, string>>
}
