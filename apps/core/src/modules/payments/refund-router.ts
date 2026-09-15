// Admin API `createRefund` (task 2.3, #126) as a mountable Express router — `POST
// /admin/stores/:storeId/orders/:orderId/refunds`. Permission is the operation's `x-permission` from
// admin-api.yaml (`support` on the store) through `requirePermission`, the body is validated against the spec,
// `Idempotency-Key` is required like the checkout's completion route. The spec's "`support` may refund up to
// the store's support_refund_limit_minor": callers who are not `store_admin` on the store (organization
// `owner` / `finance` reach every store through that relation) get `store.settings.support_refund_limit_minor`
// as a ceiling; a missing setting means no limit. Mounted by window 1 through `moduleAdminRouters()` in
// src/http/module-routers.ts (REQUEST #176 part 4) — after `adminRouter()`, so it has the staff principal, the
// JSON body parser and the error handler.
import { Router, type Request } from 'express';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { can, requirePermission, resolveObject } from '../../http/permissions';
import { uuidParam } from '../../http/query';
import { requirePrincipal, storeClientFor } from '../../http/staff-auth';
import { validationError } from '../../lib/errors';
import { createRefund, type RefundReason } from './refunds';

export const REFUNDS_PATH = '/admin/stores/:storeId/orders/:orderId/refunds';
const IDEMPOTENCY_HEADER = 'idempotency-key';
export const SUPPORT_REFUND_LIMIT_SETTING = 'support_refund_limit_minor';

function idempotencyKeyOf(req: Request): string {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!key || key.length < 8) {
    throw validationError('Idempotency-Key header is required', {
      'Idempotency-Key': 'required, at least 8 characters',
    });
  }
  return key;
}

/** `requirePermission` for the operation's `x-permission`; `{storeId}` in the object comes from the path. */
function permission(operationId: string) {
  const perm = loadSpec('admin-api.yaml').permission(operationId);
  return requirePermission(perm.relation, (req) =>
    resolveObject(perm.object, { storeId: uuidParam(req.params, 'storeId') }),
  );
}

interface CreateRefundBody {
  payment_id?: string;
  amount_minor: number;
  reason: RefundReason;
  return_id?: string;
}

export function paymentsAdminRouter(): Router {
  const router = Router();
  router.post(
    REFUNDS_PATH,
    permission('createRefund'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const storeId = uuidParam(req.params, 'storeId');
      const orderId = uuidParam(req.params, 'orderId');
      loadSpec('admin-api.yaml').validateBody('createRefund', req.body);
      const idempotencyKey = idempotencyKeyOf(req);
      const body = req.body as CreateRefundBody;
      const client = storeClientFor(p, storeId);

      // Support limit: store admins (and the organization roles that imply it) refund any amount.
      let limitMinor: number | null = null;
      if (!(await can(p, 'store_admin', `store:${storeId}`))) {
        const s = await client.query<{ settings: Record<string, unknown> | null }>(
          `SELECT settings FROM store WHERE id = $1`,
          [storeId],
        );
        const v = s.rows[0]?.settings?.[SUPPORT_REFUND_LIMIT_SETTING];
        limitMinor = typeof v === 'number' && Number.isFinite(v) ? v : null;
      }

      const { refund } = await createRefund(client, {
        orderId,
        paymentId: body.payment_id ?? null,
        amountMinor: body.amount_minor,
        reason: body.reason,
        returnId: body.return_id ?? null,
        idempotencyKey,
        actor: p.actor,
        requestedBy: p.user.id,
        limitMinor,
      });
      res.status(201).json(refund);
    }),
  );
  return router;
}
