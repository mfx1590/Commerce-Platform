// Fulfilment: route an order to a warehouse, hand it to that warehouse's provider, and keep the shipment in step
// with what the provider reports.
//
// One rule shapes every function here: **no database transaction is held across a provider call.** A 3PL can
// take seconds or time out, and a transaction held that long pins a connection and the order row's locks. So the
// work runs as short transactions around the network call, with an explicit compensation where a later step
// fails:
//
//   requestFulfillment   plan the shipment (tx: rows + shipment.created + reservation consumed)
//                        → push to the provider (no tx)
//                        → record the provider's reference on the shipment (tx)
//                        a failed push cancels the shipment, which releases the reservation
//
//   cancelFulfillment    ask the provider (no tx) → cancel the shipment (tx: releases the reservation)
//                        a provider that refuses (picking started) is a 409 and nothing changes
import type { ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import {
  createShipment,
  readShipmentMetadata,
  updateShipment,
  writeShipmentMetadata,
  type ShipmentItem,
  type StoreShipment,
} from '../shipping';
import { fulfillmentProvider, fulfillmentProviderFor } from './registry';
import { routeFulfillment, routingSettingsFrom } from './routing';
import {
  FulfillmentError,
  type FulfillmentAddress,
  type FulfillmentRef,
  type FulfillmentUpdate,
  type RoutingDecision,
  type WarehouseCandidate,
} from './types';

export const FULFILLMENT_METADATA_KEY = 'fulfillment';

export interface RequestFulfillmentInput {
  orderId: string;
  /** Lines and quantities to fulfil. Default: everything the order still owes. */
  items?: ShipmentItem[] | undefined;
  /** Skips routing and ships from this warehouse. */
  warehouseId?: string | undefined;
  actor: Actor;
}

export interface RequestFulfillmentResult {
  shipment: StoreShipment;
  /** Null when the caller named the warehouse. */
  routing: RoutingDecision | null;
  provider: string;
  externalId: string;
}

interface OrderContext {
  id: string;
  organization_id: string;
  store_id: string;
  shipping_address: Record<string, unknown> | null;
  shipping_method: { carrier?: string; code?: string } | null;
  settings: Record<string, unknown> | null;
}

interface LineRow {
  id: string;
  sku: string;
  quantity: number;
  covered: string;
}

/**
 * Routes the order, plans its shipment, and pushes it to the provider. On a failed push the shipment is cancelled
 * again (releasing its reservation) and the call fails with 502 — the order is left exactly as it was.
 */
export async function requestFulfillment(
  client: ScopedClient,
  input: RequestFulfillmentInput,
): Promise<RequestFulfillmentResult> {
  const order = await loadOrderContext(client, input.orderId);
  const lines = await loadLines(client, input.orderId);
  const items = input.items ?? outstandingItems(lines);
  if (items.length === 0) {
    throw conflict('nothing left to fulfil on this order', { order_id: input.orderId });
  }
  const destination = destinationOf(order);
  if (!destination) {
    throw validationError('order has no usable shipping address', { order_id: input.orderId });
  }

  const warehouses = await loadWarehouses(client, order.organization_id);
  let routing: RoutingDecision | null = null;
  let warehouse: WarehouseCandidate | undefined;
  if (input.warehouseId) {
    warehouse = warehouses.find((candidate) => candidate.id === input.warehouseId);
    if (!warehouse) throw validationError('unknown warehouse', { warehouse_id: input.warehouseId });
  } else {
    routing = routeFulfillment({
      destinationCountry: destination.country,
      candidates: warehouses,
      settings: routingSettingsFrom(order.settings),
    });
    if (!routing) throw new AppError('internal', 'no active warehouse to fulfil from');
    warehouse = routing.warehouse;
  }

  const provider = fulfillmentProviderFor(order.settings);
  const carrier = order.shipping_method?.carrier ?? null;

  // 1. plan the shipment — its own transaction, reservation consumed.
  const shipment = await createShipment(client, {
    orderId: order.id,
    warehouseId: warehouse.id,
    ...(carrier ? { carrier } : {}),
    items,
    actor: input.actor,
  });

  // 2. hand it to the provider — no transaction open.
  const skuOf = new Map(lines.map((line) => [line.id, line.sku]));
  let ack;
  try {
    ack = await provider.push({
      reference: shipment.id,
      orderId: order.id,
      warehouseCode: warehouse.code,
      lines: items.map((item) => ({
        orderLineItemId: item.order_line_item_id,
        sku: skuOf.get(item.order_line_item_id) ?? 'unknown',
        quantity: item.quantity,
      })),
      shipTo: destination,
      carrier,
      service: shipment.service,
    });
  } catch (error) {
    // Compensate: the shipment never reached a warehouse, so it must not hold stock.
    await updateShipment(client, shipment.id, { status: 'cancelled', actor: input.actor });
    const reason =
      error instanceof FulfillmentError ? error.message : 'unexpected provider failure';
    throw new AppError(
      'internal',
      `fulfilment provider did not accept the request: ${reason}`,
      { order_id: order.id, shipment_id: shipment.id, provider: provider.name },
      502,
    );
  }

  // 3. remember where it went.
  await writeShipmentMetadata(client, shipment.id, FULFILLMENT_METADATA_KEY, {
    provider: provider.name,
    external_id: ack.externalId,
    state: ack.state,
    warehouse_code: warehouse.code,
    updated_at: new Date().toISOString(),
  } satisfies FulfillmentRef);

  return { shipment, routing, provider: provider.name, externalId: ack.externalId };
}

/**
 * Cancels a fulfilment before it is picked. The provider is asked first: if it refuses (picking has started),
 * this is a 409 and nothing changes on our side. If it agrees, the shipment is cancelled, which releases the
 * reservation through the inventory module.
 */
export async function cancelFulfillment(
  client: ScopedClient,
  shipmentId: string,
  actor: Actor,
): Promise<StoreShipment> {
  const ref = await readRef(client, shipmentId);
  if (ref.state === 'cancelled') {
    throw conflict('fulfilment is already cancelled', { shipment_id: shipmentId });
  }
  const provider = providerNamed(ref.provider);
  const result = await provider.cancel(ref.external_id);
  if (!result.cancelled) {
    throw conflict('fulfilment can no longer be cancelled', {
      shipment_id: shipmentId,
      state: ref.state,
      reason: result.reason ?? null,
    });
  }
  // The provider has stopped. Our row must catch up — and if it cannot, the divergence is written down
  // rather than lost: the provider will not pick this shipment, so nobody may believe it is still coming.
  try {
    const shipment = await updateShipment(client, shipmentId, { status: 'cancelled', actor });
    await writeRef(client, shipmentId, { ...ref, state: 'cancelled' });
    return shipment;
  } catch (error) {
    await writeRef(client, shipmentId, {
      ...ref,
      state: 'cancelled',
      needs_reconciliation: true,
      reconcile_reason: 'provider cancelled the fulfilment; the shipment could not be cancelled',
    });
    throw new AppError(
      'conflict',
      'the provider cancelled the fulfilment but the shipment could not be cancelled; it needs reconciling',
      {
        shipment_id: shipmentId,
        provider: ref.provider,
        cause: error instanceof AppError ? error.message : 'unexpected failure',
      },
    );
  }
}

/**
 * Applies what a provider reports — a push callback, or the result of polling `status()`. Idempotent: a state the
 * shipment already records changes nothing. `picking` and `packed` are recorded only; task 2.5 turns them into the
 * pick/pack state machine.
 */
export async function applyFulfillmentUpdate(
  client: ScopedClient,
  update: FulfillmentUpdate,
  actor: Actor,
): Promise<{ applied: boolean; shipment: StoreShipment | null }> {
  const ref = await readRef(client, update.reference);
  if (ref.external_id !== update.externalId) {
    throw validationError('update does not belong to this shipment', {
      shipment_id: update.reference,
    });
  }
  if (ref.state === update.state) return { applied: false, shipment: null };

  const move = async (patch: Parameters<typeof updateShipment>[2]) => {
    try {
      return await updateShipment(client, update.reference, patch);
    } catch (error) {
      // The carrier's tracking webhook may have moved the shipment already; the provider is simply late.
      if (error instanceof AppError && error.code === 'conflict') return null;
      throw error;
    }
  };

  // The shipment moves FIRST. Writing the reference first would leave it advanced when the move fails for a
  // real reason, and the provider's retry would then find "already at this state" and do nothing.
  let shipment: StoreShipment | null = null;
  switch (update.state) {
    case 'picking':
      shipment = await move({ status: 'picking', actor });
      break;
    case 'packed':
      shipment = await move({ status: 'packed', actor });
      break;
    case 'shipped':
      shipment = await move({
        status: 'shipped',
        ...(update.trackingNumber ? { trackingNumber: update.trackingNumber } : {}),
        ...(update.trackingUrl ? { trackingUrl: update.trackingUrl } : {}),
        actor,
      });
      break;
    case 'cancelled':
      shipment = await move({ status: 'cancelled', actor });
      break;
    case 'failed':
      shipment = await move({ status: 'failed', actor });
      break;
    default:
      shipment = null; // `accepted` reports no state of ours
  }
  await writeRef(client, update.reference, { ...ref, state: update.state });
  return { applied: true, shipment };
}

// ---- internals ----

async function loadOrderContext(client: ScopedClient, orderId: string): Promise<OrderContext> {
  const r = await client.query<OrderContext>(
    `SELECT o.id, o.organization_id, o.store_id, o.shipping_address, o.shipping_method, s.settings
       FROM "order" o JOIN store s ON s.id = o.store_id
      WHERE o.id = $1`,
    [orderId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('order', orderId);
  return row;
}

async function loadLines(client: ScopedClient, orderId: string): Promise<LineRow[]> {
  const r = await client.query<LineRow>(
    `SELECT l.id, l.sku, l.quantity,
            coalesce((SELECT sum(si.quantity) FROM shipment_item si
                        JOIN shipment s ON s.id = si.shipment_id AND s.status <> 'cancelled'
                       WHERE si.order_line_item_id = l.id), 0)::text AS covered
       FROM order_line_item l WHERE l.order_id = $1 ORDER BY l.created_at, l.id`,
    [orderId],
  );
  return r.rows;
}

function outstandingItems(lines: LineRow[]): ShipmentItem[] {
  return lines
    .map((line) => ({
      order_line_item_id: line.id,
      quantity: line.quantity - Number(line.covered),
    }))
    .filter((item) => item.quantity > 0);
}

async function loadWarehouses(
  client: ScopedClient,
  organizationId: string,
): Promise<WarehouseCandidate[]> {
  const r = await client.query<WarehouseCandidate>(
    `SELECT id, code, country, priority FROM warehouse
      WHERE organization_id = $1 AND is_active ORDER BY priority, code`,
    [organizationId],
  );
  return r.rows;
}

function destinationOf(order: OrderContext): FulfillmentAddress | null {
  const a = order.shipping_address;
  if (!a) return null;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  const line1 = text(a.line1);
  const city = text(a.city);
  const postalCode = text(a.postal_code);
  const country = text(a.country);
  if (!line1 || !city || !postalCode || !country) return null;
  return {
    name: [text(a.first_name), text(a.last_name)].filter(Boolean).join(' ') || 'Customer',
    company: text(a.company),
    line1,
    line2: text(a.line2),
    city,
    region: text(a.region),
    postalCode,
    country: country.toUpperCase(),
    phone: text(a.phone),
  };
}

async function readRef(client: ScopedClient, shipmentId: string): Promise<FulfillmentRef> {
  const value = await readShipmentMetadata(client, shipmentId, FULFILLMENT_METADATA_KEY);
  if (!value || typeof value.external_id !== 'string' || typeof value.provider !== 'string') {
    throw notFound('fulfilment for shipment', shipmentId);
  }
  return value as unknown as FulfillmentRef;
}

async function writeRef(client: ScopedClient, shipmentId: string, ref: FulfillmentRef) {
  await writeShipmentMetadata(client, shipmentId, FULFILLMENT_METADATA_KEY, {
    ...ref,
    updated_at: new Date().toISOString(),
  });
}

function providerNamed(name: string) {
  const provider = fulfillmentProvider(name);
  if (!provider) throw new AppError('internal', `fulfilment provider ${name} is not registered`);
  return provider;
}
