// Express request augmentation for what our middleware attaches. Medusa augments the same interface (scope,
// requestId, …); ours are optional fields so the two never conflict.
import type { StaffPrincipal } from './staff-auth';
import type { StoreContext } from './tenant';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Store API: resolved from `X-Publishable-Key` (src/http/tenant.ts). */
      tenant?: StoreContext;
      /** Admin API: resolved from the staff bearer token (src/http/staff-auth.ts). */
      principal?: StaffPrincipal;
    }
  }
}

export {};
