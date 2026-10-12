// Reservations on the shared stock pool (#106, re-keyed by #456): the stock check AT PLACEMENT.
//
// `reserveForOrder` resolves the order's variants to their stock items (SHARE-locking the variant rows so a
// re-mapping cannot slip in), locks the items' pool rows in ONE canonical order — stock_item_id, then
// warehouse_id: the same order for every placement of every store, so two stores placing at once on overlapping
// items queue instead of deadlocking — and only then decides. WHICH warehouse serves a line is the allocation
// policy's call (allocation.ts, the #454 seam; default: priority order, greedy); that the decision is honest is
// checked here against the locked rows. It inserts `reservation` rows (who reserved: `store_id` + `variant_id`;
// which pool row: `stock_item_id`; why this warehouse: `allocation_rule`) and raises the pool row's `reserved`.
//
// A reservation is NOT a movement: `on_hand` is untouched and no `stock.moved` is written. Shortfall on a
// non-backorderable variant → 409 `out_of_stock` (the caller's transaction rolls back); a backorderable variant
// reserves anyway and `available` goes negative (the backorder). `releaseForOrder` (cancel, through the orders
// module's transition) and `consumeForShipment` (window 8 at ship time: reservation → `sale` movement) close the
// loop — both work on the reservation's OWN `stock_item_id`, the pool row it holds.
//
// Tenancy: reservations are per store (RLS kind `store`); the pool row's `reserved` is every store's total. A
// store sees how much of a shared item is reserved, never who reserved it.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError, conflict, validationError } from '../../lib/errors';
import {
  byPriority,
  currentAllocationPolicy,
  validateDecisions,
  type AllocationCandidate,
  type AllocationContext,
  type AllocationLine,
} from './allocation';
import { ensureLevel, moveStock, variantStock } from './service';
import type {
  Allocation,
  ConsumeForShipmentInput,
  ConsumeResult,
  ReservationResult,
  ReserveForOrderInput,
} from './types';

interface LockedLevel {
  id: string;
  stock_item_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  available: number;
}

interface ActiveWarehouse {
  id: string;
  code: string;
  country: string;
  priority: number;
}

const poolKey = (stockItemId: string, warehouseId: string) => `${stockItemId}:${warehouseId}`;

/**
 * Locks every pool row of `stockItemIds` in the canonical order (stock_item_id, warehouse_id). Rows of inactive
 * warehouses are locked too — the order must not depend on a flag somebody may be changing — and are simply not
 * offered as candidates.
 */
async function lockLevels(tx: Queryable, stockItemIds: readonly string[]): Promise<LockedLevel[]> {
  if (stockItemIds.length === 0) return [];
  const r = await tx.query<LockedLevel>(
    `SELECT il.id, il.stock_item_id, il.warehouse_id, il.on_hand, il.reserved, il.available
     FROM inventory_level il
     WHERE il.stock_item_id = ANY($1)
     ORDER BY il.stock_item_id, il.warehouse_id FOR UPDATE`,
    [[...new Set(stockItemIds)].sort()],
  );
  return r.rows;
}

async function activeWarehouses(tx: Queryable): Promise<ActiveWarehouse[]> {
  const r = await tx.query<ActiveWarehouse>(
    `SELECT id, code, country, priority FROM warehouse WHERE is_active ORDER BY priority, code`,
  );
  return r.rows;
}

async function bumpReserved(tx: Queryable, levelId: string, delta: number): Promise<void> {
  await tx.query(
    `UPDATE inventory_level SET reserved = reserved + $2, updated_at = now() WHERE id = $1`,
    [levelId, delta],
  );
}

/**
 * One reservation row. The stock item is read from the variant IN the insert: `reservation.stock_item_id` must be
 * the item of `reservation.variant_id` at the time of reserving, and no database constraint can say so (a
 * composite key would break re-mapping — released reservations keep their history). The SHARE lock on the variant
 * makes a mismatch impossible; if the row that comes back names another item, that guarantee is broken and the
 * whole placement fails rather than record a reservation on the wrong pool row.
 */
