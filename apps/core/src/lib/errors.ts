import type { ErrorCode } from '@platform/contracts';

const STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  out_of_stock: 409,
  cart_completed: 409,
  payment_failed: 402,
  internal: 500,
};

/**
 * The one error type services throw and the HTTP layer renders as the contract's `Error` schema
 * `{ code, message, details }` with the matching status. Anything else that escapes is `internal`.
 */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }

  toBody(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export const notFound = (what: string, id?: string) =>
  new AppError('not_found', id ? `${what} ${id} not found` : `${what} not found`);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError('conflict', message, details);
export const forbidden = (message = 'forbidden') => new AppError('forbidden', message);
export const validationError = (message: string, details?: Record<string, unknown>) =>
  new AppError('validation_error', message, details);

/** Postgres unique_violation → 409 conflict; everything else passes through. */
export function mapPgError(err: unknown, what: string): never {
  const e = err as { code?: string; constraint?: string; detail?: string };
  if (e?.code === '23505') {
    throw conflict(`${what} already exists`, {
      constraint: e.constraint ?? null,
      detail: e.detail ?? null,
    });
  }
  if (e?.code === '23503') {
    throw validationError(`${what} references a row that does not exist`, {
      constraint: e.constraint ?? null,
      detail: e.detail ?? null,
    });
  }
  throw err;
}
