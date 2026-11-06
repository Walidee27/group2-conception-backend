import { context, metrics, propagation, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { startTelemetry } from '#/telemetry.ts'

const success = { code: ExportResultCode.SUCCESS }

function disableGlobals() {
  trace.disable()
  context.disable()
  propagation.disable()
  metrics.disable()
  logs.disable()
}

export function aTelemetryRuntime() {
  disableGlobals()
  const spans: ReadableSpan[] = []
  const records: ReadableLogRecord[] = []
  const collected: ResourceMetrics[] = []
  const runtime = startTelemetry({
    serviceName: 'events-api-test',
    metricIntervalMs: 60_000,
    spanExporter: {
      export(batch, done) {
        spans.push(...batch)
        done(success)
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    },
    logExporter: {
      export(batch, done) {
        records.push(...batch)
        done(success)
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    },
    metricExporter: {
      export(batch, done) {
        collected.push(batch)
        done(success)
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    },
  })
  return {
    ...runtime,
    spans,
    records,
    async finish() {
      await runtime.shutdown()
      disableGlobals()
    },
    metric(name: string) {
      return collected
        .flatMap(({ scopeMetrics }) => scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter(({ descriptor }) => descriptor.name === name)
    },
    span(name: string) {
      const found = spans.find((span) => span.name === name)
      if (!found) {
        throw new Error(
          `Span ${name} absent : ${spans.map((span) => span.name).join(', ')}`,
        )
      }
      return found
    },
  }
}