async function insertReservation(
  tx: Queryable,
  r: {
    organizationId: string;
    storeId: string;
    variantId: string;
    stockItemId: string;
    warehouseId: string;
    orderId: string;
    quantity: number;
    rule: string | null;
  },
): Promise<void> {
  const inserted = await tx.query<{ stock_item_id: string }>(
    `INSERT INTO reservation (organization_id, store_id, variant_id, stock_item_id, warehouse_id, order_id, quantity,
                              allocation_rule)
     SELECT $1, $2, v.id, v.stock_item_id, $4, $5, $6, $7 FROM product_variant v
     WHERE v.id = $3 AND v.store_id = $2
     RETURNING stock_item_id`,
    [r.organizationId, r.storeId, r.variantId, r.warehouseId, r.orderId, r.quantity, r.rule],
  );
  if (inserted.rows[0]?.stock_item_id !== r.stockItemId) {
    throw new AppError('internal', 'the variant was re-mapped while its stock was being reserved', {
      variant_id: r.variantId,
      stock_item_id: r.stockItemId,
    });
  }
}

/** What the policy is told about the order: its destination and the store's routing settings, as stored. */
async function allocationContext(
  tx: Queryable,
  input: ReserveForOrderInput,
): Promise<AllocationContext> {
  const r = await tx.query<{ country: string | null; routing: unknown }>(
    `SELECT (SELECT o.shipping_address->>'country' FROM "order" o WHERE o.id = $1) AS country,
            (SELECT s.settings->'fulfillment'->'routing' FROM store s WHERE s.id = $2) AS routing`,
    [input.orderId, input.storeId],
  );
  const country = r.rows[0]?.country?.trim().toUpperCase() ?? '';
  return {
    organizationId: input.organizationId,
    storeId: input.storeId,
    orderId: input.orderId,
    destinationCountry: /^[A-Z]{2}$/.test(country) ? country : null,
    routingSettings: r.rows[0]?.routing ?? null,
  };
}

/**
 * Reserves stock for a placed order (call inside the placement transaction, after the order lines exist). Lines
 * of the same variant are merged. Returns the allocation per variant; throws 409 `out_of_stock`
 * `{ variant_id, available }` when a non-backorderable variant is short. A variant that is not the store's is
 * `unknown variant` (400) before anything is locked or written.
 */
