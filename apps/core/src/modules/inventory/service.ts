// Inventory module on the SHARED STOCK POOL (#456; db 0190 + 0191, CONTRACT CHANGE #453). Stock lies per
// (stock item, warehouse) — a pool row in `inventory_level` — and every variant that maps the item sells from it,
// whichever store the variant belongs to. A store's variants are the only way into the pool: every function here
// resolves variant → `stock_item_id` first, and row security lets a store session reach a pool row only for an
// item one of its own variants maps.
//
// `on_hand` changes ONLY through `moveStock()` — one locked pool row, one append-only `stock_movement` row (0009
// revokes UPDATE/DELETE from the app role), one `stock.moved` v2 event, same transaction. Reservations
// (reservations.ts) never touch `on_hand`.
//
// ATTRIBUTION (the ledger policy, `pool_ledger`): a movement a store caused carries that store's `store_id` and
// `variant_id` and is written in that store's scope; a movement no store caused carries neither and can only be
// written in organization scope. This module NEVER changes the scope it is given: it writes what the caller's
// transaction is allowed to write and lets the database refuse the rest.
//
// Guard: test/guards.test.ts fails on `UPDATE inventory_level` / `INSERT INTO stock_movement` elsewhere.
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type {
  AdminInventoryLevel,
  AdminStockItem,
  AdminStockMovement,
  AdminStockReservation,
  LevelRow,
  ListLevelsQuery,
  ListStockItemMovementsQuery,
  ListStockItemReservationsQuery,
  ListStockItemsQuery,
  MoveStockInput,
  MoveStockResult,
  Page,
  PoolLevel,
} from './types';

const POOL_COLS = `il.id, il.organization_id, il.stock_item_id, il.warehouse_id, il.on_hand, il.reserved,
  il.incoming, il.available, si.sku AS item_sku`;

/** One row per (variant, warehouse): the variant's identity with the numbers of its item's pool row. */
const LEVEL_COLS = `il.id, il.organization_id, v.store_id, v.id AS variant_id, il.stock_item_id, il.warehouse_id,
  il.on_hand, il.reserved, il.incoming, il.available, v.sku`;

export function toAdminLevel(l: LevelRow): AdminInventoryLevel {
  return {
    id: l.id,
    store_id: l.store_id,
    variant_id: l.variant_id,
    stock_item_id: l.stock_item_id,
    sku: l.sku,
    warehouse_id: l.warehouse_id,
    on_hand: l.on_hand,
    reserved: l.reserved,
    incoming: l.incoming,
    available: l.available,
  };
}

export interface VariantStock {
  variantId: string;
  storeId: string;
  stockItemId: string;
  sku: string;
  manageInventory: boolean;
  allowBackorder: boolean;
}

/**
 * Variant → stock item, with a SHARE lock on the variant rows (in id order) for the rest of the transaction: a
 * re-mapping (`mapVariantToStockItem`, which takes the row FOR UPDATE) cannot slip in between reading the item
 * and writing a reservation or a movement on it — it waits, and then sees what this transaction wrote. `storeId`
 * limits the lookup to that store's variants; in store scope row security does so anyway, and another store's
 * variant is simply absent from the result.
 */
export async function variantStock(
  tx: Queryable,
  variantIds: readonly string[],
  storeId?: string | undefined,
): Promise<Map<string, VariantStock>> {
  if (variantIds.length === 0) return new Map();
  const r = await tx.query<{
    id: string;
    store_id: string;
    stock_item_id: string;
    sku: string;
    manage_inventory: boolean;
    allow_backorder: boolean;
  }>(
    `SELECT id, store_id, stock_item_id, sku, manage_inventory, allow_backorder FROM product_variant
     WHERE id = ANY($1) AND ($2::uuid IS NULL OR store_id = $2) ORDER BY id FOR SHARE`,
    [[...new Set(variantIds)].sort(), storeId ?? null],
  );
  return new Map(
    r.rows.map((v) => [
      v.id,
      {
        variantId: v.id,
        storeId: v.store_id,
        stockItemId: v.stock_item_id,
        sku: v.sku,
        manageInventory: v.manage_inventory,
        allowBackorder: v.allow_backorder,
      },
    ]),
  );
}

