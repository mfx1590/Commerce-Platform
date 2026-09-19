// Admin API routers other windows' modules export from their index.ts (hq-rbac lesson: a module is not done
// until something mounts it — this is the named mount point). Mounted by mountCoreMiddleware right after
// adminRouter(), so they get the same staff principal, JSON body parser and error handler, and their routes
// run the spec's x-permission through requirePermission themselves (each router reads it from loadSpec).
//
// Mounted here, one `routers.push(...)` line each — `moduleAdminRouters()`: window 9's `merchandisingRouter`
// (#162), `mediaRouter` (#168), `pricingRouter` (#137), `promotionsRouter` (#138 / #189); window 17's
// `marketingAdminRouter` (#181); window 8's `shippingAdminRouter` (#131); window 7's `paymentsAdminRouter`
// (#126). `moduleWebhookRouters()`: window 7's `paymentsWebhookRouter` (#125) and window 8's
// `shippingWebhookRouter` (#131). Nothing is pending. Boot-time registrations (payment providers, carrier rates,
// tax, price lists) are not routers: they live in src/wiring.ts (`registerModuleSeams()`).
import type { Router } from 'express';
import { marketingAdminRouter } from '../modules/marketing';
import { paymentsAdminRouter, paymentsWebhookRouter } from '../modules/payments';
import { pricingRouter, promotionsRouter } from '../modules/promotions';
import { shippingAdminRouter, shippingWebhookRouter } from '../modules/shipping';
import {
  AlgoliaIndexClient,
  algoliaCredentialsFor,
  mediaRouter,
  merchandisingRouter,
  PgRulesRepository,
  type IndexClient,
  type StoreIndexTarget,
} from '../modules/search';

/** A store's Algolia index backend from its per-store / global credentials, or null (publish → 409 in the router). */
export function searchIndexFor(store: StoreIndexTarget): IndexClient | null {
  const creds = algoliaCredentialsFor(store.code);
  return creds ? new AlgoliaIndexClient({ appId: creds.appId, apiKey: creds.apiKey }) : null;
}

export function moduleAdminRouters(): Router[] {
  const routers: Router[] = [];
  // window 9 — merchandising rules: /admin/stores/:storeId/merchandising/** (Admin API 0.4.0, #162)
  routers.push(
    merchandisingRouter({ repository: new PgRulesRepository(), indexFor: searchIndexFor }),
  );
  // window 17 — marketing: /admin/stores/:storeId/marketing/** (Admin API 0.3.0, #181)
  routers.push(marketingAdminRouter());
  // window 9 — product media: /admin/stores/:storeId/media/upload-params, …/products/:productId/media/** (#168)
  routers.push(mediaRouter());
  // window 9 — price lists: /admin/stores/:storeId/price-lists/** (#137)
  routers.push(pricingRouter());
  // window 9 — promotions and coupons: /admin/stores/:storeId/promotions/** (#138 / #189)
  routers.push(promotionsRouter());
  // window 8 — fulfilment: POST /admin/stores/:storeId/orders/:orderId/shipments, PATCH /admin/shipments/:id (#131)
  routers.push(shippingAdminRouter());
  // window 7 — refunds: POST /admin/stores/:storeId/orders/:orderId/refunds (Admin API createRefund, #126)
  routers.push(paymentsAdminRouter());
  return routers;
}

/**
 * Provider webhook routers: neither Store nor Admin API. No publishable key, no staff token — the provider's
 * signature over the RAW body is the authentication, so each router carries its own `express.raw()` parser and is
 * mounted OUTSIDE the `/store` and `/admin` chains (a body re-serialised by `express.json()` never matches a
 * signature) and before `coreErrorHandler`. Same opt-in rule as the admin routers: the server passes this list.
 */
export function moduleWebhookRouters(): Router[] {
  const routers: Router[] = [];
  // window 7 — Stripe: POST /webhooks/stripe/:storeCode (STRIPE_WEBHOOK_SECRET[_<CODE>], #125 / #176 part 3)
  routers.push(paymentsWebhookRouter());
  // window 8 — EasyPost tracking: POST /webhooks/easypost/:storeCode (EASYPOST_WEBHOOK_SECRET[_<CODE>], #131)
  routers.push(shippingWebhookRouter());
  return routers;
}