export async function reserveForOrder(
  tx: Queryable,
  input: ReserveForOrderInput,
): Promise<ReservationResult[]> {
  const wanted = new Map<string, number>();
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1) {
      throw validationError('reservation quantity must be a positive integer', {
        variant_id: l.variantId,
      });
    }
    wanted.set(l.variantId, (wanted.get(l.variantId) ?? 0) + l.quantity);
  }
  const variantIds = [...wanted.keys()].sort();
  // 1. variants → stock items (the store's own variants only), SHARE-locked in id order
  const variants = await variantStock(tx, variantIds, input.storeId);
  for (const id of variantIds) {
    if (!variants.has(id)) throw validationError('unknown variant', { variant_id: id });
  }
  const managed = variantIds.filter((id) => variants.get(id)!.manageInventory);
  if (managed.length === 0) {
    return variantIds.map((variantId) => ({ variantId, allocations: [], backorderQuantity: 0 }));
  }

  // 2. the pool rows, locked in the canonical order — BEFORE anything is decided
  const levels = await lockLevels(
    tx,
    managed.map((id) => variants.get(id)!.stockItemId),
  );
  const levelOf = new Map(levels.map((l) => [poolKey(l.stock_item_id, l.warehouse_id), l]));
  const warehouses = await activeWarehouses(tx);

  // 3. the policy decides on the locked numbers; its decision is validated against them
  const lines: AllocationLine[] = managed.map((variantId) => {
    const v = variants.get(variantId)!;
    const candidates: AllocationCandidate[] = warehouses.map((w) => ({
      warehouseId: w.id,
      warehouseCode: w.code,
      country: w.country,
      priority: w.priority,
      available: levelOf.get(poolKey(v.stockItemId, w.id))?.available ?? 0,
    }));
    return {
      variantId,
      stockItemId: v.stockItemId,
      quantity: wanted.get(variantId)!,
      allowBackorder: v.allowBackorder,
      candidates,
    };
  });
  const context = await allocationContext(tx, input);
  const decisions = validateDecisions(lines, currentAllocationPolicy()(context, lines));

  // 4. shortfall is the module's: 409 for a variant that may not be backordered, the priority warehouse otherwise
  const taken = new Map<string, number>(); // per pool row, by the lines of THIS placement so far
  const byVariant = new Map<string, ReservationResult>();
  for (const [i, line] of lines.entries()) {
    const decision = decisions[i]!;
    const allocations: Allocation[] = decision.allocations.map((a) => ({
      warehouseId: a.warehouseId,
      quantity: a.quantity,
      rule: a.rule,
    }));
    let backorderQuantity = 0;
    if (decision.shortfall > 0) {
      if (!line.allowBackorder) {
        const available = line.candidates.reduce(
          (n, c) =>
            n +
            Math.max(0, c.available - (taken.get(poolKey(line.stockItemId, c.warehouseId)) ?? 0)),
          0,
        );
        throw new AppError('out_of_stock', `Only ${available} left`, {
          variant_id: line.variantId,
          available,
        });
      }
      const priority = [...line.candidates].sort(byPriority)[0];
      if (!priority) throw new AppError('internal', 'no active warehouse');
      const existing = allocations.find((a) => a.warehouseId === priority.warehouseId);
      if (existing) existing.quantity += decision.shortfall;
      else {
        allocations.push({
          warehouseId: priority.warehouseId,
          quantity: decision.shortfall,
          rule: 'backorder',
        });
      }
      backorderQuantity = decision.shortfall;
    }

    // 5. one reservation per allocation; the pool row's `reserved` rises by the same quantity
    for (const a of allocations) {
      const key = poolKey(line.stockItemId, a.warehouseId);
      let level = levelOf.get(key);
      if (!level) {
        // a backorder on a warehouse where the item has no row yet: created at zero, locked
        const created = await ensureLevel(
          tx,
          {
            organizationId: input.organizationId,
            stockItemId: line.stockItemId,
            warehouseId: a.warehouseId,
          },
          true,
        );
        level = {
          id: created.id,
          stock_item_id: created.stock_item_id,
          warehouse_id: created.warehouse_id,
          on_hand: created.on_hand,
          reserved: created.reserved,
          available: created.available,
        };
        levelOf.set(key, level);
      }
      await insertReservation(tx, {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: line.variantId,
        stockItemId: line.stockItemId,
        warehouseId: a.warehouseId,
        orderId: input.orderId,
        quantity: a.quantity,
        rule: a.rule,
      });
      await bumpReserved(tx, level.id, a.quantity);
      taken.set(key, (taken.get(key) ?? 0) + a.quantity);
    }
    byVariant.set(line.variantId, { variantId: line.variantId, allocations, backorderQuantity });
  }
  return variantIds.map(
    (variantId) => byVariant.get(variantId) ?? { variantId, allocations: [], backorderQuantity: 0 },
  );
}

/** Releases every open reservation of an order (cancel). Idempotent; returns the quantity released. */
export async function releaseForOrder(tx: Queryable, orderId: string): Promise<number> {
  const open = await tx.query<{
    id: string;
    stock_item_id: string;
    warehouse_id: string;
    quantity: number;
  }>(
    `SELECT id, stock_item_id, warehouse_id, quantity FROM reservation
     WHERE order_id = $1 AND released_at IS NULL ORDER BY stock_item_id, warehouse_id, id`,
    [orderId],
  );
  if (open.rows.length === 0) return 0;
  const levels = await lockLevels(
    tx,
    open.rows.map((r) => r.stock_item_id),
  );
  let released = 0;
  for (const r of open.rows) {
    const level = levels.find(
      (l) => l.stock_item_id === r.stock_item_id && l.warehouse_id === r.warehouse_id,
    );
    if (level) await bumpReserved(tx, level.id, -r.quantity);
    await tx.query(`UPDATE reservation SET released_at = now(), updated_at = now() WHERE id = $1`, [
      r.id,
    ]);
    released += r.quantity;
  }
  return released;
}

