import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type TextMapGetter,
} from '@opentelemetry/api'
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { matchedRoutes } from 'hono/route'
import type { Metrics } from '#/shared-kernel/telemetry.ts'
import { errorType, safely } from './open-telemetry.ts'

const knownMethods = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
])
const headerGetter: TextMapGetter<Headers> = {
  keys: (headers) => [...headers.keys()],
  get: (headers, key) => headers.get(key) ?? undefined,
}

function routeOf(c: Context): string | undefined {
  return matchedRoutes(c).find(({ method }) => method !== 'ALL')?.path
}

function failureOf(c: Context): string | undefined {
  if (c.res.status < 500) {
    return undefined
  }
  return c.error ? errorType(c.error) : String(c.res.status)
}

export function observabilityMiddleware(metrics: Metrics) {
  return createMiddleware(async (c, next) => {
    const startedAt = performance.now()
    const method = knownMethods.has(c.req.method) ? c.req.method : '_OTHER'
    const spanMethod = method === '_OTHER' ? 'HTTP' : method
    const requestAttributes = {
      [ATTR_HTTP_REQUEST_METHOD]: method,
      [ATTR_URL_SCHEME]: new URL(c.req.url).protocol.replace(':', ''),
    }
    let active = ROOT_CONTEXT
    let span: Span | undefined
    safely(() => {
      active = propagation.extract(
        ROOT_CONTEXT,
        c.req.raw.headers,
        headerGetter,
      )
      span = trace.getTracer('events-api').startSpan(
        spanMethod,
        {
          kind: SpanKind.SERVER,
          attributes: { ...requestAttributes, [ATTR_URL_PATH]: c.req.path },
        },
        active,
      )
      active = trace.setSpan(active, span)
    })
    metrics.adjust('http.server.active_requests', 1, requestAttributes)
    try {
      await context.with(active, next)
    } finally {
      metrics.adjust('http.server.active_requests', -1, requestAttributes)
      const route = routeOf(c)
      const failure = failureOf(c)
      const responseAttributes = {
        ...requestAttributes,
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: c.res.status,
        ...(route ? { [ATTR_HTTP_ROUTE]: route } : {}),
        ...(failure ? { [ATTR_ERROR_TYPE]: failure } : {}),
      }
      metrics.record(
        'http.server.request.duration',
        (performance.now() - startedAt) / 1000,
        responseAttributes,
      )
      safely(() => {
        span?.setAttributes(responseAttributes)
        span?.updateName(route ? `${spanMethod} ${route}` : spanMethod)
        if (failure) {
          span?.setStatus({ code: SpanStatusCode.ERROR })
        }
        span?.end()
      })
    }
  })
}
