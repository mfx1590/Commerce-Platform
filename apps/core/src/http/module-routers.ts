// Admin API routers other windows' modules export from their index.ts (hq-rbac lesson: a module is not done
// until something mounts it — this is the named mount point). Mounted by mountCoreMiddleware right after
// adminRouter(), so they get the same staff principal, JSON body parser and error handler, and their routes
// run the spec's x-permission through requirePermission themselves (each router reads it from loadSpec).
//
// Wiring batch (2.4): window 9's merchandising router (#162 part 3 / #179 part 2) and window 17's marketing
// router (#181 part 1). Still to mount as each export reaches main: window 9's `mediaRouter()` (#168) and the
// promotions `pricingRouter()` (#179 part 2) — add one `routers.push(...)` line each; window 7's
// `registerPaymentProviders()` (#176 part 1) is a boot-time call in src/server.ts, not a router.
import type { Router } from 'express';
import { marketingAdminRouter } from '../modules/marketing';
import {
  AlgoliaIndexClient,
  algoliaCredentialsFor,
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
  return routers;
}
