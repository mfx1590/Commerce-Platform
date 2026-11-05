/**
 * Analytics consent mode (#609, the 2026-10-23 rule #576), as it applies to an anonymous browser
 * event:
 * - `analytics` (default): sent — counting our own commerce behaviour needs no marketing consent;
 * - `strict`: NOT sent — strict drops any event without a granted `marketing_email` for a known
 *   customer, and these events carry no customer, so strict always drops them.
 *
 * One storefront deployment is one store, so one variable is the per-store switch. An unknown value
 * throws rather than falling back to the open mode, as the engagement switch does.
 *
 * Plain ESM on purpose: `next.config.mjs` calls it, so an unknown value fails `next build` and
 * `next start`, and the render path calls the same function — one list, two checks.
 */

export const CONSENT_MODES = /** @type {const} */ (['analytics', 'strict']);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {'analytics' | 'strict'}
 */
export function analyticsConsentMode(env) {
  const raw = env.STOREFRONT_ANALYTICS_CONSENT_MODE?.trim();
  if (raw === undefined || raw === '') return 'analytics';
  if (raw === 'analytics' || raw === 'strict') return raw;
  throw new Error(
    `STOREFRONT_ANALYTICS_CONSENT_MODE must be one of ${CONSENT_MODES.join(', ')}; got an unknown value`,
  );
}
