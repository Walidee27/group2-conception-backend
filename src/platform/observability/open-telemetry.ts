import {
  context,
  metrics as metricsApi,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Meter,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import {
  logs as logsApi,
  SeverityNumber,
  type Logger as OtelLogger,
} from '@opentelemetry/api-logs'
import {
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions'
import type {
  OperationKind,
  Telemetry,
  TelemetryAttributes,
} from '#/shared-kernel/telemetry.ts'

const scope = 'events-api'
const durationBoundaries = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]
const units: Record<string, string> = {
  'http.server.active_requests': '{request}',
  'outbox.pending': '{message}',
  'outbox.oldest_pending.age': 's',
  'process.memory.usage': 'By',
}
const spanKinds: Record<OperationKind, SpanKind> = {
  internal: SpanKind.INTERNAL,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
}

export interface TelemetrySources {
  tracer: () => Tracer
  meter: () => Meter
  logger: () => OtelLogger
}

const globalSources: TelemetrySources = {
  tracer: () => trace.getTracer(scope),
  meter: () => metricsApi.getMeter(scope),
  logger: () => logsApi.getLogger(scope),
}

// Une panne de télémétrie ne doit jamais changer le résultat métier.
export function safely(report: () => void): void {
  try {
    report()
  } catch {
    return
  }
}

export function errorType(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'unknown'
}

export function exceptionAttributes(error: unknown): TelemetryAttributes {
  if (!(error instanceof Error)) {
    return { [ATTR_EXCEPTION_TYPE]: errorType(error) }
  }
  return {
    [ATTR_EXCEPTION_TYPE]: errorType(error),
    [ATTR_EXCEPTION_MESSAGE]: error.message,
    ...(error.stack ? { [ATTR_EXCEPTION_STACKTRACE]: error.stack } : {}),
  }
}

export function createOpenTelemetry(
  sources: TelemetrySources = globalSources,
): Telemetry {
  const counters = new Map<string, ReturnType<Meter['createCounter']>>()
  const upDownCounters = new Map<
    string,
    ReturnType<Meter['createUpDownCounter']>
  >()
  const histograms = new Map<string, ReturnType<Meter['createHistogram']>>()

  const counter = (name: string) => {
    const known = counters.get(name)
    if (known) {
      return known
    }
    const created = sources.meter().createCounter(name)
    counters.set(name, created)
    return created
  }
  const upDownCounter = (name: string) => {
    const known = upDownCounters.get(name)
    if (known) {
      return known
    }
    const created = sources
      .meter()
      .createUpDownCounter(name, { unit: units[name] })
    upDownCounters.set(name, created)
    return created
  }
  const histogram = (name: string) => {
    const known = histograms.get(name)
    if (known) {
      return known
    }
    const created = sources.meter().createHistogram(name, {
      unit: 's',
      advice: { explicitBucketBoundaries: durationBoundaries },
    })
    histograms.set(name, created)
    return created
  }
  const emit = (
    severityNumber: SeverityNumber,
    severityText: string,
    body: string,
    attributes?: TelemetryAttributes,
  ) => {
    safely(() =>
      sources.logger().emit({ severityNumber, severityText, body, attributes }),
    )
  }

  return {
    logger: {
      info: (message, attributes) =>
        emit(SeverityNumber.INFO, 'INFO', message, attributes),
      warn: (message, attributes) =>
        emit(SeverityNumber.WARN, 'WARN', message, attributes),
      error: (message, cause, attributes) => {
        console.error(message, cause)
        emit(SeverityNumber.ERROR, 'ERROR', message, {
          ...attributes,
          ...(cause === undefined ? {} : exceptionAttributes(cause)),
        })
      },
    },
    metrics: {
      increment: (name, attributes) =>
        safely(() => counter(name).add(1, attributes)),
      adjust: (name, delta, attributes) =>
        safely(() => upDownCounter(name).add(delta, attributes)),
      record: (name, value, attributes) =>
        safely(() => histogram(name).record(value, attributes)),
      observe: (name, read) =>
        safely(() =>
          sources
            .meter()
            .createObservableGauge(name, { unit: units[name] })
            .addCallback(async (result) => {
              try {
                result.observe(await read())
              } catch {
                return
              }
            }),
        ),
    },
    operations: {
      async run(name, operation, options = {}) {
        let parent: Context = context.active()
        let active = parent
        let span: Span | undefined
        safely(() => {
          if (options.parent) {
            parent = propagation.extract(parent, options.parent)
            active = parent
          }
          span = sources.tracer().startSpan(
            name,
            {
              kind: spanKinds[options.kind ?? 'internal'],
              attributes: options.attributes,
            },
            parent,
          )
          active = trace.setSpan(parent, span)
        })
        try {
          return await context.with(active, operation)
        } catch (error) {
          safely(() => {
            span?.setStatus({ code: SpanStatusCode.ERROR })
            span?.setAttribute(ATTR_ERROR_TYPE, errorType(error))
          })
          throw error
        } finally {
          safely(() => span?.end())
        }
      },
      carrier() {
        const carrier: Record<string, string> = {}
        safely(() => propagation.inject(context.active(), carrier))
        return carrier
      },
    },
  }
}
