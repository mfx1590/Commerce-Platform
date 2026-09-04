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
  console.error(`[core] unhandled error on ${req.method} ${req.path}:`, err);
  res.status(500).json({ code: 'internal', message: 'internal error' });
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
