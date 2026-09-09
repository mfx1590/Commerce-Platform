// Rate shopping at checkout (issue #130): the `ShippingRateProvider` the cart module calls for every quote.
//
// Shape of the answer: the store's `shipping_option` rows decide WHICH options exist and whether a cart is
// eligible for them; the carrier decides what a live option COSTS. An option row is therefore always the source
// of the id, code, name and carrier — checkout freezes exactly that row on the order (`shipping_method`), so a
// rate this module invents out of thin air could never be placed.
//
// When the carrier cannot answer — down, timing out, rate-limited past its retries, no credentials, no
// warehouse to ship from, nothing quoted in the cart's currency — every option falls back to its flat
// `price_minor`. A carrier outage must never stop a cart from pricing.
import { createHash } from 'node:crypto';
import type { Queryable } from '@platform/db';
import {
  setShippingRateProvider,
  type PricingContext,
  type ShippingRate,
  type ShippingRateProvider,
} from '../cart';
import { BoundedTtlMap } from './bounded-map';
import { carrierConfigFor, easyPostCredentialsFor } from './config';
import { createEasyPostProvider } from './easypost-provider';
import { carrierProvider } from './registry';
import { CarrierError, toCarrierAddress } from './redact';
import type {
  CarrierAddress,
  CarrierProvider,
  CarrierRate,
  ContractAddress,
  Parcel,
  StoreCarrierConfig,
} from './types';

/** `shipping_option` as this module reads it: the cart module's columns plus `service` and `rules`. */
interface OptionRow {
  id: string;
  code: string;
  name: string;
  carrier: string;
  service: string | null;
  price_minor: string;
  currency: string;
  rules: Record<string, unknown>;
}

interface StoreRow {
  code: string;
  settings: Record<string, unknown> | null;
}

interface WarehouseRow {
  address: ContractAddress | Record<string, unknown>;
  country: string;
}

/**
 * The `rules` jsonb of a `shipping_option`. Everything is optional; an unreadable value is ignored rather than
 * failing the quote. `min_subtotal_minor` and `max_weight_g` are the two keys docs/domain.md names;
 * `free_over_subtotal_minor` and `live` are this module's additions to the same free-form column.
 */
export interface ShippingOptionRules {
  /** Option offered only when the cart subtotal reaches this. */
  minSubtotalMinor: number | null;
  /** Option offered only when the parcel weighs at most this. */
  maxWeightG: number | null;
  /** At or above this subtotal the option costs nothing (free shipping threshold). */
  freeOverSubtotalMinor: number | null;
  /** `true` = price this option from the carrier (needs `service`); otherwise the flat `price_minor` is used. */
  live: boolean;
}

