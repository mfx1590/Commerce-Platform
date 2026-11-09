import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * The only client request ids we keep (#740): letters, digits and `._:-`, 1–128 characters — a uuid, a ULID, a
 * proxy's id. Anything else (an e-mail, a control character, a longer string) is replaced, because the id travels
 * into the outbox envelope's `trace.request_id` (and so onto the bus, forever-retained topics included), into
 * `audit_log.request_id` and into the span attribute `http.request.id`.
 */
export const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The request id: the client's `X-Request-Id` when it has the safe shape, otherwise generated here (as if none was
 * sent). Stable for the request: the generated id is written back onto the request.
 */
export function requestIdOf(req: Request): string {
  const v = req.headers[REQUEST_ID_HEADER];
  const id = Array.isArray(v) ? v[0] : v;
  if (id && SAFE_REQUEST_ID.test(id)) return id;
  const generated = randomUUID();
  // Written back onto the request so Medusa's own request-id middleware (which reads the same header) reuses it.
  req.headers[REQUEST_ID_HEADER] = generated;
  return generated;
}

/** Ensures every request has an id and echoes the one actually used (audit_log.request_id, event trace ids). */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  res.setHeader('X-Request-Id', requestIdOf(req));
  next();
};
