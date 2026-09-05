/**
 * Turning an Admin API refusal into something a form can show.
 *
 * The contract is explicit about the shape: `400 { code: validation_error, details: { field } }` and
 * `409 { code: conflict, details: { field } }` both name the offending field, so the message belongs
 * *under that input*, not in a banner the user has to map back to a control themselves.
 *
 * The rule for everything else is honesty: a field error is only attached when the form actually has
 * that field. A message pinned to an input nobody can see is a message nobody reads, so anything
 * unrecognised is raised to form level with its text intact.
 *
 * Pure: no React, no `next/*`.
 */

import type { AdminError } from '../api/admin-client';

export interface FormErrors {
  /** Keyed by React Hook Form field path. */
  fieldErrors: Readonly<Record<string, string>>;
  /** Shown above the form when no single input owns the problem. */
  formError: string | null;
}

export const NO_ERRORS: FormErrors = { fieldErrors: {}, formError: null };

function detailString(error: AdminError, key: string): string | null {
  const details = error.details as Record<string, unknown> | undefined;
  const value = details?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `options.0.name` belongs to the form when it owns `options` — the contract addresses nested input
 * by path, and RHF understands the same dotted notation.
 */
export function isKnownField(path: string, knownFields: readonly string[]): boolean {
  if (knownFields.includes(path)) return true;
  const root = path.split(/[.[]/)[0];
  return root !== undefined && root !== '' && knownFields.includes(root);
}

export function mapServerError(
  failure: { status: number; error: AdminError },
  knownFields: readonly string[] = [],
): FormErrors {
  const { status, error } = failure;
  const field = detailString(error, 'field');

  if ((status === 400 || status === 409) && field !== null) {
    if (isKnownField(field, knownFields)) {
      return { fieldErrors: { [field]: error.message }, formError: null };
    }
    // The server rejected something this form does not render. Say which field, or the user is
    // left staring at a form with no visible problem.
    return { fieldErrors: {}, formError: `${error.message} (field: ${field})` };
  }

  if (status === 403) {
    const relation = detailString(error, 'relation');
    const object = detailString(error, 'object');
    return {
      fieldErrors: {},
      formError:
        relation !== null && object !== null
          ? `You need the ${relation} relation on ${object} to save this.`
          : 'You do not have permission to save this.',
    };
  }

  if (status === 0) {
    return {
      fieldErrors: {},
      formError: 'Could not reach the Admin API. Check it is running, then try again.',
    };
  }

  return { fieldErrors: {}, formError: error.message };
}
