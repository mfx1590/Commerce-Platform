// What travels with a request through the OpenTelemetry context (#729): the SERVER span and the request id. Read
// by the outbox (the envelope's `trace` field) and by the database span. Without registered providers
// (`telemetryActive()` false) there is no context manager, the context is always ROOT and nothing here applies.
import {
  createContextKey,
  context,
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Tracer,
} from '@opentelemetry/api';

export const TRACER_NAME = '@platform/core';

export const REQUEST_ID_KEY = createContextKey('@platform/core request id');

export function coreTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** The envelope `trace` of the current request: its trace id and request id, or undefined outside any request. */
export function currentTraceFields():
  { trace_id: string | null; request_id: string | null } | undefined {
  const active = context.active();
  const spanContext = trace.getSpan(active)?.spanContext();
  const traceId = spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : null;
  const requestId = active.getValue(REQUEST_ID_KEY);
  if (traceId === null && typeof requestId !== 'string') return undefined;
  return { trace_id: traceId, request_id: typeof requestId === 'string' ? requestId : null };
}

/** The error's class for `error.type`: a SQLSTATE or the error name, never its message (which may carry values). */
function errorType(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  return (err as Error | null)?.name ?? 'Error';
}

/** Runs `fn` inside a child span of the active context; a throw marks the span ERROR with `error.type` only. */
export function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return coreTracer().startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', errorType(err));
      throw err;
    } finally {
      span.end();
    }
  });
}
