// Inventory module (issue #106): `on_hand` changes ONLY through `moveStock()` — one locked `inventory_level` row,
// one append-only `stock_movement` row (0009 revokes UPDATE/DELETE from the app role), one `stock.moved` v1 event,
// same transaction. Reservations (reservations.ts) never touch `on_hand`. The Admin API list/adjust services live
// here too. Guard: test/guards.test.ts fails on `UPDATE inventory_level` / `INSERT INTO stock_movement` elsewhere.
import type { Queryable, ScopedClient } from '@platform/db';
import { AppError, notFound, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type {
  AdminInventoryLevel,
  LevelRow,
  ListLevelsQuery,
  MoveStockInput,
  MoveStockResult,
  Page,
} from './types';

const LEVEL_COLS = `il.id, il.organization_id, il.store_id, il.variant_id, il.warehouse_id, il.on_hand, il.reserved,
  il.incoming, il.available, v.sku`;

export function toAdminLevel(l: LevelRow): AdminInventoryLevel {
  return {
    id: l.id,
    store_id: l.store_id,
    variant_id: l.variant_id,
    sku: l.sku,
    warehouse_id: l.warehouse_id,
    on_hand: l.on_hand,
    reserved: l.reserved,
    incoming: l.incoming,
    available: l.available,
  };
}

/**
 * The level row for (variant, warehouse), created at zero when missing (the variant must belong to the store and
 * the warehouse must exist), locked `FOR UPDATE` when `lock`.
 */
export async function ensureLevel(
  tx: Queryable,
  input: { organizationId: string; storeId: string; variantId: string; warehouseId: string },
  lock: boolean,
): Promise<LevelRow> {
  const variant = await tx.query<{ id: string }>(
    `SELECT id FROM product_variant WHERE id = $1 AND store_id = $2`,
    [input.variantId, input.storeId],
  );
  if (!variant.rows[0]) throw notFound('variant', input.variantId);
  const warehouse = await tx.query<{ id: string }>(
    `SELECT id FROM warehouse WHERE id = $1 AND is_active`,
    [input.warehouseId],
  );
  if (!warehouse.rows[0]) throw notFound('warehouse', input.warehouseId);
  await tx.query(
    `INSERT INTO inventory_level (organization_id, store_id, variant_id, warehouse_id, on_hand)
     VALUES ($1, $2, $3, $4, 0) ON CONFLICT (variant_id, warehouse_id) DO NOTHING`,
    [input.organizationId, input.storeId, input.variantId, input.warehouseId],
  );
  const r = await tx.query<LevelRow>(
    `SELECT ${LEVEL_COLS} FROM inventory_level il JOIN product_variant v ON v.id = il.variant_id
     WHERE il.variant_id = $1 AND il.warehouse_id = $2${lock ? ' FOR UPDATE OF il' : ''}`,
    [input.variantId, input.warehouseId],
  );
  return r.rows[0]!;
}

/**
 * Applies `delta` to `on_hand` of one level: row locked, `stock_movement` appended, `stock.moved` emitted — the only
 * writer of `on_hand`. `on_hand` may go negative only through `sale` (a backorder being shipped); any other reason
 * that would take it below zero → 409 `conflict`.
 */
export async function moveStock(tx: Queryable, input: MoveStockInput): Promise<MoveStockResult> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw validationError('delta must be a non-zero integer', { delta: 'non-zero integer' });
  }
  const before = await ensureLevel(tx, input, true);
  const onHandAfter = before.on_hand + input.delta;
  if (onHandAfter < 0 && input.reason !== 'sale') {
    throw new AppError('conflict', `on_hand would go negative (${before.on_hand} ${input.delta})`, {
      variant_id: input.variantId,
      warehouse_id: input.warehouseId,
      on_hand: before.on_hand,
      delta: input.delta,
    });
  }
  await tx.query(`UPDATE inventory_level SET on_hand = $2, updated_at = now() WHERE id = $1`, [
    before.id,
    onHandAfter,
  ]);
  const movement = await tx.query<{ id: string }>(
    `INSERT INTO stock_movement (organization_id, store_id, variant_id, warehouse_id, delta, reason, reference_type,
       reference_id, actor_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      input.organizationId,
      input.storeId,
      input.variantId,
      input.warehouseId,
      input.delta,
      input.reason,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.actor.id,
      input.note ?? null,
    ],
  );
  const movementId = movement.rows[0]!.id;
  await withEvents(tx, [
    await buildEvent({
      topic: 'stock.moved',
      organizationId: input.organizationId,
      storeId: input.storeId,
      aggregateType: 'stock_movement',
      aggregateId: movementId,
      actor: eventActor(input.actor),
      payload: {
        stock_movement_id: movementId,
        variant_id: input.variantId,
        sku: before.sku,
        warehouse_id: input.warehouseId,
        delta: input.delta,
        reason: input.reason,
        reference_type: input.referenceType ?? null,
        reference_id: input.referenceId ?? null,
        on_hand_after: onHandAfter,
        reserved_after: before.reserved,
      },
    }),
  ]);
  const level: LevelRow = {
    ...before,
    on_hand: onHandAfter,
    available: onHandAfter - before.reserved,
  };
  return { movementId, level };
}

/** `POST /admin/inventory/movements`: one movement on the caller's client (organization scope), 201 with the level. */
export async function createStockMovement(
  client: ScopedClient,
  input: Omit<MoveStockInput, 'storeId'> & { storeId?: string | undefined },
): Promise<AdminInventoryLevel> {
  return client.transaction(async (tx) => {
    const storeId =
      input.storeId ??
      (
        await tx.query<{ store_id: string }>(`SELECT store_id FROM product_variant WHERE id = $1`, [
          input.variantId,
        ])
      ).rows[0]?.store_id;
    if (!storeId) throw notFound('variant', input.variantId);
    const { level } = await moveStock(tx, { ...input, storeId });
    return toAdminLevel(level);
  });
}

const SORT_SQL: Record<NonNullable<ListLevelsQuery['sort']>, string> = {
  sku: 'v.sku',
  available: 'il.available',
  on_hand: 'il.on_hand',
};

/** `GET /admin/inventory/levels` on the caller's client (RLS = the stores the caller may see). */
export async function listInventoryLevels(
  client: ScopedClient,
  q: ListLevelsQuery = {},
): Promise<Page<AdminInventoryLevel>> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const where: string[] = ['w.is_active'];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (q.store_id) add('il.store_id = ?', q.store_id);
  if (q.warehouse_id) add('il.warehouse_id = ?', q.warehouse_id);
  if (q.variant_id) add('il.variant_id = ?', q.variant_id);
  if (q.sku?.trim()) add('v.sku ILIKE ?', `%${q.sku.trim()}%`);
  if (q.below_available !== undefined) add('il.available < ?', q.below_available);
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = q.sort
    ? `${SORT_SQL[q.sort]} ${dir}, v.sku ASC, w.priority ASC, w.code ASC`
    : 'v.sku ASC, w.priority ASC, w.code ASC';
  const clause = where.join(' AND ');
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_level il
       JOIN product_variant v ON v.id = il.variant_id JOIN warehouse w ON w.id = il.warehouse_id WHERE ${clause}`,
      params,
    );
    const rows = await tx.query<LevelRow>(
      `SELECT ${LEVEL_COLS} FROM inventory_level il
       JOIN product_variant v ON v.id = il.variant_id JOIN warehouse w ON w.id = il.warehouse_id
       WHERE ${clause} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    return {
      page,
      limit,
      total: Number(total.rows[0]?.n ?? 0),
      items: rows.rows.map(toAdminLevel),
    };
  });
}
