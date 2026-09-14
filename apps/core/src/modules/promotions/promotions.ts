// Promotion storage + admin operations + usage tracking + the reports provider (task 2.5, #138). The engine
// (engine.ts) is pure; this file loads and persists. `stackable` / `exclusive` and the buy-X-get-Y numbers
// live INSIDE the `rules` jsonb column (#189 "jsonb" decision) under the keys `stackable` / `exclusive` /
// `buy_quantity` / `get_quantity` / `get_discount_bp`; the API shape lifts the first two to top level.
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor, SYSTEM_ACTOR } from '../../lib/audit';
import { AppError, mapPgError, notFound, validationError } from '../../lib/errors';
import {
  normalizeCode,
  parsePromotionInput,
  parsePromotionPatch,
  type Promotion,
  type PromotionRules,
  type PromotionStatus,
} from './promotions-types';

interface Row {
  id: string;
  code: string | null;
  name: string;
  type: Promotion['type'];
  value: number;
  currency: string | null;
  rules: (PromotionRules & { stackable?: boolean; exclusive?: boolean }) | null;
  usage_limit: number | null;
  usage_count: number;
  per_customer_limit: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: PromotionStatus;
}

const COLS =
  'id, code, name, type, value, currency, rules, usage_limit, usage_count, per_customer_limit, starts_at, ends_at, status';

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function fromRow(r: Row): Promotion {
  const { stackable, exclusive, ...rules } = r.rules ?? {};
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    value: r.value,
    currency: r.currency ? r.currency.trim() : null,
    rules,
    usage_limit: r.usage_limit,
    usage_count: r.usage_count,
    per_customer_limit: r.per_customer_limit,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    status: r.status,
    stackable: stackable ?? false,
    exclusive: exclusive ?? false,
  };
}

function toRulesColumn(p: {
  rules?: PromotionRules;
  stackable?: boolean;
  exclusive?: boolean;
}): string {
  return JSON.stringify({
    ...(p.rules ?? {}),
    stackable: p.stackable ?? false,
    exclusive: p.exclusive ?? false,
  });
}

