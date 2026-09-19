// Price lists (task 2.4, #137) — the pricing half of the promotions module (placement decided with the manager
// 2026-09-08: price lists live here because window 9 owns `modules/promotions/**` and the cart consumes both
// halves through this module's index.ts). Admin operations per admin-api.yaml (`listPriceLists`,
// `createPriceList`, `upsertPrices` — they exist in contracts-v0.3, so permissions and body schemas come from
// the spec, no contract change) and the resolution used by cart pricing: sale > group (override) > default,
// higher priority first within a rank, expired/draft/out-of-window lists ignored, group lists only with the
// customer's group. Money is integer minor units; `price.currency` always equals the list's currency.
import type { AdminComponents } from '@platform/contracts';
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor, SYSTEM_ACTOR } from '../../lib/audit';
import { mapPgError, notFound, validationError } from '../../lib/errors';

export type PriceList = AdminComponents['schemas']['PriceList'];
export type PriceListInput = AdminComponents['schemas']['PriceListInput'];
export type PriceListType = PriceList['type'];

export interface PriceUpsertRow {
  variant_id: string;
  amount_minor: number;
  compare_at_minor?: number | null;
  min_quantity?: number;
}

interface ListRow {
  id: string;
  code: string;
  name: string;
  type: PriceListType;
  currency: string;
  customer_group_id: string | null;
  sales_channel_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: NonNullable<PriceList['status']>;
  priority: number;
}

const LIST_COLS =
  'id, code, name, type, currency, customer_group_id, sales_channel_id, starts_at, ends_at, status, priority';

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function toContract(r: ListRow): PriceList {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    currency: r.currency.trim(),
    customer_group_id: r.customer_group_id,
    sales_channel_id: r.sales_channel_id,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    status: r.status,
    priority: r.priority,
  };
}

async function assertCurrencyEnabled(
  tx: Queryable,
  storeId: string,
  currency: string,
): Promise<string> {
  const cur = currency.trim().toUpperCase();
  const r = await tx.query(`SELECT 1 FROM store_currency WHERE store_id = $1 AND currency = $2`, [
    storeId,
    cur,
  ]);
  if (r.rowCount === 0)
    throw validationError(`currency ${cur} is not enabled on this store`, { currency: cur });
  return cur;
}

/** All price lists of the store (any status), defaults first, then by priority. */
export async function listPriceLists(client: ScopedClient, storeId: string): Promise<PriceList[]> {
  const r = await client.query<ListRow>(
    `SELECT ${LIST_COLS} FROM price_list WHERE store_id = $1
     ORDER BY (type = 'default') DESC, currency, priority DESC, code`,
    [storeId],
  );
  return r.rows.map(toContract);
}

/**
 * Creates a list. 400: currency not enabled on the store, foreign customer group / sales channel, bad window.
 * 409 (unique constraints): duplicate code, second `default` list for a (store, currency).
 */
