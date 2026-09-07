import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** The request id: the client's `X-Request-Id` when present, otherwise generated here. Stable for the request. */
export function requestIdOf(req: Request): string {
  const v = req.headers[REQUEST_ID_HEADER];
  const id = Array.isArray(v) ? v[0] : v;
  if (id) return id;
  const generated = randomUUID();
  // Written back onto the request so Medusa's own request-id middleware (which reads the same header) reuses it.
  req.headers[REQUEST_ID_HEADER] = generated;
  return generated;
}

/** Ensures every request has an id and echoes it in the response (audit_log.request_id, event trace ids). */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  res.setHeader('X-Request-Id', requestIdOf(req));
  next();
};
