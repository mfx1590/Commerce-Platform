// The one way this module's Admin API routes check permissions: the operation's `x-permission` from
// admin-api.yaml, resolved against the path's `{storeId}`, through the HTTP layer's `requirePermission`
// (server-side, OpenFGA; UI gating is a convenience, not security). Shared by the refund route (2.3) and the
// capture route (#355) so neither can drift from the contract by hard-coding a relation.
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject } from '../../http/permissions';
import { uuidParam } from '../../http/query';

/** `requirePermission` for the operation's `x-permission`; `{storeId}` in the object comes from the path. */
export function permission(operationId: string) {
  const perm = loadSpec('admin-api.yaml').permission(operationId);
  return requirePermission(perm.relation, (req) =>
    resolveObject(perm.object, { storeId: uuidParam(req.params, 'storeId') }),
  );
}
