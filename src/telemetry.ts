import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs'
import {
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  BatchSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import type { Telemetry } from '#/shared-kernel/telemetry.ts'
import {
  createOpenTelemetry,
  safely,
} from '#/platform/observability/open-telemetry.ts'

const defaultMetricIntervalMs = 10_000
const defaultShutdownTimeoutMs = 5_000

export interface TelemetryOptions {
  serviceName?: string
  serviceVersion?: string
  spanExporter?: SpanExporter
  metricExporter?: PushMetricExporter
  logExporter?: LogRecordExporter
  metricIntervalMs?: number
  shutdownTimeoutMs?: number
}

export interface TelemetryRuntime {
  telemetry: Telemetry
  shutdown(): Promise<void>
}

export function startTelemetry(
  options: TelemetryOptions = {},
): TelemetryRuntime {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]:
        options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'events-api',
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0',
    }),
    autoDetectResources: false,
    contextManager: new AsyncLocalStorageContextManager(),
    textMapPropagator: new W3CTraceContextPropagator(),
    spanProcessors: [
      new BatchSpanProcessor(options.spanExporter ?? new OTLPTraceExporter()),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: options.metricExporter ?? new OTLPMetricExporter(),
        exportIntervalMillis:
          options.metricIntervalMs ??
          Number(
            process.env.OTEL_METRIC_EXPORT_INTERVAL ?? defaultMetricIntervalMs,
          ),
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: options.logExporter ?? new OTLPLogExporter(),
      }),
    ],
  })
  safely(() => sdk.start())

  let stopping: Promise<void> | undefined
  return {
    telemetry: createOpenTelemetry(),
    shutdown() {
      stopping ??= stopWithin(
        () => sdk.shutdown(),
        options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs,
      )
      return stopping
    },
  }
}

async function stopWithin(
  stop: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([stop().catch(() => {}), deadline])
  } finally {
    clearTimeout(timer)
  }
}
