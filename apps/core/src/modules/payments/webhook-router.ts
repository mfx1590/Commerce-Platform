// `POST /webhooks/stripe/:storeCode` as a mountable Express router (task 2.2, #125). No staff token, no
// publishable key: the Stripe signature over the RAW body is the authentication, checked before any database
// work by `handleStripeWebhook`. Mount point (REQUEST #176, window 1): `app.use(paymentsWebhookRouter())` in
// `mountCoreMiddleware`, before `coreErrorHandler` and OUTSIDE the `/store` and `/admin` chains — this path is
// neither. One Stripe endpoint per store: `https://<core>/webhooks/stripe/brand-a` signed with that store's
// `STRIPE_WEBHOOK_SECRET_BRAND_A` (else the global secret).
import express, { Router } from 'express';
import { handle } from '../../http/errors';
import { coreOrganizationId } from '../../http/tenant';
import { organizationClient, tenantClient } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { handleStripeWebhook } from './webhook-receiver';

export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe/:storeCode';
/** Stripe events are a few KB; anything larger is not a Stripe event. */
export const STRIPE_WEBHOOK_BODY_LIMIT = '512kb';

export interface PaymentsWebhookRouterOptions {
  env?: NodeJS.ProcessEnv;
  /** One line per delivery (ids only); default console.info. Tests pass a spy. */
  log?: (line: string) => void;
}

export function paymentsWebhookRouter(opts: PaymentsWebhookRouterOptions = {}): Router {
  const router = Router();
  router.post(
    STRIPE_WEBHOOK_PATH,
    // Raw bytes, whatever the declared content type: the signature is over the body Stripe sent.
    express.raw({ type: () => true, limit: STRIPE_WEBHOOK_BODY_LIMIT }),
    handle(async (req, res) => {
      const storeCode = String(req.params.storeCode ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeCode)) {
        throw new AppError('not_found', 'store not found');
      }
      const organizationId = coreOrganizationId();
      const org = organizationClient({ organizationId });
      const store = await org.query<{ id: string }>(`SELECT id FROM store WHERE code = $1`, [
        storeCode,
      ]);
      const storeId = store.rows[0]?.id;
      if (!storeId) throw new AppError('not_found', `store ${storeCode} not found`);
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = req.header('stripe-signature');
      const outcome = await handleStripeWebhook({
        client: tenantClient({ organizationId, storeIds: [storeId] }),
        storeCode,
        rawBody,
        signatureHeader: header,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
      // Stripe only needs a 2xx; the body is for operators reading the endpoint's delivery log.
      res.status(200).json(
        outcome.kind === 'duplicate'
          ? { received: true, event_id: outcome.eventId, duplicate: true, status: outcome.status }
          : {
              received: true,
              event_id: outcome.eventId,
              outcome: outcome.kind,
              reason: outcome.reason,
            },
      );
    }),
  );
  return router;
}