/**
 * Window 8 at ship time: turns reserved units into shipped units — the reservation shrinks (or closes) and
 * `moveStock(reason 'sale')` lowers `on_hand` with one `stock.moved` per (variant, warehouse), attributed to the
 * store (it caused the movement). Shipping more than is reserved for the order → 409 `conflict`.
 */
export async function consumeForShipment(
  tx: Queryable,
  input: ConsumeForShipmentInput,
): Promise<ConsumeResult[]> {
  const out: ConsumeResult[] = [];
  const lines = [...input.lines].sort((x, y) => x.variantId.localeCompare(y.variantId));
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw validationError('shipped quantity must be a positive integer', {
        variant_id: line.variantId,
      });
    }
  }
  const variantIds = [...new Set(lines.map((l) => l.variantId))];
  // variants first (SHARE, id order), then the pool rows the order's reservations hold (canonical order)
  await variantStock(tx, variantIds, input.storeId);
  const held = await tx.query<{ stock_item_id: string }>(
    `SELECT DISTINCT stock_item_id FROM reservation
     WHERE order_id = $1 AND variant_id = ANY($2) AND released_at IS NULL`,
    [input.orderId, variantIds],
  );
  await lockLevels(
    tx,
    held.rows.map((r) => r.stock_item_id),
  );
  for (const line of lines) {
    const open = await tx.query<{
      id: string;
      stock_item_id: string;
      warehouse_id: string;
      quantity: number;
    }>(
      `SELECT r.id, r.stock_item_id, r.warehouse_id, r.quantity
       FROM reservation r JOIN warehouse w ON w.id = r.warehouse_id
       WHERE r.order_id = $1 AND r.variant_id = $2 AND r.released_at IS NULL
       ORDER BY (r.warehouse_id = $3) DESC, w.priority, w.code, r.created_at`,
      [input.orderId, line.variantId, line.warehouseId ?? null],
    );
    const reserved = open.rows.reduce((n, r) => n + r.quantity, 0);
    if (reserved < line.quantity) {
      throw conflict('shipping more than is reserved for this order', {
        variant_id: line.variantId,
        reserved,
        requested: line.quantity,
      });
    }
    let remaining = line.quantity;
    const perRow = new Map<
      string,
      { stockItemId: string; warehouseId: string; quantity: number }
    >();
    for (const r of open.rows) {
      if (remaining === 0) break;
      const take = Math.min(remaining, r.quantity);
      if (take === r.quantity) {
        await tx.query(
          `UPDATE reservation SET released_at = now(), updated_at = now() WHERE id = $1`,
          [r.id],
        );
      } else {
        await tx.query(
          `UPDATE reservation SET quantity = quantity - $2, updated_at = now() WHERE id = $1`,
          [r.id, take],
        );
      }
      const key = poolKey(r.stock_item_id, r.warehouse_id);
      const row = perRow.get(key) ?? {
        stockItemId: r.stock_item_id,
        warehouseId: r.warehouse_id,
        quantity: 0,
      };
      row.quantity += take;
      perRow.set(key, row);
      remaining -= take;
    }
    for (const { stockItemId, warehouseId, quantity } of perRow.values()) {
      const level = await ensureLevel(
        tx,
        { organizationId: input.organizationId, stockItemId, warehouseId },
        true,
      );
      await bumpReserved(tx, level.id, -quantity);
      const { movementId } = await moveStock(tx, {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: line.variantId,
        stockItemId,
        warehouseId,
        delta: -quantity,
        reason: 'sale',
        referenceType: input.shipmentId ? 'shipment' : 'order',
        referenceId: input.shipmentId ?? input.orderId,
        actor: input.actor,
      });
      out.push({ variantId: line.variantId, warehouseId, quantity, movementId });
    }
  }
  return out;
}

