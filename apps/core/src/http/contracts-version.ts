import { CONTRACTS_VERSION } from '@platform/contracts';
import type { RequestHandler } from 'express';

export const CONTRACTS_VERSION_HEADER = 'X-Contracts-Version';

/**
 * Stamps the contracts version this core was built against on the response (#284): the admin app compares it
 * with its own and shows a non-blocking banner on a mismatch. Imported from `@platform/contracts`, never
 * hard-coded, so it moves with the contracts tag. Mounted ahead of the staff auth so every `/admin/*` answer
 * carries it, errors included (401, 403, 404, 503).
 */
export const contractsVersionHeader: RequestHandler = (_req, res, next) => {
  res.setHeader(CONTRACTS_VERSION_HEADER, CONTRACTS_VERSION);
  next();
};
