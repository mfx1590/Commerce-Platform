// RED metrics and the SERVER span of every request (#729). Mounted first in mountCoreMiddleware, right after the
// request id, so the auth chain and every handler run inside the span's context. It reads the request and never
// writes the response (no header, no body change). Every series carries exactly four attributes:
//   http.route            the contract template (routes.ts) or `unmatched`, never a raw path
//   http.request.method   GET | POST | PUT | PATCH | DELETE, else `other`
//   http.status_class     1xx … 5xx
//   store_id              the store the publishable key resolved to (Store API); on the Admin API the `{storeId}`
//                         path parameter when it is a known store; `none` otherwise
// Instruments: http.server.request.duration (histogram, s), core.http.requests, core.http.errors (5xx only; a 4xx,
// a 429 included, is visible through http.status_class and is not an error). No ids, tokens, query strings or PII.
// An inbound traceparent is never honoured: the Store API is public, so a caller must not pick the trace id that
// reaches our outbox. Every trace is rooted here.
import {
  context,
  metrics,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';
import type { Request, RequestHandler } from 'express';
import { requestIdOf } from '../http/request-id';
import { coreTracer, REQUEST_ID_KEY, TRACER_NAME } from './context';
import type { KnownStores } from './known-stores';
import { UNMATCHED_ROUTE, type RouteMatch, type RouteMatcher } from './routes';
import { telemetryActive } from './sdk';

export const NO_STORE = 'none';

/**
 * Seconds: the semantic-conventions defaults plus 0.3 and 2. A latency SLO can only be read at a bucket boundary,
 * and window 5's Prometheus rules (docs/slo.md) use 0.5 s (store browse), 0.3 s (admin metrics API) and 2 s (checkout
 * complete). Pinned by telemetry.test.ts: do not drop a boundary without changing those rules.
 */
export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.3, 0.5, 0.75, 1, 2, 2.5, 5, 7.5, 10,
];

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface TelemetryMiddlewareOptions {
  routes: RouteMatcher;
  /** Admin `{storeId}` values allowed as a label (default: none, every admin request is `none`). */
  knownStores?: KnownStores;
  meter?: Meter;
  tracer?: Tracer;
}

function statusClass(status: number): string {
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
}

function storeLabel(req: Request, match: RouteMatch | undefined, known?: KnownStores): string {
  const tenant = req.tenant?.storeId;
  if (tenant) return tenant;
  const param = match?.params.storeId;
  return param && known?.has(param) ? param : NO_STORE;
}

/** A pass-through when telemetry is not active (tests, no endpoint): no span, no clock, no route matching. */
export function telemetryMiddleware(opts: TelemetryMiddlewareOptions): RequestHandler {
  if (!telemetryActive() && !opts.meter && !opts.tracer) return (_req, _res, next) => next();
  const meter = opts.meter ?? metrics.getMeter(TRACER_NAME);
  const tracer = opts.tracer ?? coreTracer();
  const duration = meter.createHistogram('http.server.request.duration', {
    description: 'Duration of HTTP server requests',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  const requests = meter.createCounter('core.http.requests', {
    description: 'HTTP requests answered by the core',
    unit: '{request}',
  });
  const errors = meter.createCounter('core.http.errors', {
    description: 'HTTP requests answered with a 5xx',
    unit: '{request}',
  });

  return (req, res, next) => {
    if (req.path === '/health') return next();
    const startedAt = performance.now();
    const path = req.path;
    const method = METHODS.has(req.method) ? req.method : 'other';
    const span = tracer.startSpan(
      method,
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': method } },
      ROOT_CONTEXT,
    );
    // The id requestIdOf keeps: a client's X-Request-Id only in the safe shape, a generated uuid otherwise (#740).
    // It reaches the span, the outbox envelope's trace.request_id and so the bus.
    const requestId = requestIdOf(req);
    const ctx = trace.setSpan(ROOT_CONTEXT, span).setValue(REQUEST_ID_KEY, requestId);

    let ended = false;
    // Runs from the response's finish/close listeners: a throw here would be an uncaught exception, so telemetry
    // failing never reaches the request or the process (#740 review); the span is ended either way.
    const end = (): void => {
      if (ended) return;
      ended = true;
      try {
        record();
      } catch {
        // metrics and span attributes are best effort
      } finally {
        try {
          span.end();
        } catch {
          // nothing left to do
        }
      }
    };
    const record = (): void => {
      const match = opts.routes.match(path);
      const status = res.statusCode;
      const attributes: Attributes = {
        'http.route': match?.template ?? UNMATCHED_ROUTE,
        'http.request.method': method,
        'http.status_class': statusClass(status),
        store_id: storeLabel(req, match, opts.knownStores),
      };
      duration.record((performance.now() - startedAt) / 1000, attributes);
      requests.add(1, attributes);
      if (status >= 500) errors.add(1, attributes);
      span.updateName(`${method} ${String(attributes['http.route'])}`);
      span.setAttributes({
        ...attributes,
        'http.response.status_code': status,
        'http.request.id': requestId,
        ...(res.writableFinished ? {} : { 'http.aborted': true }),
      });
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    };
    res.once('finish', end);
    res.once('close', end);
    // A body parser's stream callbacks keep this context without binding req/res (Node's AsyncLocalStorage follows
    // the request's async resource; telemetry.test.ts pins it with a body that arrives after the headers).
    context.with(ctx, next);
  };
}