/** Every id in the rules must belong to the store; checked per table so the 400 names the offending list. */
async function assertRuleIds(tx: Queryable, storeId: string, rules: PromotionRules): Promise<void> {
  const checks: [string, string, string[] | undefined][] = [
    ['product', 'product_ids', rules.product_ids],
    ['product_category', 'category_ids', rules.category_ids],
    ['customer_group', 'customer_group_ids', rules.customer_group_ids],
    ['sales_channel', 'sales_channel_ids', rules.sales_channel_ids],
  ];
  for (const [table, field, ids] of checks) {
    if (!ids?.length) continue;
    const r = await tx.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE store_id = $1 AND id = ANY($2)`,
      [storeId, ids],
    );
    const found = new Set(r.rows.map((x) => x.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0)
      throw validationError(`${field} contain ids that do not belong to this store`, {
        [field]: missing,
      });
  }
}

export interface PromotionListQuery {
  page?: number;
  limit?: number;
  sort?: 'name' | 'code' | 'status' | 'starts_at' | 'created_at';
  order?: 'asc' | 'desc';
  status?: PromotionStatus;
}

export async function listPromotions(
  client: ScopedClient,
  storeId: string,
  q: PromotionListQuery = {},
): Promise<{ page: number; limit: number; total: number; items: Promotion[] }> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const sort = q.sort ?? 'created_at';
  const order = q.order === 'asc' ? 'ASC' : 'DESC';
  return client.transaction(async (tx) => {
    const params: unknown[] = [storeId];
    let where = 'store_id = $1';
    if (q.status) {
      params.push(q.status);
      where += ` AND status = $${params.length}`;
    }
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM promotion WHERE ${where}`,
      params,
    );
    const rows = await tx.query<Row>(
      `SELECT ${COLS} FROM promotion WHERE ${where}
       ORDER BY ${sort} ${order} NULLS LAST, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    return { page, limit, total: Number(total.rows[0]?.n ?? 0), items: rows.rows.map(fromRow) };
  });
}

export async function getPromotion(
  client: ScopedClient,
  storeId: string,
  id: string,
): Promise<Promotion> {
  const r = await client.query<Row>(
    `SELECT ${COLS} FROM promotion WHERE store_id = $1 AND id = $2`,
    [storeId, id],
  );
  if (!r.rows[0]) throw notFound('promotion', id);
  return fromRow(r.rows[0]);
}

export async function createPromotion(
  client: ScopedClient,
  storeId: string,
  body: unknown,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Promotion> {
  const input = parsePromotionInput(body);
  return client.transaction(async (tx) => {
    if (input.type === 'fixed_amount') {
      const cur = input.currency!.trim().toUpperCase();
      const c = await tx.query(
        `SELECT 1 FROM store_currency WHERE store_id = $1 AND currency = $2`,
        [storeId, cur],
      );
      if (c.rowCount === 0)
        throw validationError(`currency ${cur} is not enabled on this store`, { currency: cur });
    }
    await assertRuleIds(tx, storeId, input.rules ?? {});
    const r = await tx
      .query<Row>(
        `INSERT INTO promotion (organization_id, store_id, code, name, type, value, currency, rules, usage_limit, per_customer_limit, starts_at, ends_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13) RETURNING ${COLS}`,
        [
          client.context.organizationId,
          storeId,
          input.code ?? null,
          input.name,
          input.type,
          input.value ?? 0,
          input.type === 'fixed_amount'
            ? input.currency!.trim().toUpperCase()
            : (input.currency ?? null),
          toRulesColumn(input),
          input.usage_limit ?? null,
          input.per_customer_limit ?? null,
          input.starts_at ?? null,
          input.ends_at ?? null,
          input.status ?? 'draft',
        ],
      )
      .catch((err) => mapPgError(err, `promotion "${input.code ?? input.name}"`));
    const created = fromRow(r.rows[0]!);
    await writeAudit(tx, {
      organizationId: client.context.organizationId,
      storeId,
      actor,
      action: 'promotion.create',
      entityType: 'promotion',
      entityId: created.id,
      after: created,
    });
    return created;
  });
}

export async function updatePromotion(
  client: ScopedClient,
  storeId: string,
  id: string,
  body: unknown,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Promotion> {
  return client.transaction(async (tx) => {
    const cur = await tx.query<Row>(
      `SELECT ${COLS} FROM promotion WHERE store_id = $1 AND id = $2 FOR UPDATE`,
      [storeId, id],
    );
    if (!cur.rows[0]) throw notFound('promotion', id);
    const before = fromRow(cur.rows[0]);
    const patch = parsePromotionPatch(body, before);
    if (patch.rules) await assertRuleIds(tx, storeId, patch.rules);
    const merged = { ...before, ...patch, rules: patch.rules ?? before.rules };
    const r = await tx.query<Row>(
      `UPDATE promotion SET name = $3, value = $4, currency = $5, rules = $6::jsonb, usage_limit = $7,
              per_customer_limit = $8, starts_at = $9, ends_at = $10, status = $11
       WHERE store_id = $1 AND id = $2 RETURNING ${COLS}`,
      [
        storeId,
        id,
        merged.name,
        merged.value,
        merged.currency,
        toRulesColumn(merged),
        merged.usage_limit,
        merged.per_customer_limit,
        merged.starts_at,
        merged.ends_at,
        merged.status,
      ],
    );
    const after = fromRow(r.rows[0]!);
    await writeAudit(tx, {
      organizationId: client.context.organizationId,
      storeId,
      actor,
      action: 'promotion.update',
      entityType: 'promotion',
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

/** Active promotions the engine should consider: every automatic one plus the ones matching `codes`. */
export async function loadCandidatePromotions(
  db: Queryable | ScopedClient,
  storeId: string,
  codes: string[] = [],
): Promise<Promotion[]> {
  const normalized = [...new Set(codes.map(normalizeCode).filter(Boolean))];
  const r = await db.query<Row>(
    `SELECT ${COLS} FROM promotion WHERE store_id = $1 AND (code IS NULL OR code = ANY($2))`,
    [storeId, normalized],
  );
  return r.rows.map(fromRow);
}

/**
 * Counts one use, atomically refusing past the limit (`conflict`, the contract error of #138's "usage limit
 * reached"). The cart calls it at order placement, inside the placement transaction, once per applied
 * promotion — so a failed placement never burns a use.
 */
export async function recordPromotionUse(
  tx: Queryable,
  storeId: string,
  promotionId: string,
): Promise<void> {
  const r = await tx.query(
    `UPDATE promotion SET usage_count = usage_count + 1
     WHERE store_id = $1 AND id = $2 AND (usage_limit IS NULL OR usage_count < usage_limit)`,
    [storeId, promotionId],
  );
  if ((r.rowCount ?? 0) === 0) {
    const exists = await tx.query(`SELECT 1 FROM promotion WHERE store_id = $1 AND id = $2`, [
      storeId,
      promotionId,
    ]);
    if (exists.rowCount === 0) throw notFound('promotion', promotionId);
    throw new AppError('conflict', 'promotion usage limit reached', { promotion_id: promotionId });
  }
}

// ------------------------------------------------------------------------------------------------- reports

export interface PromotionReportItem {
  promotion_id: string;
  code: string;
  uses: number;
  discount_given: { amount_minor: number; currency: string };
  revenue: { amount_minor: number; currency: string };
}

/**
 * Data provider for `getPromotionReport` (window 17 owns the route; it calls this through the module public
 * API). Per coupon code over non-cancelled orders placed in [from, to): uses, discount given and revenue —
 * read from the `"order"` read model (`promotion_codes`, `discount_minor`, `total_minor`; window 1's table,
 * reads are allowed). An order with several codes counts its full discount and revenue under each (documented
 * caveat: per-code attribution of a shared discount is not stored).
 */
export async function promotionReportData(
  client: ScopedClient,
  storeId: string,
  from: Date,
  to: Date,
): Promise<{ from: string; to: string; currency: string; items: PromotionReportItem[] }> {
  return client.transaction(async (tx) => {
    const store = await tx.query<{ default_currency: string }>(
      `SELECT default_currency FROM store WHERE id = $1`,
      [storeId],
    );
    const currency = (store.rows[0]?.default_currency ?? 'EUR').trim();
    const r = await tx.query<{
      code: string;
      uses: string;
      discount: string;
      revenue: string;
    }>(
      `SELECT code, count(*)::text AS uses, coalesce(sum(o.discount_minor), 0)::text AS discount,
              coalesce(sum(o.total_minor), 0)::text AS revenue
       FROM "order" o, unnest(o.promotion_codes) AS code
       WHERE o.store_id = $1 AND o.placed_at >= $2 AND o.placed_at < $3 AND o.status <> 'cancelled'
       GROUP BY code ORDER BY code`,
      [storeId, from, to],
    );
    const promos = await tx.query<{ id: string; code: string }>(
      `SELECT id, code FROM promotion WHERE store_id = $1 AND code IS NOT NULL`,
      [storeId],
    );
    const idByCode = new Map(promos.rows.map((p) => [p.code, p.id]));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      currency,
      items: r.rows.map((row) => ({
        promotion_id: idByCode.get(row.code) ?? '00000000-0000-4000-8000-000000000000',
        code: row.code,
        uses: Number(row.uses),
        discount_given: { amount_minor: Number(row.discount), currency },
        revenue: { amount_minor: Number(row.revenue), currency },
      })),
    };
  });
}
