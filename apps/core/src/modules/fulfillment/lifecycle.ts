// The pick/pack lifecycle: `pending → picking → packed →` (label, then the carrier). The states are
// `shipment.status` itself (CONTRACT CHANGE #225) — one source of truth, so every guard, listing and consumer
// reads the same column — and each legal move writes exactly one event through the lifecycle seam, in the same
// transaction as the state change (ADR 0003).
//
// Illegal moves are a 409 here. That is deliberate: a warehouse operator pressing "pack" on a shipment someone
// already shipped is a mistake worth reporting, unlike a carrier's out-of-order scan, which the tracking
// receiver skips silently.
import type { ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { conflict, validationError } from '../../lib/errors';
import {
  applyTransition,
  canTransition,
  loadShipment,
  renderShipment,
  type ShipmentItem,
  type ShipmentRow,
  type ShipmentStatus,
  type StoreShipment,
} from '../shipping';
import { emitLifecycleEvent, type LifecycleTopic } from './lifecycle-events';

/** Statuses a shipment can be in while it is still work on a warehouse floor. */
export const PICK_LIST_STATUSES: ShipmentStatus[] = ['pending', 'picking', 'packed'];

export interface PickListQuery {
  warehouseId?: string | undefined;
  status?: ShipmentStatus | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface PickListGroup {
  warehouse_id: string;
  warehouse_code: string;
  shipments: StoreShipment[];
}

export interface PickListPage {
  items: PickListGroup[];
  page: { page: number; limit: number; total: number };
}

/** `POST /admin/shipments/{shipmentId}/pick` — picking started. */
export async function pickShipment(
  client: ScopedClient,
  shipmentId: string,
  actor: Actor,
): Promise<StoreShipment> {
  return move(client, shipmentId, 'picking', 'fulfillment.picking', actor, {});
}

/** `POST /admin/shipments/{shipmentId}/pack` — boxed and ready for the carrier. */
export async function packShipment(
  client: ScopedClient,
  shipmentId: string,
  input: { actor: Actor; parcelCount?: number | undefined },
): Promise<StoreShipment> {
  if (
    input.parcelCount !== undefined &&
    (!Number.isInteger(input.parcelCount) || input.parcelCount < 1)
  ) {
    throw validationError('parcel_count must be a positive integer', {
      parcel_count: String(input.parcelCount),
    });
  }
  return move(client, shipmentId, 'packed', 'fulfillment.packed', input.actor, {
    parcelCount: input.parcelCount ?? null,
  });
}

/**
 * One transaction: check the move, apply it through the shipping module's own transition (which keeps the order
 * and the outbox in step), then emit the lifecycle event. A refused move changes nothing.
 */
async function move(
  client: ScopedClient,
  shipmentId: string,
  status: ShipmentStatus,
  topic: LifecycleTopic,
  actor: Actor,
  extra: { parcelCount?: number | null },
): Promise<StoreShipment> {
  return client.transaction(async (tx) => {
    const { shipment, items } = await loadShipment(tx, shipmentId);
    if (shipment.status === status) {
      throw conflict(`shipment is already ${status}`, {
        shipment_id: shipmentId,
        status: shipment.status,
      });
    }
    // `applyTransition` writes what it is told; the legality check is the caller's, and skipping it here would
    // let "pick" drag a shipped parcel backwards.
    if (!canTransition(shipment.status, status)) {
      throw conflict(`a ${shipment.status} shipment cannot go to ${status}`, {
        shipment_id: shipmentId,
        from: shipment.status,
        to: status,
      });
    }
    const occurredAt = new Date().toISOString();
    const moved = await applyTransition(tx, shipment, items, { status, actor });
    await emitLifecycleEvent(tx, {
      topic,
      organizationId: shipment.organization_id,
      storeId: shipment.store_id,
      shipmentId,
      orderId: shipment.order_id,
      warehouseId: shipment.warehouse_id,
      items: items.map((item: ShipmentItem) => ({
        order_line_item_id: item.order_line_item_id,
        quantity: item.quantity,
      })),
      occurredAt,
      actor,
      ...(extra.parcelCount === undefined ? {} : { parcelCount: extra.parcelCount }),
    });
    return moved;
  });
}

/**
 * `GET /admin/stores/{storeId}/pick-lists` — what the floor still has to do, grouped by warehouse and ordered
 * oldest first, because the oldest order has been waiting longest. Paging counts shipments, not groups.
 */
export async function listPickLists(
  client: ScopedClient,
  storeId: string,
  query: PickListQuery = {},
): Promise<PickListPage> {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const statuses = query.status ? [query.status] : PICK_LIST_STATUSES;
  const params: unknown[] = [storeId, statuses, query.warehouseId ?? null];

  const total = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM shipment
      WHERE store_id = $1 AND status = ANY($2::text[]) AND ($3::uuid IS NULL OR warehouse_id = $3::uuid)`,
    params,
  );

  // Two queries, not one per shipment: a busy floor can have hundreds of open shipments.
  const rows = await client.query<ShipmentRow & { warehouse_code: string }>(
    `SELECT s.*, w.code AS warehouse_code
       FROM shipment s JOIN warehouse w ON w.id = s.warehouse_id
      WHERE s.store_id = $1 AND s.status = ANY($2::text[])
        AND ($3::uuid IS NULL OR s.warehouse_id = $3::uuid)
      ORDER BY s.created_at, s.id
      LIMIT $4 OFFSET $5`,
    [...params, limit, (page - 1) * limit],
  );
  const lines = await client.query<{
    shipment_id: string;
    order_line_item_id: string;
    quantity: number;
  }>(
    `SELECT shipment_id, order_line_item_id, quantity FROM shipment_item
      WHERE shipment_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [rows.rows.map((row) => row.id)],
  );
  const itemsOf = new Map<string, ShipmentItem[]>();
  for (const line of lines.rows) {
    const list = itemsOf.get(line.shipment_id) ?? [];
    list.push({ order_line_item_id: line.order_line_item_id, quantity: line.quantity });
    itemsOf.set(line.shipment_id, list);
  }

  const groups = new Map<string, PickListGroup>();
  for (const row of rows.rows) {
    const group = groups.get(row.warehouse_id) ?? {
      warehouse_id: row.warehouse_id,
      warehouse_code: row.warehouse_code,
      shipments: [],
    };
    group.shipments.push(renderShipment(row, itemsOf.get(row.id) ?? []));
    groups.set(row.warehouse_id, group);
  }

  return {
    items: [...groups.values()],
    page: { page, limit, total: Number(total.rows[0]!.total) },
  };
}
