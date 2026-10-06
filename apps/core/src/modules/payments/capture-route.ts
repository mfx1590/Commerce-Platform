// Admin API `capturePayment` (Integration 2a, #355; Admin API 0.4.9 / contracts-v0.4.11):
// `POST /admin/stores/:storeId/orders/:orderId/payments/:paymentId/capture`. Permission is the operation's
// `x-permission` (`store_admin` on the store) through `requirePermission`; the store scope is the tenant client
// (RLS) plus the payment's `order_id` (a payment of another order of the same store is a 404, not a capture).
// The body is optional (`{ amount_minor }` = partial capture) and validated against the spec when present.
//
// Idempotency, per the contract: a second capture of a `captured` payment is 409 — never a second charge. The use
// case itself replays such a call as a no-op that still converges the order's `payment_status` (a crash between
// its two transactions is healed that way), so the route lets the replay run and THEN answers 409: the caller
// learns the payment is already captured, and the order is consistent either way.
import type { Router } from 'express';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { uuidParam } from '../../http/query';
import { requirePrincipal, storeClientFor } from '../../http/staff-auth';
import { conflict } from '../../lib/errors';
import { permission } from './admin-permission';
import { capturePayment, renderPayment, type CapturePaymentOptions } from './capture';

/** The Stripe seam of the route: injectable client factory / environment (tests); default = real client, process.env. */
export type CaptureRouteStripeOptions = Pick<CapturePaymentOptions, 'apiFactory' | 'env'>;

export const CAPTURE_PATH = '/admin/stores/:storeId/orders/:orderId/payments/:paymentId/capture';

interface CaptureBody {
  amount_minor?: number;
}

/** Adds the capture route to the module's admin router (`paymentsAdminRouter()`, mounted by window 1). */
export function mountCaptureRoute(router: Router, stripe: CaptureRouteStripeOptions = {}): void {
  router.post(
    CAPTURE_PATH,
    permission('capturePayment'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const storeId = uuidParam(req.params, 'storeId');
      const orderId = uuidParam(req.params, 'orderId');
      const paymentId = uuidParam(req.params, 'paymentId');
      // `requestBody.required: false`: no body (express.json leaves `{}`) means the whole authorisation.
      const body = (req.body ?? {}) as CaptureBody;
      loadSpec('admin-api.yaml').validateBody('capturePayment', body);
      const client = storeClientFor(p, storeId);

      const { payment, replayed } = await capturePayment(client, paymentId, {
        actor: p.actor,
        orderId,
        amountMinor: body.amount_minor ?? null,
        ...stripe,
      });
      if (replayed) {
        throw conflict('payment is already captured', {
          field: 'status',
          from: 'captured',
          to: 'captured',
          captured_at: payment.captured_at?.toISOString() ?? null,
        });
      }
      res.status(200).json(renderPayment(payment));
    }),
  );
}
