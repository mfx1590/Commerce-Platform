// Reservations (issue #106): the stock check AT PLACEMENT. `reserveForOrder` locks the variants' level rows in a
// deterministic order (variant id, then warehouse priority, then warehouse code — the same order for every
// placement, so two placements for overlapping variants queue instead of deadlocking), allocates greedily across
// active warehouses in priority order, inserts `reservation` rows and raises `reserved`. A reservation is NOT a
// movement: `on_hand` is untouched and no `stock.moved` is written. Shortfall on a non-backorderable variant →
// 409 `out_of_stock` (the caller's transaction rolls back); a backorderable variant reserves anyway and `available`
// goes negative (the backorder). `releaseForOrder` (cancel, through the orders module's transition) and
// `consumeForShipment` (window 8 at ship time: reservation → `sale` movement) close the loop.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError, conflict, validationError } from '../../lib/errors';
import { ensureLevel, moveStock } from './service';
import type {
  Allocation,
  ConsumeForShipmentInput,
  ConsumeResult,
  ReservationResult,
  ReserveForOrderInput,
} from './types';

interface LockedLevel {
  id: string;
  variant_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  available: number;
  priority: number;
  code: string;
}

interface VariantFlags {
  id: string;
  manage_inventory: boolean;
  allow_backorder: boolean;
}

