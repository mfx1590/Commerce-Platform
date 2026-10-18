// Admin API router of the customers module (#471): `listCustomerConsents`. Mounted through
// `src/http/module-routers.ts` with one `routers.push(customersAdminRouter())` line (REQUEST to window 1 — that
// file is theirs); the other Admin customer operations of #414 stay in `src/http/admin-routes.ts`. Same pattern as
// the marketing, shipping and cycle-count routers: the permission from the spec's `x-permission` with `{storeId}`
// from the path, the store-scoped client from the principal (403 outside their scope).
import { Router, type Request, type RequestHandler } from 'express';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject } from '../../http/permissions';
import { enumParam, one, throwIfProblems, uuidParam } from '../../http/query';
import { requirePrincipal, storeClientFor } from '../../http/staff-auth';
import { adminListCustomerConsents } from './consent';
import { CONSENT_PURPOSES } from './consent-ledger';

export const CUSTOMER_CONSENTS_PATH = '/admin/stores/:storeId/customers/:customerId/consents';

function permission(operationId: 'listCustomerConsents'): RequestHandler {
  const perm = loadSpec('admin-api.yaml').permission(operationId);
  return requirePermission(perm.relation, (req: Request) =>
    resolveObject(perm.object, { storeId: one(req.params.storeId) }),
  );
}

export function customersAdminRouter(): Router {
  const r = Router();
  r.get(
    CUSTOMER_CONSENTS_PATH,
    permission('listCustomerConsents'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const storeId = uuidParam(req.params, 'storeId');
      const customerId = uuidParam(req.params, 'customerId');
      const problems: Record<string, string> = {};
      const purpose = enumParam(req.query, 'purpose', CONSENT_PURPOSES, problems);
      throwIfProblems(problems);
      res.json({
        items: await adminListCustomerConsents(
          storeClientFor(p, storeId),
          storeId,
          customerId,
          purpose,
        ),
      });
    }),
  );
  return r;
}
