/**
 * The contract between a server action and `useContractForm`.
 *
 * Server actions never throw at the form: a rejected save is data, the same way a 403 from the
 * Admin API is data (`src/lib/api/admin-client.ts`). The action does the mapping server-side so the
 * browser never has to know the Admin API's error shape.
 */

import type { ApiResult } from '../api/admin-client';
import { mapServerError, type FormErrors } from './server-errors';

export type ActionResult<T> = { status: 'success'; data: T } | ({ status: 'error' } & FormErrors);

export function actionSuccess<T>(data: T): ActionResult<T> {
  return { status: 'success', data };
}

export function actionError(errors: FormErrors): ActionResult<never> {
  return { status: 'error', ...errors };
}

/**
 * Wraps an Admin API call for a form. `knownFields` is what the form actually renders, so an error
 * naming anything else is raised to form level instead of vanishing onto an invisible input.
 */
export function toActionResult<T>(
  result: ApiResult<T>,
  knownFields: readonly string[],
): ActionResult<T> {
  if (result.ok) return actionSuccess(result.data);
  return actionError(mapServerError({ status: result.status, error: result.error }, knownFields));
}
