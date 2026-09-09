/**
 * The contract between a server action and `useContractForm`.
 *
 * Server actions never throw at the form: a rejected save is data, the same way a 403 from the
 * Admin API is data (`src/lib/api/admin-client.ts`). The action does the mapping server-side so the
 * browser never has to know the Admin API's error shape.
 */

import type { AdminError, ApiResult } from '../api/admin-client';
import { mapServerError, type FormErrors } from './server-errors';

/**
 * A refusal the *screen* should answer, not the form.
 *
 * A `400` names a field and belongs under that input. A `401` or `403` does not: the save was
 * refused because of who you are, and the only useful response is the panel that says which
 * relation you need or that your session ended. Carrying the raw status and error alongside the
 * form errors lets the caller render exactly the panel a page-level failure would render, so a
 * refusal looks the same whether it came from loading a screen or from pressing Save.
 */
export interface ActionRefusalInfo {
  status: number;
  error: AdminError;
}

export type ActionResult<T> =
  { status: 'success'; data: T } | ({ status: 'error'; refusal?: ActionRefusalInfo } & FormErrors);

export function actionSuccess<T>(data: T): ActionResult<T> {
  return { status: 'success', data };
}

export function actionError(errors: FormErrors, refusal?: ActionRefusalInfo): ActionResult<never> {
  return { status: 'error', ...errors, ...(refusal === undefined ? {} : { refusal }) };
}

/** 401 and 403 are about the principal; everything else is about the request. */
function isRefusal(status: number): boolean {
  return status === 401 || status === 403;
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

  const errors = mapServerError({ status: result.status, error: result.error }, knownFields);
  return actionError(
    errors,
    isRefusal(result.status) ? { status: result.status, error: result.error } : undefined,
  );
}