// ---- window 8's port shapes (#191): per-shipment, by order line item, idempotent per shipment ----

interface ShipmentLine {
  orderLineItemId: string;
  quantity: number;
}

async function variantsOfLines(
  tx: Queryable,
  orderId: string,
  items: readonly ShipmentLine[],
): Promise<{ variantId: string; quantity: number }[]> {
  const ids = items.map((i) => i.orderLineItemId);
  const rows = await tx.query<{ id: string; variant_id: string | null }>(
    `SELECT id, variant_id FROM order_line_item WHERE order_id = $1 AND id = ANY($2)`,
    [orderId, ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r.variant_id]));
  const out: { variantId: string; quantity: number }[] = [];
  for (const i of items) {
    if (!byId.has(i.orderLineItemId)) {
      throw validationError('unknown order line item', { order_line_item_id: i.orderLineItemId });
    }
    const variantId = byId.get(i.orderLineItemId);
    if (!variantId) continue; // variant deleted since: nothing to move
    out.push({ variantId, quantity: i.quantity });
  }
  return out;
}

/**
 * `consumeReservations` for shipping (#191): the shipment's lines by order line item, idempotent per shipment —
 * a `sale` movement referencing this shipment already exists for a variant → that line is skipped, so a retry
 * never double-decrements. (The ledger read is the store's own: attributed movements are visible in its scope.)
 */
export async function consumeReservationsForShipment(
  tx: Queryable,
  input: {
    organizationId: string;
    storeId: string;
    orderId: string;
    shipmentId: string;
    warehouseId?: string | undefined;
    items: readonly ShipmentLine[];
    actor: Actor;
  },
): Promise<ConsumeResult[]> {
  const lines = await variantsOfLines(tx, input.orderId, input.items);
  const done = await tx.query<{ variant_id: string }>(
    `SELECT DISTINCT variant_id FROM stock_movement
     WHERE reference_type = 'shipment' AND reference_id = $1 AND reason = 'sale' AND store_id = $2`,
    [input.shipmentId, input.storeId],
  );
  const already = new Set(done.rows.map((r) => r.variant_id));
  const pending = lines.filter((l) => !already.has(l.variantId));
  if (pending.length === 0) return [];
  return consumeForShipment(tx, {
    organizationId: input.organizationId,
    storeId: input.storeId,
    orderId: input.orderId,
    shipmentId: input.shipmentId,
    lines: pending.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity,
      warehouseId: input.warehouseId,
    })),
    actor: input.actor,
  });
}

/**
 * `releaseReservations` for shipping (#191): a planned shipment cancelled before picking. Reverses what
 * `consumeReservationsForShipment` did for this shipment: the goods go back on hand — on the SAME pool row they
 * left (`adjustment` movement referencing `shipment_release:<id>`, attributed to the store) — and the order's
 * reservation is re-opened. `items` says which order lines (and how many units) to release: per variant the
 * target is `min(consumed, asked)`, what earlier calls already released under this shipment is subtracted, and
 * the rest is spent across the variant's warehouse rows in the canonical order (warehouse priority, then code) —
 * so the same call twice releases once, a larger later call releases the difference, and an empty `items` means
 * everything the shipment consumed. Returns the units released now.
 *
 * A variant that was re-mapped to another stock item since the shipment consumed is refused with 409: the goods
 * belong to the item they left, and a reservation of this variant can no longer hold that item (`moveStock`
 * raises the conflict). Stock is moved by hand first — the same rule as the mapping itself.
 */