export async function createPriceList(
  client: ScopedClient,
  storeId: string,
  input: PriceListInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<PriceList> {
  return client.transaction(async (tx) => {
    const currency = await assertCurrencyEnabled(tx, storeId, input.currency);
    if (input.customer_group_id) {
      const g = await tx.query(`SELECT 1 FROM customer_group WHERE store_id = $1 AND id = $2`, [
        storeId,
        input.customer_group_id,
      ]);
      if (g.rowCount === 0)
        throw validationError('customer group does not belong to this store', {
          customer_group_id: input.customer_group_id,
        });
    }
    if (input.sales_channel_id) {
      const c = await tx.query(`SELECT 1 FROM sales_channel WHERE store_id = $1 AND id = $2`, [
        storeId,
        input.sales_channel_id,
      ]);
      if (c.rowCount === 0)
        throw validationError('sales channel does not belong to this store', {
          sales_channel_id: input.sales_channel_id,
        });
    }
    if (input.starts_at && input.ends_at && new Date(input.ends_at) <= new Date(input.starts_at))
      throw validationError('ends_at must be after starts_at', { ends_at: input.ends_at });
    const r = await tx
      .query<ListRow>(
        `INSERT INTO price_list (organization_id, store_id, code, name, type, currency, customer_group_id, sales_channel_id, starts_at, ends_at, status, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${LIST_COLS}`,
        [
          client.context.organizationId,
          storeId,
          input.code,
          input.name,
          input.type,
          currency,
          input.customer_group_id ?? null,
          input.sales_channel_id ?? null,
          input.starts_at ?? null,
          input.ends_at ?? null,
          input.status ?? 'active',
          input.priority ?? 0,
        ],
      )
      .catch((err) => mapPgError(err, `price list "${input.code}"`));
    const created = toContract(r.rows[0]!);
    await writeAudit(tx, {
      organizationId: client.context.organizationId,
      storeId,
      actor,
      action: 'price_list.create',
      entityType: 'price_list',
      entityId: created.id,
      after: created,
    });
    return created;
  });
}

/**
 * Bulk upsert on (price_list_id, variant_id, min_quantity). Every variant must belong to the store; duplicate
 * (variant, min_quantity) pairs in the payload are a 400; `price.currency` is forced to the list's currency.
 * Idempotent. Returns the number of rows written.
 */
export async function upsertPrices(
  client: ScopedClient,
  storeId: string,
  priceListId: string,
  rows: PriceUpsertRow[],
  actor: Actor = SYSTEM_ACTOR,
): Promise<{ upserted: number }> {
  return client.transaction(async (tx) => {
    const list = await tx.query<ListRow>(
      `SELECT ${LIST_COLS} FROM price_list WHERE store_id = $1 AND id = $2`,
      [storeId, priceListId],
    );
    const l = list.rows[0];
    if (!l) throw notFound('price list', priceListId);

    const problems: Record<string, string> = {};
    const seen = new Set<string>();
    for (const [i, p] of rows.entries()) {
      if (!Number.isInteger(p.amount_minor) || p.amount_minor < 0)
        problems[`prices.${i}.amount_minor`] = 'integer minor units >= 0';
      if (
        p.compare_at_minor != null &&
        (!Number.isInteger(p.compare_at_minor) || p.compare_at_minor < 0)
      )
        problems[`prices.${i}.compare_at_minor`] = 'integer minor units >= 0';
      const q = p.min_quantity ?? 1;
      if (!Number.isInteger(q) || q < 1) problems[`prices.${i}.min_quantity`] = 'integer >= 1';
      const key = `${p.variant_id}:${q}`;
      if (seen.has(key))
        problems[`prices.${i}`] = 'duplicate (variant_id, min_quantity) in payload';
      seen.add(key);
    }
    if (Object.keys(problems).length > 0) throw validationError('invalid prices', problems);

    const variantIds = [...new Set(rows.map((p) => p.variant_id))];
    if (variantIds.length > 0) {
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM product_variant WHERE store_id = $1 AND id = ANY($2)`,
        [storeId, variantIds],
      );
      const ok = new Set(found.rows.map((x) => x.id));
      const missing = variantIds.filter((id) => !ok.has(id));
      if (missing.length > 0)
        throw validationError('variant ids do not belong to this store', { variant_ids: missing });
    }

    for (const p of rows) {
      await tx.query(
        `INSERT INTO price (organization_id, store_id, price_list_id, variant_id, currency, amount_minor, compare_at_minor, min_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (price_list_id, variant_id, min_quantity)
         DO UPDATE SET amount_minor = EXCLUDED.amount_minor, compare_at_minor = EXCLUDED.compare_at_minor`,
        [
          client.context.organizationId,
          storeId,
          priceListId,
          p.variant_id,
          l.currency,
          p.amount_minor,
          p.compare_at_minor ?? null,
          p.min_quantity ?? 1,
        ],
      );
    }
    await writeAudit(tx, {
      organizationId: client.context.organizationId,
      storeId,
      actor,
      action: 'price.upsert',
      entityType: 'price_list',
      entityId: priceListId,
      after: { count: rows.length, variant_ids: variantIds },
    });
    return { upserted: rows.length };
  });
}

// ------------------------------------------------------------------------------------------------ resolution

export interface ResolveQuery {
  variantIds: string[];
  currency: string;
  /** Line quantity for tiered prices (min_quantity); default 1. */
  quantity?: number;
  /** The customer's groups; a list bound to a group applies only when its group is here. */
  customerGroupIds?: string[];
  salesChannelId?: string | null;
  /** Evaluation time; default now. */
  at?: Date;
}

export interface ResolvedPrice {
  variant_id: string;
  amount_minor: number;
  compare_at_minor: number | null;
  currency: string;
  price_list_id: string;
  list_type: PriceListType;
}

interface CandidateRow {
  variant_id: string;
  amount_minor: string;
  compare_at_minor: string | null;
  min_quantity: number;
  price_list_id: string;
  type: PriceListType;
  customer_group_id: string | null;
  sales_channel_id: string | null;
  priority: number;
}

const TYPE_RANK: Record<PriceListType, number> = { sale: 3, override: 2, default: 1 };

/**
 * The effective price per variant. Applicable lists: status `active`, matching currency, inside the date
 * window at `at`, group list only when the customer has the group, channel list only on that channel. Rank:
 * sale > override ("group list") > default; within a rank, higher `priority` first; within a list the row with
 * the greatest `min_quantity <= quantity` wins; remaining ties break on the lower amount, then list id
 * (deterministic). A variant with no applicable price in `currency` is absent from the result — not sellable.
 * Runs on the caller's client (one statement), so the cart can call it inside its own transaction via `tx`.
 */
export async function resolvePrices(
  db: Queryable | ScopedClient,
  storeId: string,
  q: ResolveQuery,
): Promise<Map<string, ResolvedPrice>> {
  const out = new Map<string, ResolvedPrice>();
  if (q.variantIds.length === 0) return out;
  const at = q.at ?? new Date();
  const quantity = Math.max(1, q.quantity ?? 1);
  const groups = q.customerGroupIds ?? [];
  const currency = q.currency.trim().toUpperCase();
  const r = await db.query<CandidateRow>(
    `SELECT pr.variant_id, pr.amount_minor::text, pr.compare_at_minor::text, pr.min_quantity,
            pl.id AS price_list_id, pl.type, pl.customer_group_id, pl.sales_channel_id, pl.priority
     FROM price pr
     JOIN price_list pl ON pl.id = pr.price_list_id
     WHERE pl.store_id = $1 AND pl.status = 'active' AND pl.currency = $2 AND pr.currency = $2
       AND (pl.starts_at IS NULL OR pl.starts_at <= $3)
       AND (pl.ends_at IS NULL OR pl.ends_at > $3)
       AND pr.variant_id = ANY($4) AND pr.min_quantity <= $5`,
    [storeId, currency, at, q.variantIds, quantity],
  );
  const applicable = r.rows.filter(
    (row) =>
      (row.customer_group_id === null || groups.includes(row.customer_group_id)) &&
      (row.sales_channel_id === null || row.sales_channel_id === q.salesChannelId),
  );
  // best row per (variant, list): the greatest min_quantity <= quantity
  const best = new Map<string, CandidateRow>();
  for (const row of applicable) {
    const key = `${row.variant_id}:${row.price_list_id}`;
    const cur = best.get(key);
    if (!cur || row.min_quantity > cur.min_quantity) best.set(key, row);
  }
  // best list per variant: type rank, priority, amount, id
  const winner = new Map<string, CandidateRow>();
  for (const row of best.values()) {
    const cur = winner.get(row.variant_id);
    if (!cur) {
      winner.set(row.variant_id, row);
      continue;
    }
    const byRank = TYPE_RANK[row.type] - TYPE_RANK[cur.type];
    const byPriority = row.priority - cur.priority;
    const byAmount = Number(cur.amount_minor) - Number(row.amount_minor);
    if (
      byRank > 0 ||
      (byRank === 0 && byPriority > 0) ||
      (byRank === 0 && byPriority === 0 && byAmount > 0) ||
      (byRank === 0 && byPriority === 0 && byAmount === 0 && row.price_list_id < cur.price_list_id)
    )
      winner.set(row.variant_id, row);
  }
  for (const [variantId, row] of winner) {
    out.set(variantId, {
      variant_id: variantId,
      amount_minor: Number(row.amount_minor),
      compare_at_minor: row.compare_at_minor === null ? null : Number(row.compare_at_minor),
      currency,
      price_list_id: row.price_list_id,
      list_type: row.type,
    });
  }
  return out;
}
