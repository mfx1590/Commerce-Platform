// Activation readiness (#413): what a store needs before `draft` / `paused` → `active`. One place, asked by
// `activateStore` and by `updateStore` when a patch moves the status to `active`, so the two paths cannot
// disagree. Pure reads: the rows the store already has plus one question to OpenFGA through the registrar.
import type { Queryable } from '@platform/db';
import type { StoreRegistrar } from './types';

/** The prerequisites, in the order they are reported (the contract's closed list, #417). */
export const READINESS_PREREQUISITES = [
  'legal_entity',
  'locale',
  'currency',
  'primary_domain',
  'publishable_key',
  'fga_object',
] as const;
export type ReadinessPrerequisite = (typeof READINESS_PREREQUISITES)[number];

export interface StoreReadiness {
  /** Empty when the store may become active. */
  missing: ReadinessPrerequisite[];
}

/**
 * Counts what the store has. `tx` is the caller's transaction (RLS keeps it inside the organization); the
 * store id is trusted to exist (the caller loaded or locked the row). The OpenFGA question goes last and only
 * through the registrar: a dev run without OpenFGA gets a registrar that answers `false` (see the routes), so
 * activation is refused rather than guessed.
 */
export async function storeReadiness(
  tx: Queryable,
  store: { id: string; legal_entity_id: string | null },
  registrar: StoreRegistrar,
): Promise<StoreReadiness> {
  const counts = await tx.query<{
    locales: string;
    currencies: string;
    primary_domains: string;
    publishable_keys: string;
  }>(
    `SELECT (SELECT count(*) FROM store_locale   WHERE store_id = $1)::text AS locales,
            (SELECT count(*) FROM store_currency WHERE store_id = $1)::text AS currencies,
            (SELECT count(*) FROM store_domain   WHERE store_id = $1 AND is_primary)::text AS primary_domains,
            (SELECT count(*) FROM store_api_key  WHERE store_id = $1 AND type = 'publishable'
                                                   AND revoked_at IS NULL)::text AS publishable_keys`,
    [store.id],
  );
  const c = counts.rows[0]!;
  const missing: ReadinessPrerequisite[] = [];
  if (!store.legal_entity_id) missing.push('legal_entity');
  if (Number(c.locales) === 0) missing.push('locale');
  if (Number(c.currencies) === 0) missing.push('currency');
  if (Number(c.primary_domains) === 0) missing.push('primary_domain');
  if (Number(c.publishable_keys) === 0) missing.push('publishable_key');
  if (!(await registrar.hasStoreObject(store.id))) missing.push('fga_object');
  return { missing };
}
