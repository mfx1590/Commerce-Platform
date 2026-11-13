// Activation readiness (#413): what a store needs before `draft` / `paused` → `active`. One place, asked by
// `activateStore` and by `updateStore` when a patch moves the status to `active`, so the two paths cannot
// disagree. Pure reads: the rows the store already has plus one question to OpenFGA through the registrar.
// `tax_rates` (#520): a tax rate for every market country (`marketCountries`), or the store sells there at 0 bp.
// `shipping_options` (#809, CONTRACT CHANGE #811): an ACTIVE shipping option in the store's `default_currency` for
// every market country, or a cart to that country can never check out (the store is active and cannot sell).
// `payment_method` (#839, Admin API 0.4.29): at least one method the checkout can offer (`paymentMethodsOf`, the
// Store API's rule). Only a MOVE to `active` is gated: an already-active store is never re-checked or deactivated.
// `getStoreReadiness` answers the same check without changing anything, plus the purchasable-products count.
import type { Queryable } from '@platform/db';
import { paymentMethodsOf, type PaymentMethod } from './payment-methods';
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
  'shipping_options',
  'payment_method',
] as const;
export type ReadinessPrerequisite = (typeof READINESS_PREREQUISITES)[number];

export interface StoreReadiness {
  /** Empty when the store may become active. */
  missing: ReadinessPrerequisite[];
  /** The market countries with no tax rate at all, sorted (non-empty exactly when `tax_rates` is missing). */
  missing_tax_countries: string[];
  /** The market countries with no active option in the store currency, sorted (#809; non-empty exactly when
   * `shipping_options` is missing). */
  missing_shipping_countries: string[];
  /** What the checkout can offer (#839; empty exactly when `payment_method` is missing). */
  payment_methods: PaymentMethod[];
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
 * The market countries no ACTIVE shipping option in the store's `default_currency` covers (#809). A store without
 * options is missing its `default_country`; an option in another currency does not count — the cart's currency is
 * the store default (Phase 1), so checkout would offer it nothing.
 */
export async function unshippableMarketCountries(
  tx: Queryable,
  store: { id: string; default_country: string; default_currency: string },
): Promise<string[]> {
  const markets = await marketCountries(tx, store);
  const r = await tx.query<{ country: string }>(
    `SELECT DISTINCT upper(c::text) AS country FROM shipping_option so, unnest(so.countries) AS c
     WHERE so.store_id = $1 AND so.is_active AND so.currency = $2`,
    [store.id, store.default_currency],
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
  store: {
    id: string;
    code: string;
    settings: Record<string, unknown>;
    legal_entity_id: string | null;
    default_country: string;
    default_currency: string;
  },
  registrar: StoreRegistrar,
  env: NodeJS.ProcessEnv = process.env,
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
  const unshippable = await unshippableMarketCountries(tx, store);
  if (unshippable.length) missing.push('shipping_options');
  const payment_methods = paymentMethodsOf(store.code, store.settings ?? {}, env);
  if (payment_methods.length === 0) missing.push('payment_method');
  return {
    missing,
    missing_tax_countries: untaxed,
    missing_shipping_countries: unshippable,
    payment_methods,
  };
}

/**
 * Published products with at least one variant a cart can buy now (#839): priced for quantity 1 in the store's
 * `default_currency` on an ACTIVE `default` price list (the cart's `defaultListPriceResolver` rule) and with stock
 * available (`on_hand − reserved > 0`) in any warehouse of the variant's pool item. One query; the store's own
 * rows only (RLS + `store_id`).
 */
export async function purchasableProductCount(
  tx: Queryable,
  store: { id: string; default_currency: string },
): Promise<number> {
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM product p
     WHERE p.store_id = $1 AND p.status = 'published'
       AND EXISTS (
         SELECT 1 FROM product_variant v
         JOIN price pr ON pr.variant_id = v.id AND pr.currency = $2 AND pr.min_quantity <= 1
         JOIN price_list pl ON pl.id = pr.price_list_id AND pl.type = 'default' AND pl.status = 'active'
                            AND pl.currency = $2
         WHERE v.product_id = p.id AND v.store_id = $1
           AND EXISTS (SELECT 1 FROM inventory_level il
                       WHERE il.stock_item_id = v.stock_item_id AND il.available > 0))`,
    [store.id, store.default_currency],
  );
  return r.rows[0]?.n ?? 0;
}

export type ReadinessWarning = 'no_purchasable_product';

/** Admin API `StoreReadiness` (#839): what activation would refuse now, and whether the store can sell. */
export interface StoreReadinessReport extends StoreReadiness {
  status: 'draft' | 'active' | 'paused' | 'archived';
  purchasable_products: number;
  warnings: ReadinessWarning[];
}