export function parseRules(rules: unknown): ShippingOptionRules {
  const r = rules !== null && typeof rules === 'object' ? (rules as Record<string, unknown>) : {};
  return {
    minSubtotalMinor: nonNegativeInt(r.min_subtotal_minor),
    maxWeightG: nonNegativeInt(r.max_weight_g),
    freeOverSubtotalMinor: nonNegativeInt(r.free_over_subtotal_minor),
    live: r.live === true,
  };
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export interface RateShoppingOptions {
  /** How long a carrier quote is reused for an identical cart (default 60 s). */
  cacheTtlMs?: number;
  /** Cap on cached quotes (default 500) and on resolved per-store providers (default 50). */
  cacheMaxEntries?: number;
  providerCacheMaxEntries?: number;
  /** Environment the per-store credentials are read from (ADR 0006). */
  env?: NodeJS.ProcessEnv;
  /** Weight assumed for a line whose variant has no `weight_g` (default 500 g each). */
  fallbackLineWeightG?: number;
  /** Injected in tests. */
  now?: () => number;
  /** Where a carrier outage is reported. Receives redacted fields only. */
  onFallback?: (info: {
    store_id: string;
    country: string;
    provider: string;
    status: number;
    operation: string;
    reason: string;
  }) => void;
}

export interface CarrierRateProvider extends ShippingRateProvider {
  /** Drops cached carrier quotes and resolved providers. Tests and a credential rotation. */
  clearCache(): void;
}

/**
 * Builds the provider that `setShippingRateProvider` installs. Everything it needs beyond `PricingContext` — the
 * store's code and settings, the origin warehouse, the line weights — is read through `ctx.tx`, so it stays
 * inside the cart's transaction and its RLS scope.
 */
export function createCarrierRateProvider(options: RateShoppingOptions = {}): CarrierRateProvider {
  const {
    cacheTtlMs = 60_000,
    cacheMaxEntries = 500,
    providerCacheMaxEntries = 50,
    env = process.env,
    fallbackLineWeightG = 500,
    now,
    onFallback = defaultOnFallback,
  } = options;

  const quotes = new BoundedTtlMap<CarrierRate[]>({
    maxEntries: cacheMaxEntries,
    ttlMs: cacheTtlMs,
    ...(now ? { now } : {}),
  });
  const providers = new BoundedTtlMap<CarrierProvider>({
    maxEntries: providerCacheMaxEntries,
    ttlMs: Infinity,
    ...(now ? { now } : {}),
  });

  /**
   * The provider a store shops with: its settings name it, the registry or its credentials supply it. A name
   * registered at boot (`setCarrierProvider`) always wins — that is what the registry is for. `easypost` is
   * otherwise built on demand from the store's own key, which is why it cannot be a single registry entry: the
   * credentials are per store (ADR 0006). No key and no registration → null, and the caller uses table rates.
   */
  function providerForStore(store: StoreRow, config: StoreCarrierConfig): CarrierProvider | null {
    const registered = carrierProvider(config.provider);
    if (registered) return registered;
    if (config.provider === 'easypost') {
      const credentials = easyPostCredentialsFor(store.code, env);
      if (!credentials) return null;
      const key = `easypost:${store.code}:${credentials.variable}`;
      const cached = providers.get(key);
      if (cached) return cached;
      const provider = createEasyPostProvider({ apiKey: credentials.apiKey });
      providers.set(key, provider);
      return provider;
    }
    return null;
  }

  /** Live carrier rates for this cart, or null when the carrier cannot answer (the caller then goes flat). */
  async function shop(
    ctx: PricingContext,
    rows: OptionRow[],
    weightG: number,
  ): Promise<CarrierRate[] | null> {
    const store = await loadStore(ctx.tx, ctx.storeId);
    if (!store) return null;
    const config = carrierConfigFor(store.settings);
    const provider = providerForStore(store, config);
    if (!provider) return null;

    const origin = await loadOrigin(ctx.tx, ctx.organizationId, ctx.country);
    if (!origin) {
      onFallback({
        store_id: ctx.storeId,
        country: ctx.country,
        provider: provider.name,
        status: 0,
        operation: 'origin',
        reason: 'no active warehouse with a usable address',
      });
      return null;
    }
    const destination = destinationAddress(ctx);
    if (!destination) return null;

    const services = [...new Set(rows.map((row) => row.service).filter((s): s is string => !!s))];
    const parcel: Parcel = { ...config.defaultParcel, weightG };
    const key = cacheKey(ctx, provider.name, origin, destination, parcel, services, config);
    const cached = quotes.get(key);
    if (cached) return cached;

    try {
      const rates = await provider.rates({
        from: origin,
        to: destination,
        parcels: [parcel],
        currency: ctx.currency,
        ...(config.carrierAccountIds.length > 0
          ? { carrierAccountIds: config.carrierAccountIds }
          : {}),
        ...(services.length > 0 ? { services } : {}),
      });
      // A rate in another currency never gets here: providers drop what they cannot quote in `ctx.currency`.
      const usable = rates.filter((rate) => rate.currency === ctx.currency);
      quotes.set(key, usable);
      return usable;
    } catch (error) {
      const carrierError =
        error instanceof CarrierError
          ? error
          : new CarrierError(provider.name, 0, 'rates', 'unexpected provider failure');
      onFallback({
        store_id: ctx.storeId,
        country: ctx.country,
        provider: carrierError.provider,
        status: carrierError.status,
        operation: carrierError.operation,
        reason: 'carrier unavailable, using table rates',
      });
      return null;
    }
  }

  /** One option priced: the carrier's price when the row asks for it and the carrier answered, else the flat one. */
  function priceOf(
    row: OptionRow,
    rates: CarrierRate[] | null,
    subtotalMinor: number,
  ): ShippingRate {
    const rules = parseRules(row.rules);
    const flat = Number(row.price_minor);
    let priceMinor = flat;
    if (rules.live && row.service && rates) {
      const match = rates.find(
        (rate) => rate.service === row.service && sameCarrier(rate.carrier, row.carrier),
      );
      if (match) priceMinor = match.priceMinor;
    }
    if (rules.freeOverSubtotalMinor !== null && subtotalMinor >= rules.freeOverSubtotalMinor) {
      priceMinor = 0;
    }
    return {
      optionId: row.id,
      code: row.code,
      name: row.name,
      carrier: row.carrier,
      priceMinor,
      currency: row.currency,
    };
  }

  /** Rows this cart may see at all: the SQL predicate plus the eligibility rules. */
  function eligible(rows: OptionRow[], subtotalMinor: number, weightG: number): OptionRow[] {
    return rows.filter((row) => {
      const rules = parseRules(row.rules);
      if (rules.minSubtotalMinor !== null && subtotalMinor < rules.minSubtotalMinor) return false;
      if (rules.maxWeightG !== null && weightG > rules.maxWeightG) return false;
      return true;
    });
  }

  async function priceAll(ctx: PricingContext, rows: OptionRow[]): Promise<ShippingRate[]> {
    const subtotalMinor = subtotalOf(ctx);
    const weightG = await parcelWeight(ctx, fallbackLineWeightG);
    const offered = eligible(rows, subtotalMinor, weightG);
    if (offered.length === 0) return [];
    const wantsLive = offered.some((row) => parseRules(row.rules).live && row.service);
    const rates = wantsLive ? await shop(ctx, offered, weightG) : null;
    return offered
      .map((row) => priceOf(row, rates, subtotalMinor))
      .sort((a, b) => a.priceMinor - b.priceMinor || a.code.localeCompare(b.code));
  }

  return {
    async list(ctx): Promise<ShippingRate[]> {
      return priceAll(ctx, await loadOptions(ctx));
    },
    async quote(ctx, optionId): Promise<ShippingRate | null> {
      const rows = await loadOptions(ctx, optionId);
      if (rows.length === 0) return null; // unknown, inactive, wrong currency or country → cart drops it
      const priced = await priceAll(ctx, rows);
      return priced[0] ?? null; // eligibility rules can still refuse the option
    },
    clearCache(): void {
      quotes.clear();
      providers.clear();
    },
  };
}

/**
 * The boot mount point. `src/server.ts` calls `registerCarrierProviders()` once at start-up (REQUEST to window 1)
 * — this module never edits the cart. Returns the provider it replaced so a test can restore it.
 */
export function registerCarrierProviders(options: RateShoppingOptions = {}): ShippingRateProvider {
  return setShippingRateProvider(createCarrierRateProvider(options));
}

// ---- reads (all through the cart's transaction, RLS scope = the store) ----

/**
 * Same predicate as the cart module's `tableShippingRates` — active, cart currency, destination in `countries`
 * (empty = everywhere), sales channel unset or the cart's — plus `service` and `rules`.
 */
async function loadOptions(ctx: PricingContext, optionId?: string): Promise<OptionRow[]> {
  const r = await ctx.tx.query<OptionRow>(
    `SELECT id, code, name, carrier, service, price_minor::text, currency, rules FROM shipping_option
      WHERE store_id = $1 AND is_active AND currency = $2
        AND (cardinality(countries) = 0 OR $3 = ANY(countries))
        AND (sales_channel_id IS NULL OR sales_channel_id = $4)
        AND ($5::uuid IS NULL OR id = $5::uuid)
      ORDER BY price_minor, code`,
    [ctx.storeId, ctx.currency, ctx.country, ctx.salesChannelId, optionId ?? null],
  );
  return r.rows;
}

async function loadStore(tx: Queryable, storeId: string): Promise<StoreRow | null> {
  const r = await tx.query<StoreRow>(`SELECT code, settings FROM store WHERE id = $1`, [storeId]);
  return r.rows[0] ?? null;
}

/**
 * Where the parcel ships from: an active warehouse, one in the destination country first, then by `priority`.
 * Task 2.4 replaces this with real per-warehouse routing; until then the highest-priority warehouse wins.
 */
async function loadOrigin(
  tx: Queryable,
  organizationId: string,
  destinationCountry: string,
): Promise<CarrierAddress | null> {
  const r = await tx.query<WarehouseRow>(
    `SELECT address, country FROM warehouse
      WHERE organization_id = $1 AND is_active
      ORDER BY (country = $2) DESC, priority, code`,
    [organizationId, destinationCountry],
  );
  for (const row of r.rows) {
    const address = asContractAddress(row.address, row.country);
    if (address) return toCarrierAddress(address);
  }
  return null;
}

/** The cart's shipping address, or a country-only stand-in so a quote is possible before the address is entered. */
function destinationAddress(ctx: PricingContext): CarrierAddress | null {
  if (ctx.shippingAddress) return toCarrierAddress(ctx.shippingAddress);
  return null;
}

/** Summed `product_variant.weight_g × quantity`; a variant without a weight counts as `fallbackLineWeightG`. */
async function parcelWeight(ctx: PricingContext, fallbackLineWeightG: number): Promise<number> {
  if (ctx.lines.length === 0) return 0;
  const r = await ctx.tx.query<{ id: string; weight_g: number | null }>(
    `SELECT id, weight_g FROM product_variant WHERE id = ANY($1::uuid[])`,
    [ctx.lines.map((line) => line.variantId)],
  );
  const weights = new Map(r.rows.map((row) => [row.id, row.weight_g]));
  return ctx.lines.reduce(
    (total, line) => total + (weights.get(line.variantId) ?? fallbackLineWeightG) * line.quantity,
    0,
  );
}

function subtotalOf(ctx: PricingContext): number {
  return ctx.lines.reduce(
    (total, line) => total + line.quantity * line.unitPriceMinor - line.discountMinor,
    0,
  );
}

/** `dhl` and `DHLExpress` are the same carrier as far as an option row is concerned. */
function sameCarrier(rateCarrier: string, rowCarrier: string): boolean {
  const a = rateCarrier.toLowerCase();
  const b = rowCarrier.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Cache key of a carrier quote. The destination is **hashed**, not stored: an address never sits in a process
 * index in readable form, and the hash still separates two carts going to different houses.
 */
function cacheKey(
  ctx: PricingContext,
  providerName: string,
  origin: CarrierAddress,
  destination: CarrierAddress,
  parcel: Parcel,
  services: string[],
  config: StoreCarrierConfig,
): string {
  const destinationHash = createHash('sha256')
    .update(
      [
        destination.country,
        destination.postalCode,
        destination.city,
        destination.region ?? '',
        destination.line1,
        destination.line2 ?? '',
      ].join(' '),
    )
    .digest('hex');
  return [
    providerName,
    ctx.storeId,
    ctx.currency,
    origin.country,
    origin.postalCode,
    destinationHash,
    `${parcel.lengthCm}x${parcel.widthCm}x${parcel.heightCm}x${parcel.weightG}`,
    [...services].sort().join(','),
    [...config.carrierAccountIds].sort().join(','),
  ].join('|');
}

/** A warehouse `address` jsonb is only usable when it carries what a carrier needs. */
function asContractAddress(value: unknown, country: string): ContractAddress | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  const line1 = text(a.line1);
  const city = text(a.city);
  const postalCode = text(a.postal_code);
  if (!line1 || !city || !postalCode) return null;
  return {
    first_name: text(a.first_name) ?? text(a.name) ?? 'Warehouse',
    last_name: text(a.last_name) ?? '',
    company: text(a.company) ?? null,
    line1,
    line2: text(a.line2) ?? null,
    city,
    region: text(a.region) ?? null,
    postal_code: postalCode,
    country: (text(a.country) ?? country).toUpperCase(),
    phone: text(a.phone) ?? null,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** One line, no address, no key: which store fell back, to where (country), and why. */
function defaultOnFallback(info: {
  store_id: string;
  country: string;
  provider: string;
  status: number;
  operation: string;
  reason: string;
}): void {
  console.warn('shipping: carrier rates unavailable', info);
}
