// Activation readiness (#413): what a store needs before `draft` / `paused` → `active`. One place, asked by
// `activateStore` and by `updateStore` when a patch moves the status to `active`, so the two paths cannot
// disagree. Pure reads: the rows the store already has plus one question to OpenFGA through the registrar.
// `tax_rates` (#520): a tax rate for every market country (`marketCountries`), or the store sells there at 0 bp.
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
  'tax_rates',
] as const;
export type ReadinessPrerequisite = (typeof READINESS_PREREQUISITES)[number];

export interface StoreReadiness {
  /** Empty when the store may become active. */
  missing: ReadinessPrerequisite[];
  /** The market countries with no tax rate at all, sorted (non-empty exactly when `tax_rates` is missing). */
  missing_tax_countries: string[];
}

/**
 * A store's MARKET COUNTRIES (#520, decided on #522): its `default_country` plus every country of its active
 * shipping options — the only destinations a cart of the store can check out to. Upper case, sorted, distinct.
 */
export async function marketCountries(
  tx: Queryable,
  store: { id: string; default_country: string },
): Promise<string[]> {
  const r = await tx.query<{ country: string }>(
    `SELECT upper($2::text) AS country
     UNION
     SELECT DISTINCT upper(c::text) FROM shipping_option so, unnest(so.countries) AS c
     WHERE so.store_id = $1 AND so.is_active
     ORDER BY 1`,
    [store.id, store.default_country],
  );
  return r.rows.map((x) => x.country);
}

/**
 * The market countries no `tax_rate` row covers (any region, any category counts — the provider then has a rate
 * to find for at least the country-wide case). Without one the store would tax that country at 0 bp.
 */
export async function untaxedMarketCountries(
  tx: Queryable,
  store: { id: string; default_country: string },
): Promise<string[]> {
  const markets = await marketCountries(tx, store);
  if (markets.length === 0) return [];
  const r = await tx.query<{ country: string }>(
    `SELECT DISTINCT upper(country::text) AS country FROM tax_rate WHERE store_id = $1 AND upper(country::text) = ANY($2)`,
    [store.id, markets],
  );
  const covered = new Set(r.rows.map((x) => x.country));
  return markets.filter((c) => !covered.has(c));
}

/**
 * Counts what the store has. `tx` is the caller's transaction (RLS keeps it inside the organization); the
 * store id is trusted to exist (the caller loaded or locked the row). The OpenFGA question goes last and only
 * through the registrar: a dev run without OpenFGA gets a registrar that answers `false` (see the routes), so
 * activation is refused rather than guessed.
 */
export async function storeReadiness(
  tx: Queryable,
  store: { id: string; legal_entity_id: string | null; default_country: string },
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
  const untaxed = await untaxedMarketCountries(tx, store);
  if (untaxed.length) missing.push('tax_rates');
  return { missing, missing_tax_countries: untaxed };
}
