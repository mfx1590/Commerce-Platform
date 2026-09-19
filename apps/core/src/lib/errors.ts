import type { ErrorCode } from '@platform/contracts';

/**
 * Local mock until CONTRACT CHANGE #228 lands `price_changed` in `ERROR_CODES` (then this collapses back to
 * `ErrorCode`): completeCart answers 409 `price_changed` when a line's resolved price differs from the cart's.
 */
export type CoreErrorCode = ErrorCode | 'price_changed';

const STATUS: Record<CoreErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  out_of_stock: 409,
  cart_completed: 409,
  price_changed: 409,
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
    readonly code: CoreErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Overrides the status the code implies (503 `internal` when OpenFGA is unreachable, 502 for the proxy). */
    status?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status ?? STATUS[code];
  }

  toBody(): { code: CoreErrorCode; message: string; details?: Record<string, unknown> } {
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

/**
 * `@platform/auth-sdk` throws its own `ApiError` (`{ status, code, message, details }`, same contract codes).
 * Turned into an `AppError` so `coreErrorHandler` renders it — status kept as is (401, 403, 503 fail-closed),
 * empty details dropped. Anything else passes through unchanged.
 */
export function fromApiError(err: unknown): unknown {
  const e = err as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
  if (
    err instanceof Error &&
    typeof e.status === 'number' &&
    typeof e.code === 'string' &&
    e.code in STATUS
  ) {
    const details =
      e.details && typeof e.details === 'object' && Object.keys(e.details).length > 0
        ? (e.details as Record<string, unknown>)
        : undefined;
    return new AppError(e.code as ErrorCode, String(e.message), details, e.status);
  }
  return err;
}