/**
 * The pool row for (stock item, warehouse), created at zero when missing (the warehouse must be active), locked
 * `FOR UPDATE` when `lock`. In store scope the INSERT and the SELECT pass row security only for an item one of
 * the session's variants maps: for any other item the database refuses the insert and shows no row — the caller
 * gets 404, nothing is written.
 */
export async function ensureLevel(
  tx: Queryable,
  input: { organizationId: string; stockItemId: string; warehouseId: string },
  lock: boolean,
): Promise<PoolLevel> {
  const warehouse = await tx.query<{ id: string }>(
    `SELECT id FROM warehouse WHERE id = $1 AND is_active`,
    [input.warehouseId],
  );
  if (!warehouse.rows[0]) throw notFound('warehouse', input.warehouseId);
  // The item must be visible to this session BEFORE the insert is tried: in store scope an unmapped item is
  // not, and answering 404 here keeps the transaction usable (a refused INSERT would abort it).
  const item = await tx.query<{ id: string }>(`SELECT id FROM stock_item WHERE id = $1`, [
    input.stockItemId,
  ]);
  if (!item.rows[0]) throw notFound('stock item', input.stockItemId);
  await tx.query(
    `INSERT INTO inventory_level (organization_id, stock_item_id, warehouse_id, on_hand)
     VALUES ($1, $2, $3, 0) ON CONFLICT (stock_item_id, warehouse_id) DO NOTHING`,
    [input.organizationId, input.stockItemId, input.warehouseId],
  );
  const r = await tx.query<PoolLevel>(
    `SELECT ${POOL_COLS} FROM inventory_level il JOIN stock_item si ON si.id = il.stock_item_id
     WHERE il.stock_item_id = $1 AND il.warehouse_id = $2${lock ? ' FOR UPDATE OF il' : ''}`,
    [input.stockItemId, input.warehouseId],
  );
  if (!r.rows[0]) throw notFound('stock item', input.stockItemId);
  return r.rows[0];
}

/**
 * Applies `delta` to `on_hand` of one pool row: row locked, `stock_movement` appended, `stock.moved` v2 emitted —
 * the only writer of `on_hand`. `on_hand` may go negative only through `sale` (a backorder being shipped); any
 * other reason that would take it below zero → 409 `conflict`.
 *
 * With `storeId` + `variantId` the movement is ATTRIBUTED to that store (and lands on the variant's item); with
 * neither it is a pool movement no store caused and needs `stockItemId` — see `MoveStockInput`. The scope is the
 * caller's: the database refuses a store-less movement, or one for another store, outside organization scope.
 */
