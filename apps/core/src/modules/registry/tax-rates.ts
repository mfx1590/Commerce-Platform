// A store's tax rates (#520, CONTRACT CHANGE #522): the `tax_rate` rows the `table` tax provider reads (no row →
// 0 bp). Admin API `listTaxRates` (viewer) and `createTaxRate` / `updateTaxRate` / `deleteTaxRate` (store_admin),
// all on the store-scoped client the route resolved (RLS kind `store`).
//
// - One row per (country, region, product category): the database enforces it (0201 `tax_rate_identity_key`,
//   NULLS NOT DISTINCT) and the 23505 on that index is 409 `conflict` with `details.tax_rate_id`.
// - Every mutation locks the store row first (`lockStore`, as the registry's other sub-resources): two deletes
//   cannot each see "another row is left" and both go, and the activation gate reads a settled set.
// - The delete guard: an ACTIVE store cannot lose the last rate of one of its market countries (409) — the
//   country would be taxed at 0 bp from the next cart on. A draft or paused store can; readiness catches it.
// - Audit row + `store.updated` (`changed_fields: ['tax_rates']`, no rates in the payload) in the same transaction.
import type { Queryable, ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { conflict, notFound, validationError } from '../../lib/errors';
import { withEvents } from '../../outbox';
import { marketCountries } from './readiness';
import { loadStore, lockStore, organizationOf, storeUpdatedEvent } from './service';
import type { TaxRate, TaxRateInput, TaxRatePatch } from './types';

const COUNTRY = /^[A-Z]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BP = 10_000;
const IDENTITY_INDEX = 'tax_rate_identity_key';

const COLS = `id, country, region, name, rate_bp, product_category_id, created_at, updated_at`;

interface TaxRateRow {
  id: string;
  country: string;
  region: string | null;
  name: string;
  rate_bp: number;
  product_category_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const toTaxRate = (r: TaxRateRow): TaxRate => ({
  id: r.id,
  country: r.country,
  region: r.region,
  name: r.name,
  rate_bp: r.rate_bp,
  product_category_id: r.product_category_id,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

const validName = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;
const validBp = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_BP;

/** `GET /admin/stores/{storeId}/tax-rates`: country, region (nulls first), category (nulls first), name. */
export async function listTaxRates(
  client: ScopedClient,
  storeId: string,
  q: { country?: string | undefined } = {},
): Promise<TaxRate[]> {
  if (q.country !== undefined && !COUNTRY.test(q.country)) {
    throw validationError('invalid tax rate query', { country: 'ISO 3166-1 alpha-2, upper case' });
  }
  return client.transaction(async (tx) => {
    await loadStore(tx, storeId);
    const r = await tx.query<TaxRateRow>(
      `SELECT ${COLS} FROM tax_rate WHERE store_id = $1 AND ($2::text IS NULL OR country = $2)
       ORDER BY country, region NULLS FIRST, product_category_id NULLS FIRST, name, id`,
      [storeId, q.country ?? null],
    );
    return r.rows.map(toTaxRate);
  });
}

/**
 * `POST /admin/stores/{storeId}/tax-rates` (store_admin): 201. 400 for a bad body or a category that is not the
 * store's; 409 `conflict` `{ tax_rate_id }` when a row for the same (country, region, category) exists.
 */
export async function createTaxRate(
  client: ScopedClient,
  storeId: string,
  input: TaxRateInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<TaxRate> {
  const problems: Record<string, string> = {};
  if (typeof input.country !== 'string' || !COUNTRY.test(input.country)) {
    problems.country = 'ISO 3166-1 alpha-2, upper case';
  }
  const region = input.region ?? null;
  if (region !== null && (typeof region !== 'string' || region.length < 1 || region.length > 64)) {
    problems.region = 'string of 1–64 characters, or null';
  }
  if (!validName(input.name)) problems.name = 'string of 1–120 characters';
  if (!validBp(input.rate_bp)) problems.rate_bp = `integer basis points 0–${MAX_BP}`;
  const categoryId = input.product_category_id ?? null;
  if (categoryId !== null && (typeof categoryId !== 'string' || !UUID.test(categoryId))) {
    problems.product_category_id = 'uuid or null';
  }
  if (Object.keys(problems).length) throw validationError('invalid tax rate', problems);
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const store = await lockStore(tx, storeId);
    if (categoryId !== null) {
      const category = await tx.query(
        `SELECT 1 FROM product_category WHERE id = $1 AND store_id = $2`,
        [categoryId, storeId],
      );
      if (!category.rows[0]) {
        throw validationError('invalid tax rate', {
          product_category_id: 'a product category of this store',
        });
      }
    }
    // The identity is the database's (0201). A savepoint keeps the transaction usable after a 23505 so the
    // existing row can be named in the 409.
    await tx.query('SAVEPOINT tax_rate_create');
    let row: TaxRateRow;
    try {
      const r = await tx.query<TaxRateRow>(
        `INSERT INTO tax_rate (organization_id, store_id, country, region, name, rate_bp, product_category_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
        [
          organizationId,
          storeId,
          input.country,
          region,
          input.name.trim(),
          input.rate_bp,
          categoryId,
        ],
      );
      row = r.rows[0]!;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e?.code !== '23505' || e.constraint !== IDENTITY_INDEX) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT tax_rate_create');
      throw conflict('a tax rate for this country, region and product category already exists', {
        tax_rate_id: await existingId(tx, storeId, input.country, region, categoryId),
      });
    }
    await tx.query('RELEASE SAVEPOINT tax_rate_create');
    const rate = toTaxRate(row);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'tax_rate.create',
      entityType: 'tax_rate',
      entityId: rate.id,
      after: rate,
    });
    await withEvents(tx, [await storeUpdatedEvent(store, organizationId, actor, ['tax_rates'])]);
    return rate;
  });
}

async function existingId(
  tx: Queryable,
  storeId: string,
  country: string,
  region: string | null,
  categoryId: string | null,
): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM tax_rate WHERE store_id = $1 AND country = $2
       AND region IS NOT DISTINCT FROM $3 AND product_category_id IS NOT DISTINCT FROM $4::uuid`,
    [storeId, country, region, categoryId],
  );
  return r.rows[0]?.id ?? null;
}

async function lockRate(tx: Queryable, storeId: string, taxRateId: string): Promise<TaxRateRow> {
  const r = await tx.query<TaxRateRow>(
    `SELECT ${COLS} FROM tax_rate WHERE id = $1 AND store_id = $2 FOR UPDATE`,
    [taxRateId, storeId],
  );
  if (!r.rows[0]) throw notFound('tax rate', taxRateId);
  return r.rows[0];
}

/**
 * `PATCH /admin/stores/{storeId}/tax-rates/{taxRateId}` (store_admin): `name` and / or `rate_bp`; the identity
 * (country, region, category) is not editable. 400 for an empty or bad body, 404 for a rate of another store.
 */
export async function updateTaxRate(
  client: ScopedClient,
  storeId: string,
  taxRateId: string,
  patch: TaxRatePatch,
  actor: Actor = SYSTEM_ACTOR,
): Promise<TaxRate> {
  const problems: Record<string, string> = {};
  if (patch.name === undefined && patch.rate_bp === undefined) problems.body = 'name or rate_bp';
  if (patch.name !== undefined && !validName(patch.name))
    problems.name = 'string of 1–120 characters';
  if (patch.rate_bp !== undefined && !validBp(patch.rate_bp)) {
    problems.rate_bp = `integer basis points 0–${MAX_BP}`;
  }
  if (Object.keys(problems).length) throw validationError('invalid tax rate patch', problems);
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const store = await lockStore(tx, storeId);
    const before = toTaxRate(await lockRate(tx, storeId, taxRateId));
    const r = await tx.query<TaxRateRow>(
      `UPDATE tax_rate SET name = coalesce($3, name), rate_bp = coalesce($4, rate_bp), updated_at = now()
       WHERE id = $1 AND store_id = $2 RETURNING ${COLS}`,
      [taxRateId, storeId, patch.name?.trim() ?? null, patch.rate_bp ?? null],
    );
    const after = toTaxRate(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'tax_rate.update',
      entityType: 'tax_rate',
      entityId: taxRateId,
      before,
      after,
    });
    await withEvents(tx, [await storeUpdatedEvent(store, organizationId, actor, ['tax_rates'])]);
    return after;
  });
}

/**
 * `DELETE /admin/stores/{storeId}/tax-rates/{taxRateId}` (store_admin): 204. 404 for a rate of another store.
 * 409 `conflict` `{ country, reason: 'last_rate_of_market_country' }` when the store is ACTIVE and this is the
 * last row of one of its market countries — decided under the store lock, so two deletes cannot both pass.
 */
export async function deleteTaxRate(
  client: ScopedClient,
  storeId: string,
  taxRateId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> {
  const organizationId = organizationOf(client);
  await client.transaction(async (tx) => {
    const store = await lockStore(tx, storeId);
    const rate = await lockRate(tx, storeId, taxRateId);
    if (store.status === 'active') {
      const markets = await marketCountries(tx, store);
      if (markets.includes(rate.country)) {
        const others = await tx.query(
          `SELECT 1 FROM tax_rate WHERE store_id = $1 AND country = $2 AND id <> $3 LIMIT 1`,
          [storeId, rate.country, taxRateId],
        );
        if (!others.rows[0]) {
          throw conflict(
            `the last tax rate of ${rate.country}, a market country of this active store, cannot be deleted`,
            { country: rate.country, reason: 'last_rate_of_market_country' },
          );
        }
      }
    }
    await tx.query(`DELETE FROM tax_rate WHERE id = $1 AND store_id = $2`, [taxRateId, storeId]);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'tax_rate.delete',
      entityType: 'tax_rate',
      entityId: taxRateId,
      before: toTaxRate(rate),
    });
    await withEvents(tx, [await storeUpdatedEvent(store, organizationId, actor, ['tax_rates'])]);
  });
}
