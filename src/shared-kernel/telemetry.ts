export type TelemetryAttributes = Readonly<
  Record<string, string | number | boolean>
>
export type TraceCarrier = Readonly<Record<string, string>>

export interface Logger {
  info(message: string, attributes?: TelemetryAttributes): void
  warn(message: string, attributes?: TelemetryAttributes): void
  error(
    message: string,
    cause?: unknown,
    attributes?: TelemetryAttributes,
  ): void
}

export interface Metrics {
  increment(name: string, attributes?: TelemetryAttributes): void
  adjust(name: string, delta: number, attributes?: TelemetryAttributes): void
  record(name: string, value: number, attributes?: TelemetryAttributes): void
  observe(name: string, read: () => Promise<number>): void
}

export type OperationKind = 'internal' | 'client' | 'producer' | 'consumer'

export interface OperationOptions {
  kind?: OperationKind
  attributes?: TelemetryAttributes
  parent?: TraceCarrier
}

export interface OperationRunner {
  run<Value>(
    name: string,
    operation: () => Promise<Value>,
    options?: OperationOptions,
  ): Promise<Value>
  carrier(): TraceCarrier
}

export interface Telemetry {
  logger: Logger
  metrics: Metrics
  operations: OperationRunner
}

export const noTelemetry: Telemetry = {
  logger: {
    info: () => {},
    warn: () => {},
    error: (message, cause) => console.error(message, cause),
  },
  metrics: {
    increment: () => {},
    adjust: () => {},
    record: () => {},
    observe: () => {},
  },
  operations: {
    run: (_name, operation) => operation(),
    carrier: () => ({}),
  },
}
