// A store's shipping options (#809, CONTRACT CHANGE #811): the `shipping_option` rows checkout offers — only the
// active ones in the cart's currency that list the destination country (src/modules/shipping/rate-shopping.ts, the
// cart's table provider). Admin API `listShippingOptions` (viewer), `createShippingOption` / `updateShippingOption`
// (store_admin), all on the store-scoped client the route resolved (RLS kind `store`).
//
// - Money: `price_minor` is an integer in the currency's MINOR unit, whatever its exponent — 1980 is ¥1,980 (JPY,
//   0 decimals), 1990 is €19.90. Nothing here converts or rounds: the amount is stored, priced and placed as given.
// - `currency` must be one of the store's currencies; `code` and `currency` never change (a new currency is a new
//   option). Rows are never deleted (carts and orders reference them): `is_active: false` retires one.
// - Every mutation locks the store row first (`lockStore`, as the registry's other sub-resources), so the update
//   guard reads a settled set: on an ACTIVE store a change that leaves a market country newly without an active
//   option in the store currency is 409 `conflict` `{ missing_shipping_countries }` — what activation demands.
// - Audit row + `store.updated` (`changed_fields: ['shipping_options']`) in the same transaction.
import type { Queryable, ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { conflict, notFound, validationError } from '../../lib/errors';
import { withEvents } from '../../outbox';
import { unshippableMarketCountries } from './readiness';
import { lockStore, loadStore, organizationOf, storeUpdatedEvent } from './service';

const COUNTRY = /^[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_INDEX = 'shipping_option_store_id_code_key';

const COLS = `id, code, name, carrier, service, price_minor::text AS price_minor, currency, countries, sales_channel_id,
  rules, is_active`;

interface ShippingOptionRow {
  id: string;
  code: string;
  name: string;
  carrier: string;
  service: string | null;
  price_minor: string;
  currency: string;
  countries: string[];
  sales_channel_id: string | null;
  rules: Record<string, unknown>;
  is_active: boolean;
}

/** The contract's `ShippingOption`. */
export interface ShippingOption {
  id: string;
  code: string;
  name: string;
  carrier: string;
  service: string | null;
  price: { amount_minor: number; currency: string };
  countries: string[];
  sales_channel_id: string | null;
  rules: Record<string, unknown>;
  is_active: boolean;
}

/** The contract's `ShippingOptionInput`. */
export interface ShippingOptionInput {
  code: string;
  name: string;
  carrier?: string;
  service?: string | null;
  price_minor: number;
  currency: string;
  countries: string[];
  sales_channel_id?: string | null;
  rules?: Record<string, unknown>;
  is_active?: boolean;
}

/** CONTRACT CHANGE #811's `ShippingOptionPatch`: every field optional, `code` and `currency` immutable. */
export type ShippingOptionPatch = Partial<
  Pick<
    ShippingOptionInput,
    | 'name'
    | 'carrier'
    | 'service'
    | 'price_minor'
    | 'countries'
    | 'sales_channel_id'
    | 'rules'
    | 'is_active'
  >
>;

const toShippingOption = (r: ShippingOptionRow): ShippingOption => ({
  id: r.id,
  code: r.code,
  name: r.name,
  carrier: r.carrier,
  service: r.service,
  price: { amount_minor: Number(r.price_minor), currency: r.currency.trim() },
  countries: r.countries.map((c) => c.trim()),
  sales_channel_id: r.sales_channel_id,
  rules: r.rules,
  is_active: r.is_active,
});

const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const minor = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const plainObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Upper-cased, distinct, sorted; `undefined` when the value is not a non-empty list of ISO 3166-1 alpha-2 codes. */
function normaliseCountries(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out = new Set<string>();
  for (const c of v) {
    if (typeof c !== 'string' || !COUNTRY.test(c.toUpperCase())) return undefined;
    out.add(c.toUpperCase());
  }
  return [...out].sort();
}

const COUNTRIES_RULE = 'non-empty list of ISO 3166-1 alpha-2 codes';

/** The fields create and update share; `problems` collects the 400's details. */
function checkCommon(
  input: ShippingOptionPatch,
  problems: Record<string, string>,
): { countries?: string[] } {
  if (input.name !== undefined && !text(input.name, 120))
    problems.name = 'string of 1–120 characters';
  if (input.carrier !== undefined && !text(input.carrier, 64))
    problems.carrier = 'string of 1–64 characters';
  if (input.service !== undefined && input.service !== null && !text(input.service, 64)) {
    problems.service = 'string of 1–64 characters, or null';
  }
  if (input.price_minor !== undefined && !minor(input.price_minor)) {
    problems.price_minor =
      "integer ≥ 0 in the currency's minor unit (1980 = ¥1,980, 1990 = €19.90)";
  }
  if (
    input.sales_channel_id !== undefined &&
    input.sales_channel_id !== null &&
    (typeof input.sales_channel_id !== 'string' || !UUID.test(input.sales_channel_id))
  ) {
    problems.sales_channel_id = 'uuid or null';
  }
  if (input.rules !== undefined && !plainObject(input.rules)) problems.rules = 'object';
  if (input.is_active !== undefined && typeof input.is_active !== 'boolean')
    problems.is_active = 'boolean';
  if (input.countries === undefined) return {};
  const countries = normaliseCountries(input.countries);
  if (!countries) problems.countries = COUNTRIES_RULE;
  return countries ? { countries } : {};
}

async function requireOwnSalesChannel(
  tx: Queryable,
  storeId: string,
  salesChannelId: string | null | undefined,
): Promise<void> {
  if (!salesChannelId) return;
  const r = await tx.query(`SELECT 1 FROM sales_channel WHERE id = $1 AND store_id = $2`, [
    salesChannelId,
    storeId,
  ]);
  if (!r.rows[0]) {
    throw validationError('invalid shipping option', {
      sales_channel_id: 'a sales channel of this store',
    });
  }
}

/** `GET /admin/stores/{storeId}/shipping-options` (viewer): every option, active or not, by code. */
export async function listShippingOptions(
  client: ScopedClient,
  storeId: string,
): Promise<ShippingOption[]> {
  return client.transaction(async (tx) => {
    await loadStore(tx, storeId);
    const r = await tx.query<ShippingOptionRow>(
      `SELECT ${COLS} FROM shipping_option WHERE store_id = $1 ORDER BY code, id`,
      [storeId],
    );
    return r.rows.map(toShippingOption);
  });
}

/**
 * `POST /admin/stores/{storeId}/shipping-options` (store_admin): 201. 400 for a bad body, a currency that is not the
 * store's or a sales channel of another store; 409 `conflict` `{ shipping_option_id }` when the code is taken.
 */
export async function createShippingOption(
  client: ScopedClient,
  storeId: string,
  input: ShippingOptionInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ShippingOption> {
  const problems: Record<string, string> = {};
  if (!text(input.code, 64)) problems.code = 'string of 1–64 characters';
  if (input.name === undefined) problems.name = 'required';
  if (input.price_minor === undefined) problems.price_minor = 'required';
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) {
    problems.currency = 'ISO 4217 code, upper case';
  }
  if (input.countries === undefined) problems.countries = COUNTRIES_RULE;
  const { countries } = checkCommon(input, problems);
  if (Object.keys(problems).length) throw validationError('invalid shipping option', problems);
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const store = await lockStore(tx, storeId);
    const currencies = await tx.query<{ currency: string }>(
      `SELECT currency FROM store_currency WHERE store_id = $1`,
      [storeId],
    );
    const allowed = new Set([
      store.default_currency,
      ...currencies.rows.map((c) => c.currency.trim()),
    ]);
    if (!allowed.has(input.currency)) {
      throw validationError('invalid shipping option', {
        currency: `one of the store's currencies: ${[...allowed].sort().join(', ')}`,
      });
    }
    await requireOwnSalesChannel(tx, storeId, input.sales_channel_id);
    // The code's uniqueness is the database's (UNIQUE (store_id, code)); the savepoint keeps the transaction usable
    // after the 23505 so the existing option can be named in the 409.
    await tx.query('SAVEPOINT shipping_option_create');
    let row: ShippingOptionRow;
    try {
      const r = await tx.query<ShippingOptionRow>(
        `INSERT INTO shipping_option (organization_id, store_id, code, name, carrier, service, price_minor, currency,
                                      countries, sales_channel_id, rules, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${COLS}`,
        [
          organizationId,
          storeId,
          input.code.trim(),
          input.name.trim(),
          input.carrier?.trim() ?? 'manual',
          input.service?.trim() ?? null,
          input.price_minor,
          input.currency,
          countries,
          input.sales_channel_id ?? null,
          JSON.stringify(input.rules ?? {}),
          input.is_active ?? true,
        ],
      );
      row = r.rows[0]!;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e?.code !== '23505' || e.constraint !== CODE_INDEX) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT shipping_option_create');
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM shipping_option WHERE store_id = $1 AND code = $2`,
        [storeId, input.code.trim()],
      );
      throw conflict('this store already has a shipping option with this code', {
        shipping_option_id: existing.rows[0]?.id ?? null,
      });
    }
    await tx.query('RELEASE SAVEPOINT shipping_option_create');
    const option = toShippingOption(row);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'shipping_option.create',
      entityType: 'shipping_option',
      entityId: option.id,
      after: option,
    });
    await withEvents(tx, [
      await storeUpdatedEvent(store, organizationId, actor, ['shipping_options']),
    ]);
    return option;
  });
}

/**
 * `PATCH /admin/stores/{storeId}/shipping-options/{optionId}` (store_admin, CONTRACT CHANGE #811): 200. 400 for an
 * empty or bad body (`code` / `currency` are immutable), 404 for an option of another store, 409 `conflict`
 * `{ missing_shipping_countries }` when, on an ACTIVE store, the change leaves a market country NEWLY without an
 * active option in the store currency (a country that was already uncovered does not block an unrelated edit).
 */
export async function updateShippingOption(
  client: ScopedClient,
  storeId: string,
  optionId: string,
  patch: ShippingOptionPatch & { code?: unknown; currency?: unknown },
  actor: Actor = SYSTEM_ACTOR,
): Promise<ShippingOption> {
  const problems: Record<string, string> = {};
  if (!plainObject(patch) || Object.keys(patch).length === 0) problems.body = 'at least one field';
  if (patch.code !== undefined) problems.code = 'immutable';
  if (patch.currency !== undefined)
    problems.currency = 'immutable (a new currency is a new option)';
  const { countries } = plainObject(patch) ? checkCommon(patch, problems) : {};
  if (Object.keys(problems).length)
    throw validationError('invalid shipping option patch', problems);
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const store = await lockStore(tx, storeId);
    const current = await tx.query<ShippingOptionRow>(
      `SELECT ${COLS} FROM shipping_option WHERE id = $1 AND store_id = $2 FOR UPDATE`,
      [optionId, storeId],
    );
    if (!current.rows[0]) throw notFound('shipping option', optionId);
    const before = toShippingOption(current.rows[0]);
    await requireOwnSalesChannel(tx, storeId, patch.sales_channel_id);
    const uncoveredBefore =
      store.status === 'active' ? await unshippableMarketCountries(tx, store) : [];

    const r = await tx.query<ShippingOptionRow>(
      `UPDATE shipping_option SET
         name = CASE WHEN $3::boolean THEN $4 ELSE name END,
         carrier = CASE WHEN $5::boolean THEN $6 ELSE carrier END,
         service = CASE WHEN $7::boolean THEN $8 ELSE service END,
         price_minor = CASE WHEN $9::boolean THEN $10::bigint ELSE price_minor END,
         countries = CASE WHEN $11::boolean THEN $12::char(2)[] ELSE countries END,
         sales_channel_id = CASE WHEN $13::boolean THEN $14::uuid ELSE sales_channel_id END,
         rules = CASE WHEN $15::boolean THEN $16::jsonb ELSE rules END,
         is_active = CASE WHEN $17::boolean THEN $18 ELSE is_active END,
         updated_at = now()
       WHERE id = $1 AND store_id = $2 RETURNING ${COLS}`,
      [
        optionId,
        storeId,
        patch.name !== undefined,
        patch.name?.trim() ?? null,
        patch.carrier !== undefined,
        patch.carrier?.trim() ?? null,
        patch.service !== undefined,
        patch.service?.trim() ?? null,
        patch.price_minor !== undefined,
        patch.price_minor ?? null,
        countries !== undefined,
        countries ?? null,
        patch.sales_channel_id !== undefined,
        patch.sales_channel_id ?? null,
        patch.rules !== undefined,
        patch.rules === undefined ? null : JSON.stringify(patch.rules),
        patch.is_active !== undefined,
        patch.is_active ?? null,
      ],
    );
    if (store.status === 'active') {
      const wasUncovered = new Set(uncoveredBefore);
      const newlyUncovered = (await unshippableMarketCountries(tx, store)).filter(
        (c) => !wasUncovered.has(c),
      );
      if (newlyUncovered.length) {
        throw conflict(
          'this change would leave a market country of this active store without an active shipping option in the store currency',
          { missing_shipping_countries: newlyUncovered },
        );
      }
    }
    const after = toShippingOption(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'shipping_option.update',
      entityType: 'shipping_option',
      entityId: optionId,
      before,
      after,
    });
    await withEvents(tx, [
      await storeUpdatedEvent(store, organizationId, actor, ['shipping_options']),
    ]);
    return after;
  });
}
