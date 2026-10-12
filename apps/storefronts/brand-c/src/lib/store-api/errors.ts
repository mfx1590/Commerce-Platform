import type { ErrorCode } from '@platform/contracts';
import type { ApiErrorBody } from './types';

/**
 * Every non-2xx answer from the Store API becomes one of these, with the machine-readable `code`
 * from the contract (`out_of_stock`, `payment_failed`, …) so pages can branch on it instead of
 * parsing messages. Checkout error mapping (task 1.4) depends on this.
 */
export class StoreApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(
    status: number,
    body: Partial<ApiErrorBody> | null,
    requestId: string | null = null,
    message?: string,
  ) {
    super(message ?? body?.message ?? `Store API request failed with status ${status}`);
    this.name = 'StoreApiError';
    this.status = status;
    this.code = body?.code ?? 'internal';
    this.details = (body?.details as Record<string, unknown> | undefined) ?? {};
    this.requestId = requestId;
  }

  is(code: ErrorCode | string): boolean {
    return this.code === code;
  }
}

export function isStoreApiError(error: unknown): error is StoreApiError {
  return error instanceof StoreApiError;
}

/** True when the resource simply is not in this store — pages turn this into `notFound()`. */
export function isNotFound(error: unknown): boolean {
  return isStoreApiError(error) && (error.status === 404 || error.code === 'not_found');
}
