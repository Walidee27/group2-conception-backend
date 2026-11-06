import { trace } from '@opentelemetry/api'
import type { SQL } from 'bun'
import type { Telemetry } from '#/shared-kernel/telemetry.ts'
import { errorType } from './open-telemetry.ts'

const operationPattern = /^\s*(SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\b/i
const collectionPattern = /\b(?:FROM|INTO|UPDATE)\s+([a-z_][\w.]*)/i

function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && 'raw' in value
}

function queryText(strings: TemplateStringsArray): string {
  return strings.reduce((text, part, index) => `${text}$${index}${part}`)
}

export function tracedSql(sql: SQL, telemetry: Telemetry): SQL {
  const observed = <Value>(text: string, execute: () => PromiseLike<Value>) => {
    // Sans parent, une requête de la boucle d'outbox créerait une trace par seconde.
    if (!trace.getActiveSpan()) {
      return execute()
    }
    const operation = text.match(operationPattern)?.[1]?.toUpperCase() ?? 'SQL'
    const collection = text.match(collectionPattern)?.[1]
    const collectionAttribute: Record<string, string> = collection
      ? { 'db.collection.name': collection }
      : {}
    const metricAttributes = {
      'db.system.name': 'postgresql',
      'db.operation.name': operation,
      ...collectionAttribute,
    }
    return telemetry.operations.run(
      collection ? `${operation} ${collection}` : operation,
      async () => {
        const startedAt = performance.now()
        const record = (failure?: unknown) =>
          telemetry.metrics.record(
            'db.client.operation.duration',
            (performance.now() - startedAt) / 1000,
            failure === undefined
              ? metricAttributes
              : { ...metricAttributes, 'error.type': errorType(failure) },
          )
        try {
          const value = await execute()
          record()
          return value
        } catch (error) {
          record(error)
          throw error
        }
      },
      {
        kind: 'client',
        attributes: {
          ...metricAttributes,
          'db.query.text': text.replace(/\s+/g, ' ').trim(),
        },
      },
    )
  }

  return new Proxy(sql, {
    apply(target, thisArgument, argumentsList: unknown[]) {
      const execute = () =>
        Reflect.apply(
          target as unknown as (...values: unknown[]) => PromiseLike<unknown>,
          thisArgument,
          argumentsList,
        )
      const [strings] = argumentsList
      return isTemplate(strings)
        ? observed(queryText(strings), execute)
        : execute()
    },
    get(target, property) {
      if (property === 'unsafe') {
        return (text: string, values?: unknown[]) =>
          observed(text, () => target.unsafe(text, values))
      }
      if (property === 'begin') {
        return (work: (tx: SQL) => Promise<unknown>) =>
          target.begin((tx) => work(tracedSql(tx, telemetry)))
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