export async function moveStock(tx: Queryable, input: MoveStockInput): Promise<MoveStockResult> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw validationError('delta must be a non-zero integer', { delta: 'non-zero integer' });
  }
  const storeId = input.storeId ?? null;
  const variantId = input.variantId ?? null;
  if ((storeId === null) !== (variantId === null)) {
    throw validationError('a movement is attributed to a store AND its variant, or to neither', {
      store_id: storeId === null ? 'required with variant_id' : 'given',
      variant_id: variantId === null ? 'required with store_id' : 'given',
    });
  }
  let stockItemId = input.stockItemId;
  if (variantId !== null && storeId !== null) {
    const variant = (await variantStock(tx, [variantId], storeId)).get(variantId);
    if (!variant) throw notFound('variant', variantId);
    if (stockItemId !== undefined && stockItemId !== variant.stockItemId) {
      // Only reachable from inside this module (a shipment's ledger rows name the item they moved).
      throw conflict('the variant no longer maps the stock item this movement belongs to', {
        variant_id: variantId,
        stock_item_id: stockItemId,
        current_stock_item_id: variant.stockItemId,
      });
    }
    stockItemId = variant.stockItemId;
  }
  if (stockItemId === undefined) {
    throw validationError('a movement without a store needs the stock item', {
      stock_item_id: 'required',
    });
  }

  const before = await ensureLevel(
    tx,
    { organizationId: input.organizationId, stockItemId, warehouseId: input.warehouseId },
    true,
  );
  const onHandAfter = before.on_hand + input.delta;
  if (onHandAfter < 0 && input.reason !== 'sale') {
    throw new AppError('conflict', `on_hand would go negative (${before.on_hand} ${input.delta})`, {
      ...(variantId !== null ? { variant_id: variantId } : {}),
      stock_item_id: stockItemId,
      warehouse_id: input.warehouseId,
      on_hand: before.on_hand,
      delta: input.delta,
    });
  }
  await tx.query(`UPDATE inventory_level SET on_hand = $2, updated_at = now() WHERE id = $1`, [
    before.id,
    onHandAfter,
  ]);
  const movement = await tx
    .query<{ id: string }>(
      `INSERT INTO stock_movement (organization_id, store_id, variant_id, stock_item_id, warehouse_id, delta, reason,
         reference_type, reference_id, actor_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        input.organizationId,
        storeId,
        variantId,
        stockItemId,
        input.warehouseId,
        input.delta,
        input.reason,
        input.referenceType ?? null,
        input.referenceId ?? null,
        input.actor.id,
        input.note ?? null,
      ],
    )
    .catch((err: unknown) => {
      // The ledger policy (`pool_ledger`) refused the row: a movement without a store, or for another store,
      // written outside organization scope. The transaction is aborted either way; say why instead of a 500.
      if ((err as { code?: string }).code === '42501') {
        throw new AppError(
          'forbidden',
          storeId === null
            ? 'a stock movement no store caused can only be written in organization scope'
            : 'a stock movement can only be attributed to a store of the session',
        );
      }
      throw err;
    });
  const movementId = movement.rows[0]!.id;
  await withEvents(tx, [
    await buildEvent({
      topic: 'stock.moved',
      organizationId: input.organizationId,
      storeId, // null for a pool movement no store caused: only organization scope can write that outbox row
      aggregateType: 'stock_movement',
      aggregateId: movementId,
      actor: eventActor(input.actor),
      payload: {
        stock_movement_id: movementId,
        stock_item_id: stockItemId,
        sku: before.item_sku,
        ...(variantId !== null && storeId !== null
          ? { variant_id: variantId, store_id: storeId }
          : {}),
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
  const level: PoolLevel = {
    ...before,
    on_hand: onHandAfter,
    available: onHandAfter - before.reserved,
  };
  return { movementId, level };
}

function requireOrganizationScope(client: ScopedClient, what: string): void {
  if (client.scope !== 'organization') {
    throw new AppError('forbidden', `${what} requires organization scope`);
  }
}

/**
 * `POST /admin/inventory/movements` (HQ, `operations`; organization scope): addressed by variant, the movement
 * lands on that variant's stock item. It is a pool movement NO STORE CAUSED (a receipt, an adjustment, a
 * transfer, a cycle count), so it is written without attribution — `store_id` / `variant_id` NULL, envelope store
 * null — and one audit row (`stock_movement.create`) keeps the variant it was addressed by. 201 with the variant's
 * `InventoryLevel` (the pool row's numbers).
 */
export async function createStockMovement(
  client: ScopedClient,
  input: Omit<MoveStockInput, 'storeId' | 'stockItemId'> & { variantId: string },
): Promise<AdminInventoryLevel> {
  requireOrganizationScope(client, 'createStockMovement');
  return client.transaction(async (tx) => {
    const variant = (await variantStock(tx, [input.variantId])).get(input.variantId);
    if (!variant) throw notFound('variant', input.variantId);
    const { level, movementId } = await moveStock(tx, {
      ...input,
      storeId: null,
      variantId: null,
      stockItemId: variant.stockItemId,
    });
    // The ledger row is store-less by design, so the audit row is where the variant the movement was ADDRESSED
    // BY stays on record (manager decision D4, 2026-10-12). An HQ act: no store on the audit row either.
    await writeAudit(tx, {
      organizationId: input.organizationId,
      storeId: null,
      actor: input.actor,
      action: 'stock_movement.create',
      entityType: 'stock_movement',
      entityId: movementId,
      after: {
        addressed_variant_id: variant.variantId,
        addressed_store_id: variant.storeId,
        stock_item_id: variant.stockItemId,
        warehouse_id: input.warehouseId,
        delta: input.delta,
        reason: input.reason,
      },
    });
    return toAdminLevel({
      id: level.id,
      organization_id: level.organization_id,
      store_id: variant.storeId,
      variant_id: variant.variantId,
      stock_item_id: level.stock_item_id,
      warehouse_id: level.warehouse_id,
      on_hand: level.on_hand,
      reserved: level.reserved,
      incoming: level.incoming,
      available: level.available,
      sku: variant.sku,
    });
  });
}

/**
 * What each variant can sell right now: the sum of `available` over the ACTIVE warehouses of its stock item's
 * pool rows (0 when it has none). Two variants that map one item get the same number. The one read other modules
 * use for availability (cart, marketing feeds, search records) — nobody else joins the pool tables.
 */
export async function availableByVariant(
  tx: Queryable,
  variantIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>(variantIds.map((id) => [id, 0]));
  if (variantIds.length === 0) return out;
  const r = await tx.query<{ variant_id: string; available: number }>(
    `SELECT v.id AS variant_id, coalesce(sum(il.available), 0)::int AS available
     FROM product_variant v
     JOIN inventory_level il ON il.stock_item_id = v.stock_item_id
     JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
     WHERE v.id = ANY($1) GROUP BY v.id`,
    [[...new Set(variantIds)]],
  );
  for (const row of r.rows) out.set(row.variant_id, row.available);
  return out;
}

const SORT_SQL: Record<NonNullable<ListLevelsQuery['sort']>, string> = {
  sku: 'v.sku',
  available: 'il.available',
  on_hand: 'il.on_hand',
};

/**
 * `GET /admin/inventory/levels` on the caller's client: one row per (variant, warehouse) of the variants the
 * caller may see, each with the numbers of its item's pool row. Two variants that share an item show the same
 * numbers (and the same `id`) — never sum across variants.
 */
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
  if (q.store_id) add('v.store_id = ?', q.store_id);
  if (q.warehouse_id) add('il.warehouse_id = ?', q.warehouse_id);
  if (q.variant_id) add('v.id = ?', q.variant_id);
  if (q.sku?.trim()) add('v.sku ILIKE ?', `%${q.sku.trim()}%`);
  if (q.below_available !== undefined) add('il.available < ?', q.below_available);
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const tie = 'v.sku ASC, w.priority ASC, w.code ASC, v.id ASC';
  const orderBy = q.sort ? `${SORT_SQL[q.sort]} ${dir}, ${tie}` : tie;
  const clause = where.join(' AND ');
  const from = `FROM product_variant v
       JOIN inventory_level il ON il.stock_item_id = v.stock_item_id
       JOIN warehouse w ON w.id = il.warehouse_id`;
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n ${from} WHERE ${clause}`,
      params,
    );
    const rows = await tx.query<LevelRow>(
      `SELECT ${LEVEL_COLS} ${from}
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

// ------------------------------------------------------------------------------------------------ stock items

async function loadStockItems(tx: Queryable, ids: readonly string[]): Promise<AdminStockItem[]> {
  if (ids.length === 0) return [];
  const items = await tx.query<{ id: string; sku: string; name: string; barcode: string | null }>(
    `SELECT id, sku, name, barcode FROM stock_item WHERE id = ANY($1)`,
    [ids],
  );
  const variants = await tx.query<{
    stock_item_id: string;
    variant_id: string;
    store_id: string;
    sku: string;
  }>(
    `SELECT stock_item_id, id AS variant_id, store_id, sku FROM product_variant
     WHERE stock_item_id = ANY($1) ORDER BY store_id, sku, id`,
    [ids],
  );
  const levels = await tx.query<{
    stock_item_id: string;
    warehouse_id: string;
    on_hand: number;
    reserved: number;
    incoming: number;
    available: number;
  }>(
    `SELECT il.stock_item_id, il.warehouse_id, il.on_hand, il.reserved, il.incoming, il.available
     FROM inventory_level il JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
     WHERE il.stock_item_id = ANY($1) ORDER BY w.priority, w.code`,
    [ids],
  );
  const byId = new Map(items.rows.map((i) => [i.id, i]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const item = byId.get(id)!;
      return {
        id: item.id,
        sku: item.sku,
        name: item.name,
        barcode: item.barcode,
        variants: variants.rows
          .filter((v) => v.stock_item_id === id)
          .map((v) => ({ variant_id: v.variant_id, store_id: v.store_id, sku: v.sku })),
        levels: levels.rows
          .filter((l) => l.stock_item_id === id)
          .map((l) => ({
            warehouse_id: l.warehouse_id,
            on_hand: l.on_hand,
            reserved: l.reserved,
            incoming: l.incoming,
            available: l.available,
          })),
      };
    });
}

/**
 * `GET /admin/stock-items` (viewer on `organization:hq`; organization scope): the organization's stock items by
 * sku, each with the variants mapped to it and the pool level per active warehouse.
 */
export async function listStockItems(
  client: ScopedClient,
  q: ListStockItemsQuery = {},
): Promise<Page<AdminStockItem>> {
  requireOrganizationScope(client, 'listStockItems');
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const where: string[] = ['true'];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace(/\?/g, `$${params.length}`));
  };
  if (q.sku?.trim()) add('si.sku ILIKE ?', `%${q.sku.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (q.store_id) {
    add(
      'EXISTS (SELECT 1 FROM product_variant v WHERE v.stock_item_id = si.id AND v.store_id = ?)',
      q.store_id,
    );
  }
  if (q.shared === true) {
    where.push(
      '(SELECT count(DISTINCT v.store_id) FROM product_variant v WHERE v.stock_item_id = si.id) > 1',
    );
  }
  const clause = where.join(' AND ');
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_item si WHERE ${clause}`,
      params,
    );
    const ids = await tx.query<{ id: string }>(
      `SELECT si.id FROM stock_item si WHERE ${clause} ORDER BY si.sku, si.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    return {
      page,
      limit,
      total: Number(total.rows[0]?.n ?? 0),
      items: await loadStockItems(
        tx,
        ids.rows.map((r) => r.id),
      ),
    };
  });
}