export async function releaseReservationsForShipment(
  tx: Queryable,
  input: {
    organizationId: string;
    storeId: string;
    orderId: string;
    shipmentId: string;
    items: readonly ShipmentLine[];
    actor: Actor;
  },
): Promise<number> {
  // canonical order: the asked quantity is spent warehouse by warehouse in this order (priority, then code)
  const consumed = await tx.query<{
    variant_id: string;
    stock_item_id: string;
    warehouse_id: string;
    quantity: string;
  }>(
    `SELECT m.variant_id, m.stock_item_id, m.warehouse_id, sum(-m.delta)::text AS quantity
     FROM stock_movement m JOIN warehouse w ON w.id = m.warehouse_id
     WHERE m.reference_type = 'shipment' AND m.reference_id = $1 AND m.reason = 'sale' AND m.store_id = $2
     GROUP BY m.variant_id, m.stock_item_id, m.warehouse_id, w.priority, w.code
     ORDER BY m.variant_id, w.priority, w.code`,
    [input.shipmentId, input.storeId],
  );
  const released = await tx.query<{ variant_id: string; warehouse_id: string; quantity: string }>(
    `SELECT variant_id, warehouse_id, sum(delta)::text AS quantity FROM stock_movement
     WHERE reference_type = 'shipment_release' AND reference_id = $1 AND store_id = $2
     GROUP BY variant_id, warehouse_id`,
    [input.shipmentId, input.storeId],
  );
  const releasedBefore = new Map(
    released.rows.map((r) => [`${r.variant_id}:${r.warehouse_id}`, Number(r.quantity)]),
  );
  // asked units per variant (undefined = no cap: release everything the shipment consumed)
  let asked: Map<string, number> | undefined;
  if (input.items.length > 0) {
    asked = new Map();
    for (const l of await variantsOfLines(tx, input.orderId, input.items)) {
      asked.set(l.variantId, (asked.get(l.variantId) ?? 0) + l.quantity);
    }
  }
  // per variant: target = min(all consumed, asked) − all released so far; then spend it row by row
  const remaining = new Map<string, number>();
  for (const c of consumed.rows) {
    if (remaining.has(c.variant_id)) continue;
    const rows = consumed.rows.filter((r) => r.variant_id === c.variant_id);
    const consumedAll = rows.reduce((n, r) => n + Number(r.quantity), 0);
    const releasedAll = rows.reduce(
      (n, r) => n + (releasedBefore.get(`${r.variant_id}:${r.warehouse_id}`) ?? 0),
      0,
    );
    const target = asked ? Math.min(consumedAll, asked.get(c.variant_id) ?? 0) : consumedAll;
    remaining.set(c.variant_id, target - releasedAll);
  }
  let total = 0;
  for (const c of consumed.rows) {
    const key = `${c.variant_id}:${c.warehouse_id}`;
    const left = remaining.get(c.variant_id) ?? 0;
    const capacity = Number(c.quantity) - (releasedBefore.get(key) ?? 0); // still held at this warehouse
    const quantity = Math.min(capacity, left);
    if (quantity <= 0) continue;
    remaining.set(c.variant_id, left - quantity);
    const { level } = await moveStock(tx, {
      organizationId: input.organizationId,
      storeId: input.storeId,
      variantId: c.variant_id,
      stockItemId: c.stock_item_id, // the pool row the goods left; 409 when the variant maps another item now
      warehouseId: c.warehouse_id,
      delta: quantity,
      reason: 'adjustment',
      referenceType: 'shipment_release',
      referenceId: input.shipmentId,
      note: 'planned shipment cancelled before picking',
      actor: input.actor,
    });
    await insertReservation(tx, {
      organizationId: input.organizationId,
      storeId: input.storeId,
      variantId: c.variant_id,
      stockItemId: c.stock_item_id,
      warehouseId: c.warehouse_id,
      orderId: input.orderId,
      quantity,
      rule: null,
    });
    await bumpReserved(tx, level.id, quantity);
    total += quantity;
  }
  return total;
}
