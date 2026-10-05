/**
 * The server-side permission check in front of every registry server action.
 *
 * A server action is a public POST endpoint: anything the browser can reach, a crafted request can
 * reach too, whatever the page offered. So each action loads the principal (`GET /admin/me`, the
 * Admin API's own answer from OpenFGA) and refuses — before calling the operation — unless it holds
 * the operation's `x-permission` (`REGISTRY_PERMISSIONS`). The Admin API checks again; this check
 * means a refused request never reaches it, and the refusal has the contract's own 403 shape.
 */

import 'server-only';

import { actionError, type ActionResult } from '../forms/action-result';
import { mapServerError } from '../forms/server-errors';
import { loadPrincipal } from '../principal';
import { REGISTRY_PERMISSIONS, mayPerform, permissionObject, type RegistryOperation } from '.';

const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Null when the principal may perform `operation` on `storeId`; otherwise the refusal to return. */
export async function refuseUnlessPermitted(
  operation: RegistryOperation,
  storeId: string,
): Promise<ActionResult<never> | null> {
  // A store-scoped operation names its store in the path: anything but a uuid never reaches
  // the principal check or the API (organization-scoped operations take no store id).
  if (REGISTRY_PERMISSIONS[operation].object === 'store' && !STORE_ID.test(storeId)) {
    return actionError({ fieldErrors: {}, formError: 'That store is not valid.' });
  }
  const principal = await loadPrincipal();
  if (!principal.ok) {
    // No principal, no mutation. A 401 is the ended session's panel; anything else is a message.
    const failure = { status: principal.status, error: principal.error };
    const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
    return actionError(mapServerError(failure), refusal);
  }
  if (mayPerform(principal.data, operation, storeId)) return null;

  // The contract's `Forbidden` body, as `requiresRelation` in the state panels builds it.
  const relation = REGISTRY_PERMISSIONS[operation].relation;
  const object = permissionObject(operation, storeId);
  const error = {
    code: 'forbidden',
    message: `requires ${relation} on ${object}`,
    details: { relation, object },
  };
  return actionError(mapServerError({ status: 403, error }), { status: 403, error });
}