/** A pool read's paging (the contract's Page / Limit: 1-based, 1..100, default 20). */
function paging(q: { page?: number | undefined; limit?: number | undefined }) {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  return { page, limit, offset: (page - 1) * limit };
}

async function requireStockItem(tx: Queryable, stockItemId: string): Promise<void> {
  const item = await tx.query(`SELECT 1 FROM stock_item WHERE id = $1`, [stockItemId]);
  if (!item.rows[0]) throw notFound('stock item', stockItemId);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * `GET /admin/stock-items/{stockItemId}/movements` (`viewer` on `organization:hq`, #469): the pool row's ledger,
 * newest first. ORGANIZATION SCOPE only — the HQ screen sees every movement of the item: the ones a store caused
 * (they keep the store and variant they were written with) and the ones no store caused (`store_id` /
 * `variant_id` null: receipts, transfers, cycle counts). A store session could never read the latter
 * (`pool_ledger`), which is why there is no store-scoped variant. 404 for an unknown stock item.
 */
export async function listStockItemMovements(
  client: ScopedClient,
  stockItemId: string,
  q: ListStockItemMovementsQuery = {},
): Promise<Page<AdminStockMovement>> {
  requireOrganizationScope(client, 'listStockItemMovements');
  const { page, limit, offset } = paging(q);
  const params: unknown[] = [stockItemId];
  let clause = 'm.stock_item_id = $1';
  if (q.warehouse_id) {
    params.push(q.warehouse_id);
    clause += ` AND m.warehouse_id = $${params.length}`;
  }
  return client.transaction(async (tx) => {
    await requireStockItem(tx, stockItemId);
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movement m WHERE ${clause}`,
      params,
    );
    const rows = await tx.query<{
      id: string;
      stock_item_id: string;
      warehouse_id: string;
      store_id: string | null;
      variant_id: string | null;
      delta: number;
      reason: AdminStockMovement['reason'];
      reference_type: string | null;
      reference_id: string | null;
      actor_id: string | null;
      note: string | null;
      created_at: Date;
    }>(
      `SELECT m.id, m.stock_item_id, m.warehouse_id, m.store_id, m.variant_id, m.delta, m.reason,
              m.reference_type, m.reference_id, m.actor_id, m.note, m.created_at
       FROM stock_movement m WHERE ${clause}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return {
      page,
      limit,
      total: Number(total.rows[0]?.n ?? 0),
      items: rows.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
    };
  });
}

/**
 * `GET /admin/stock-items/{stockItemId}/reservations` (`viewer` on `organization:hq`, #469): what holds the pool
 * rows' `reserved` — EVERY store's reservations on this item, with the allocation rule that placed each, newest
 * first. ORGANIZATION SCOPE only: a store must never see another store's reservations (the pool row shows it the
 * total). `status`: `open` (default) = not released and not expired; `released` = released or expired; `all`.
 * 404 for an unknown stock item.
 */
export async function listStockItemReservations(
  client: ScopedClient,
  stockItemId: string,
  q: ListStockItemReservationsQuery = {},
): Promise<Page<AdminStockReservation>> {
  requireOrganizationScope(client, 'listStockItemReservations');
  const { page, limit, offset } = paging(q);
  const params: unknown[] = [stockItemId];
  const where = ['r.stock_item_id = $1'];
  if (q.warehouse_id) {
    params.push(q.warehouse_id);
    where.push(`r.warehouse_id = $${params.length}`);
  }
  const status = q.status ?? 'open';
  if (status === 'open') {
    where.push('r.released_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())');
  } else if (status === 'released') {
    where.push('(r.released_at IS NOT NULL OR r.expires_at <= now())');
  }
  const clause = where.join(' AND ');
  return client.transaction(async (tx) => {
    await requireStockItem(tx, stockItemId);
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reservation r WHERE ${clause}`,
      params,
    );
    const rows = await tx.query<{
      id: string;
      stock_item_id: string;
      warehouse_id: string;
      store_id: string;
      variant_id: string;
      order_id: string | null;
      quantity: number;
      allocation_rule: string | null;
      expires_at: Date | null;
      released_at: Date | null;
      created_at: Date;
    }>(
      `SELECT r.id, r.stock_item_id, r.warehouse_id, r.store_id, r.variant_id, r.order_id, r.quantity,
              r.allocation_rule, r.expires_at, r.released_at, r.created_at
       FROM reservation r WHERE ${clause}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return {
      page,
      limit,
      total: Number(total.rows[0]?.n ?? 0),
      items: rows.rows.map((r) => ({
        ...r,
        expires_at: iso(r.expires_at),
        released_at: iso(r.released_at),
        created_at: r.created_at.toISOString(),
      })),
    };
  });
}

/**
 * `PUT /admin/stock-items/{stockItemId}/variants/{variantId}` (operations on `organization:hq`; organization
 * scope — the database guard refuses a re-mapping from any other scope): from now on the variant sells from this
 * item's pool. Pooling two brands is only ever this explicit act.
 *
 * - Already mapped to this item → the item, nothing written (idempotent).
 * - Otherwise 409 `conflict` `{ stock_item_id, on_hand, open_reservations }` unless the variant's CURRENT item has
 *   zero on-hand at every warehouse and no open reservation: quantities are never merged silently — stock is moved
 *   first, with movements. The item the variant leaves is kept.
 * - One audit row (`variant.stock_item_mapped`, before / after) and one `stock_item.mapped` v1 event, same
 *   transaction.
 *
 * Locks: the variant row FOR UPDATE first (placements hold it FOR SHARE while they reserve, so the two queue),
 * then the current item's pool rows in warehouse order.
 */
export async function mapVariantToStockItem(
  client: ScopedClient,
  input: { stockItemId: string; variantId: string; actor: Actor },
): Promise<AdminStockItem> {
  requireOrganizationScope(client, 'mapVariantToStockItem');
  const organizationId = client.context.organizationId;
  return client.transaction(async (tx) => {
    const v = await tx.query<{ id: string; store_id: string; stock_item_id: string }>(
      `SELECT id, store_id, stock_item_id FROM product_variant WHERE id = $1 FOR UPDATE`,
      [input.variantId],
    );
    const variant = v.rows[0];
    if (!variant) throw notFound('variant', input.variantId);
    const target = await tx.query<{ id: string }>(`SELECT id FROM stock_item WHERE id = $1`, [
      input.stockItemId,
    ]);
    if (!target.rows[0]) throw notFound('stock item', input.stockItemId);

    if (variant.stock_item_id !== input.stockItemId) {
      const previous = variant.stock_item_id;
      const rows = await tx.query<{ on_hand: number }>(
        `SELECT on_hand FROM inventory_level WHERE stock_item_id = $1 ORDER BY warehouse_id FOR UPDATE`,
        [previous],
      );
      const open = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM reservation WHERE stock_item_id = $1 AND released_at IS NULL`,
        [previous],
      );
      const onHand = rows.rows.reduce((n, r) => n + r.on_hand, 0);
      const openReservations = Number(open.rows[0]?.n ?? 0);
      if (rows.rows.some((r) => r.on_hand !== 0) || openReservations > 0) {
        throw conflict(
          openReservations > 0 && rows.rows.every((r) => r.on_hand === 0)
            ? "the variant's current stock item still holds open reservations"
            : "the variant's current stock item still holds stock",
          { stock_item_id: previous, on_hand: onHand, open_reservations: openReservations },
        );
      }
      await tx.query(
        `UPDATE product_variant SET stock_item_id = $2, updated_at = now() WHERE id = $1`,
        [variant.id, input.stockItemId],
      );
      await writeAudit(tx, {
        organizationId,
        storeId: variant.store_id,
        actor: input.actor,
        action: 'variant.stock_item_mapped',
        entityType: 'product_variant',
        entityId: variant.id,
        before: { stock_item_id: previous },
        after: { stock_item_id: input.stockItemId },
      });
      await withEvents(tx, [
        await buildEvent({
          topic: 'stock_item.mapped',
          organizationId,
          storeId: variant.store_id,
          aggregateType: 'stock_item',
          aggregateId: input.stockItemId,
          actor: eventActor(input.actor),
          payload: {
            stock_item_id: input.stockItemId,
            previous_stock_item_id: previous,
            variant_id: variant.id,
            store_id: variant.store_id,
          },
        }),
      ]);
    }
    const [item] = await loadStockItems(tx, [input.stockItemId]);
    return item!;
  });
}