/** Locks every active-warehouse level of `variantIds` in the canonical order. */
async function lockLevels(tx: Queryable, variantIds: readonly string[]): Promise<LockedLevel[]> {
  if (variantIds.length === 0) return [];
  const r = await tx.query<LockedLevel>(
    `SELECT il.id, il.variant_id, il.warehouse_id, il.on_hand, il.reserved, il.available, w.priority, w.code
     FROM inventory_level il JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
     WHERE il.variant_id = ANY($1)
     ORDER BY il.variant_id, w.priority, w.code FOR UPDATE OF il`,
    [[...variantIds].sort()],
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
 * Reserves stock for a placed order (call inside the placement transaction, after the order lines exist). Lines
 * of the same variant are merged. Returns the allocation per variant; throws 409 `out_of_stock`
 * `{ variant_id, available }` when a non-backorderable variant is short.
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
  const variantIds = [...wanted.keys()].sort(); // canonical order: variant id first
  const flags = await tx.query<VariantFlags>(
    `SELECT id, manage_inventory, allow_backorder FROM product_variant WHERE id = ANY($1) AND store_id = $2`,
    [variantIds, input.storeId],
  );
  const flagsById = new Map(flags.rows.map((f) => [f.id, f]));
  for (const id of variantIds) {
    if (!flagsById.has(id)) throw validationError('unknown variant', { variant_id: id });
  }
  const managed = variantIds.filter((id) => flagsById.get(id)!.manage_inventory);
  const levels = await lockLevels(tx, managed);

  const results: ReservationResult[] = [];
  for (const variantId of variantIds) {
    const quantity = wanted.get(variantId)!;
    const flag = flagsById.get(variantId)!;
    if (!flag.manage_inventory) {
      results.push({ variantId, allocations: [], backorderQuantity: 0 });
      continue;
    }
    const mine = levels.filter((l) => l.variant_id === variantId); // already priority-ordered
    const available = mine.reduce((n, l) => n + Math.max(0, l.available), 0);
    if (available < quantity && !flag.allow_backorder) {
      throw new AppError('out_of_stock', `Only ${available} left`, {
        variant_id: variantId,
        available,
      });
    }
    let remaining = quantity;
    const allocations: Allocation[] = [];
    for (const l of mine) {
      if (remaining === 0) break;
      const take = Math.min(remaining, Math.max(0, l.available));
      if (take === 0) continue;
      allocations.push({ warehouseId: l.warehouse_id, quantity: take });
      remaining -= take;
    }
    let backorderQuantity = 0;
    if (remaining > 0) {
      // backorderable: the rest goes on the priority warehouse (created at zero when the variant has no level yet)
      let target = mine[0];
      if (!target) {
        const wh = await tx.query<{ id: string }>(
          `SELECT id FROM warehouse WHERE is_active ORDER BY priority, code LIMIT 1`,
        );
        if (!wh.rows[0]) throw new AppError('internal', 'no active warehouse');
        const created = await ensureLevel(
          tx,
          { ...input, variantId, warehouseId: wh.rows[0].id },
          true,
        );
        target = {
          id: created.id,
          variant_id: variantId,
          warehouse_id: created.warehouse_id,
          on_hand: created.on_hand,
          reserved: created.reserved,
          available: created.available,
          priority: 0,
          code: '',
        };
        mine.push(target);
      }
      const existing = allocations.find((a) => a.warehouseId === target!.warehouse_id);
      if (existing) existing.quantity += remaining;
      else allocations.push({ warehouseId: target.warehouse_id, quantity: remaining });
      backorderQuantity = remaining;
      remaining = 0;
    }
    for (const a of allocations) {
      const level = mine.find((l) => l.warehouse_id === a.warehouseId)!;
      await tx.query(
        `INSERT INTO reservation (organization_id, store_id, variant_id, warehouse_id, order_id, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.organizationId, input.storeId, variantId, a.warehouseId, input.orderId, a.quantity],
      );
      await bumpReserved(tx, level.id, a.quantity);
      level.reserved += a.quantity;
      level.available -= a.quantity;
    }
    results.push({ variantId, allocations, backorderQuantity });
  }
  return results;
}

/** Releases every open reservation of an order (cancel). Idempotent; returns the quantity released. */
export async function releaseForOrder(tx: Queryable, orderId: string): Promise<number> {
  const open = await tx.query<{
    id: string;
    variant_id: string;
    warehouse_id: string;
    quantity: number;
  }>(
    `SELECT id, variant_id, warehouse_id, quantity FROM reservation
     WHERE order_id = $1 AND released_at IS NULL ORDER BY variant_id, warehouse_id`,
    [orderId],
  );
  if (open.rows.length === 0) return 0;
  const levels = await lockLevels(tx, [...new Set(open.rows.map((r) => r.variant_id))]);
  let released = 0;
  for (const r of open.rows) {
    const level = levels.find(
      (l) => l.variant_id === r.variant_id && l.warehouse_id === r.warehouse_id,
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
 * `moveStock(reason 'sale')` lowers `on_hand` with one `stock.moved` per (variant, warehouse). Shipping more than
 * is reserved for the order → 409 `conflict`.
 */
export async function consumeForShipment(
  tx: Queryable,
  input: ConsumeForShipmentInput,
): Promise<ConsumeResult[]> {
  const out: ConsumeResult[] = [];
  const lines = [...input.lines].sort((x, y) => x.variantId.localeCompare(y.variantId));
  await lockLevels(tx, [...new Set(lines.map((l) => l.variantId))]);
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw validationError('shipped quantity must be a positive integer', {
        variant_id: line.variantId,
      });
    }
    const open = await tx.query<{ id: string; warehouse_id: string; quantity: number }>(
      `SELECT r.id, r.warehouse_id, r.quantity FROM reservation r JOIN warehouse w ON w.id = r.warehouse_id
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
    const perWarehouse = new Map<string, number>();
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
      perWarehouse.set(r.warehouse_id, (perWarehouse.get(r.warehouse_id) ?? 0) + take);
      remaining -= take;
    }
    for (const [warehouseId, quantity] of perWarehouse) {
      const level = await ensureLevel(
        tx,
        {
          organizationId: input.organizationId,
          storeId: input.storeId,
          variantId: line.variantId,
          warehouseId,
        },
        true,
      );
      await bumpReserved(tx, level.id, -quantity);
      const { movementId } = await moveStock(tx, {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: line.variantId,
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
 * never double-decrements.
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
     WHERE reference_type = 'shipment' AND reference_id = $1 AND reason = 'sale'`,
    [input.shipmentId],
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
 * `consumeReservationsForShipment` did for this shipment: the goods go back on hand (`adjustment` movement
 * referencing `shipment_release:<id>`) and the order's reservation is re-opened. `items` says which order lines
 * (and how many units) to release: per variant the target is `min(consumed, asked)`, what earlier calls already
 * released under this shipment is subtracted, and the rest is spent across the variant's warehouse rows in the
 * canonical order (warehouse priority, then code) — so the same call twice releases once, a larger later call
 * releases the difference, and an empty `items` means everything the shipment consumed. Returns the units
 * released now.
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
  const consumed = await tx.query<{ variant_id: string; warehouse_id: string; quantity: string }>(
    `SELECT m.variant_id, m.warehouse_id, sum(-m.delta)::text AS quantity
     FROM stock_movement m JOIN warehouse w ON w.id = m.warehouse_id
     WHERE m.reference_type = 'shipment' AND m.reference_id = $1 AND m.reason = 'sale'
     GROUP BY m.variant_id, m.warehouse_id, w.priority, w.code
     ORDER BY m.variant_id, w.priority, w.code`,
    [input.shipmentId],
  );
  const released = await tx.query<{ variant_id: string; warehouse_id: string; quantity: string }>(
    `SELECT variant_id, warehouse_id, sum(delta)::text AS quantity FROM stock_movement
     WHERE reference_type = 'shipment_release' AND reference_id = $1
     GROUP BY variant_id, warehouse_id`,
    [input.shipmentId],
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
      warehouseId: c.warehouse_id,
      delta: quantity,
      reason: 'adjustment',
      referenceType: 'shipment_release',
      referenceId: input.shipmentId,
      note: 'planned shipment cancelled before picking',
      actor: input.actor,
    });
    await tx.query(
      `INSERT INTO reservation (organization_id, store_id, variant_id, warehouse_id, order_id, quantity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.organizationId, input.storeId, c.variant_id, c.warehouse_id, input.orderId, quantity],
    );
    await bumpReserved(tx, level.id, quantity);
    total += quantity;
  }
  return total;
}
