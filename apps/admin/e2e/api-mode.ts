/**
 * The one place the journeys differ between Prism and the real core (#118).
 *
 * `pnpm --filter @platform/admin e2e` runs against Prism and asserts the spec's examples exactly.
 * `E2E_API=core` runs the same journeys against the core: the assertions there are about shape
 * and behaviour (a pill, a price, "asks first", "shown once"), because the data is whatever the
 * shared local database holds. Two rules for core mode:
 *
 * - **Everything a journey creates is stamped** (`stamped()`), so reruns never collide with rows an
 *   earlier run left behind — the database is shared and never reset between runs.
 * - **Nothing irreversible is confirmed** on seeded data: a refund goes as far as the question
 *   and is cancelled; a status change is not saved.
 */

export const AGAINST_CORE = process.env.E2E_API === 'core';

const RUN = Date.now().toString(36);

/** `e2e-tee` → `e2e-tee-<run>` against the core; unchanged against Prism (its examples are fixed). */
export function stamped(value: string, separator = '-'): string {
  return AGAINST_CORE ? `${value}${separator}${RUN}` : value;
}

/** What each API is known to hold for brand-a and the seeded store-admin. */
export const EXPECT = AGAINST_CORE
  ? {
      /** `display_name` from the core's `/admin/me` (the DB seed). */
      displayName: 'Sam StoreAdmin',
      primaryDomain: 'shop.brand-a.local',
      /** The core does not mount this yet; the screen shows the not-implemented panel. */
      customersRoute: 'GET /admin/stores/{id}/customers',
      keyPattern: /^pk_[a-z0-9_-]{8,}$/i,
    }
  : {
      /** Prism's `/admin/me` example — deliberately not the token's `name` claim. */
      displayName: 'Store Admin',
      primaryDomain: 'shop.brand-a.example',
      customersRoute: null,
      keyPattern: /^pk_branda_mock_0000000000000000$/,
    };
