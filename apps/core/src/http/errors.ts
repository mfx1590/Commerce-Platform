import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../lib/errors';

/**
 * Renders errors as the contract's `Error` schema `{ code, message, details }`. Registered right after our
 * pre-Medusa middleware in src/server.ts (Express matches error handlers in registration order, so this one
 * catches what the tenant / staff middleware and our route wrapper raise). Unknown errors become 500 `internal`
 * and are logged without request bodies or headers (no PII).
 */
export const coreErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof AppError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  // body-parser (express.json) errors: malformed JSON, wrong charset, too large. They carry `expose: true` and
  // a 4xx status; rendered as the contract's validation_error instead of leaking as 500 `internal`.
  const parse = err as { type?: string; status?: number; expose?: boolean; message?: string };
  if (typeof parse?.type === 'string' && parse.type.startsWith('entity.') && parse.expose) {
    res.status(parse.status ?? 400).json({
      code: 'validation_error',
      message: 'invalid request body',
      details: { body: parse.type },
    });
    return;
  }
  console.error(`[core] unhandled error on ${req.method} ${req.path}:`, err);
  res.status(500).json({ code: 'internal', message: 'internal error' });
};

/**
 * Terminal handler for `/admin/*` (#265): a path none of our routers answered is the contract's 404, not
 * whatever Medusa's own admin auth makes of it (401 — which the admin app reads as "your session has ended").
 * src/server.ts mounts it after `mountCoreMiddleware` and before Medusa's loaders. Our staff auth has already
 * run, so a caller without a valid token got its 401 there and learns nothing about the route table; any
 * authenticated staff user gets the 404 — no permission is checked for a route that does not exist.
 */
export const adminNotFound: RequestHandler = (req, res) => {
  res.status(404).json({
    code: 'not_found',
    message: `${req.method} ${req.baseUrl}${req.path} is not implemented`,
    details: {},
  });
};

/**
 * Wraps an async handler so thrown `AppError`s (and anything else) reach `coreErrorHandler` instead of Medusa's
 * error handler. Our contract route files export `handle(async (req, res) => …)`.
 */
export function handle(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch((err) => coreErrorHandler(err, req, res, next));
  };
}
