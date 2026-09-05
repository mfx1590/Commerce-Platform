import type { RequestHandler } from 'express';

/** Header the contract (packages/contracts, Store API) requires on every request. */
export const CONTRACT_PUBLISHABLE_KEY_HEADER = 'x-publishable-key';
/** Header Medusa's own publishable-key middleware reads on every `/store/*` route (no opt-out). */
export const MEDUSA_PUBLISHABLE_KEY_HEADER = 'x-publishable-api-key';

/**
 * Mounted on the Express app BEFORE Medusa's loaders (src/server.ts), so it runs ahead of Medusa's
 * `/store` publishable-key check. It copies the contract header to the name Medusa expects; the value is
 * validated against our `store_api_key` table by the tenant middleware (task 1.3) and against Medusa's
 * mirrored `api_key` rows by Medusa itself (task 1.8 keeps them in sync). Never overwrites a header the
 * client already sent.
 */
export const aliasPublishableKeyHeader: RequestHandler = (req, _res, next) => {
  const contractValue = req.headers[CONTRACT_PUBLISHABLE_KEY_HEADER];
  if (contractValue !== undefined && req.headers[MEDUSA_PUBLISHABLE_KEY_HEADER] === undefined) {
    req.headers[MEDUSA_PUBLISHABLE_KEY_HEADER] = contractValue;
  }
  next();
};
