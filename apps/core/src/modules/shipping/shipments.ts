// Shipments: planning one from an order, buying its label, and advancing its status. Every state change writes
// its event to the outbox in the same transaction (ADR 0003) and every event carries ids, amounts and a country
// — never an address.
//
// Status machine (`shipment.status`, the column's CHECK constraint):
//
//   pending ─→ label_created ─→ shipped ─→ in_transit ─→ delivered
//      │             │             └──────────────────────→ delivered   (carrier skipped the scans)
//      └─────────────┴──→ cancelled                └────→ failed
//
// Forward only. A carrier scan that would move a shipment backwards is ignored, not an error: carriers deliver
// their events out of order, and `delivered` before `in_transit` is normal.
import type { ScopedClient, Queryable } from '@platform/db';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import type { Actor } from '../../lib/audit';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { carrierConfigFor, easyPostCredentialsFor } from './config';
import { createEasyPostProvider } from './easypost-provider';
import { carrierProvider } from './registry';
import { CarrierError, toCarrierAddress } from './redact';
import { currentInventoryPort, currentOrdersPort } from './ports';
import type { CarrierProvider, ContractAddress, Parcel } from './types';

export type ShipmentStatus =
  'pending' | 'label_created' | 'shipped' | 'in_transit' | 'delivered' | 'failed' | 'cancelled';

/** How far along a status is. A transition to a lower or equal rank is a no-op (except the terminal two). */
const RANK: Record<ShipmentStatus, number> = {
  pending: 0,
  label_created: 1,
  shipped: 2,
  in_transit: 3,
  delivered: 4,
  failed: 5,
  cancelled: 5,
};

const TERMINAL: ShipmentStatus[] = ['delivered', 'failed', 'cancelled'];

export interface ShipmentRow {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string;
  warehouse_id: string;
  carrier: string;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  cost_minor: string | null;
  currency: string;
  status: ShipmentStatus;
  /** node-postgres returns `timestamptz` as a Date; `iso()` renders it for the contract and for events. */
  shipped_at: Date | string | null;
  delivered_at: Date | string | null;
  metadata: Record<string, unknown>;
}

/** Postgres timestamps reach us as Dates. Every contract field and every event payload wants an ISO string. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export interface ShipmentItem {
  order_line_item_id: string;
  quantity: number;
}

/** The Admin API `Shipment` schema. */
export interface StoreShipment {
  id: string;
  order_id: string;
  warehouse_id: string;
  carrier: string;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  cost: { amount_minor: number; currency: string } | null;
  status: ShipmentStatus;
  items: ShipmentItem[];
  shipped_at: string | null;
  delivered_at: string | null;
}

export interface CreateShipmentInput {
  orderId: string;
  warehouseId: string;
  carrier?: string | undefined;
  service?: string | undefined;
  items: ShipmentItem[];
  actor: Actor;
}

export interface UpdateShipmentInput {
  status?: ShipmentStatus | undefined;
  trackingNumber?: string | undefined;
  trackingUrl?: string | undefined;
  labelUrl?: string | undefined;
  costMinor?: number | undefined;
  actor: Actor;
}

export function renderShipment(row: ShipmentRow, items: ShipmentItem[]): StoreShipment {
  return {
    id: row.id,
    order_id: row.order_id,
    warehouse_id: row.warehouse_id,
    carrier: row.carrier,
    service: row.service,
    tracking_number: row.tracking_number,
    tracking_url: row.tracking_url,
    label_url: row.label_url,
    cost:
      row.cost_minor === null
        ? null
        : { amount_minor: Number(row.cost_minor), currency: row.currency },
    status: row.status,
    items,
    shipped_at: iso(row.shipped_at),
    delivered_at: iso(row.delivered_at),
  };
}

/**
 * `POST /admin/stores/{storeId}/orders/{orderId}/shipments` — plans a shipment for some or all line items.
 * One transaction: validate against what the order still owes, insert `shipment` + `shipment_item`, consume the
 * reservations (core 2.4's port), tell the orders module a shipment exists, emit `shipment.created`.
 */
export async function createShipment(
  client: ScopedClient,
  input: CreateShipmentInput,
): Promise<StoreShipment> {
  if (input.items.length === 0) {
    throw validationError('a shipment needs at least one item', { items: 'must not be empty' });
  }
  return client.transaction(async (tx) => {
    const order = await loadOrder(tx, input.orderId);
    const warehouse = await tx.query<{ id: string }>(
      `SELECT id FROM warehouse WHERE id = $1 AND organization_id = $2 AND is_active`,
      [input.warehouseId, order.organization_id],
    );
    if (!warehouse.rows[0]) {
      throw validationError('unknown warehouse', { warehouse_id: input.warehouseId });
    }
    const outstanding = await outstandingQuantities(tx, input.orderId);
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw validationError('quantity must be a positive integer', {
          order_line_item_id: item.order_line_item_id,
        });
      }
      const left = outstanding.get(item.order_line_item_id);
      if (left === undefined) {
        throw validationError('line item is not on this order', {
          order_line_item_id: item.order_line_item_id,
        });
      }
      if (item.quantity > left) {
        throw conflict('more than the order still owes', {
          order_line_item_id: item.order_line_item_id,
          outstanding: left,
          requested: item.quantity,
        });
      }
    }

    const carrier = input.carrier ?? shippingMethodCarrier(order) ?? 'manual';
    const inserted = await tx.query<ShipmentRow>(
      `INSERT INTO shipment (organization_id, store_id, order_id, warehouse_id, carrier, service, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [
        order.organization_id,
        order.store_id,
        order.id,
        input.warehouseId,
        carrier,
        input.service ?? null,
        order.currency,
      ],
    );
    const shipment = inserted.rows[0]!;
    for (const item of input.items) {
      await tx.query(
        `INSERT INTO shipment_item (organization_id, store_id, shipment_id, order_line_item_id, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          order.organization_id,
          order.store_id,
          shipment.id,
          item.order_line_item_id,
          item.quantity,
        ],
      );
    }

    await currentInventoryPort().consumeReservations({
      tx,
      organizationId: order.organization_id,
      storeId: order.store_id,
      orderId: order.id,
      warehouseId: input.warehouseId,
      shipmentId: shipment.id,
      actor: input.actor,
      items: input.items.map((item) => ({
        orderLineItemId: item.order_line_item_id,
        quantity: item.quantity,
      })),
    });
    // A shipment exists for this order: `confirmed → processing` (orders module, core 2.3). Advisory — an
    // order nobody confirmed yet keeps its status and still gets its shipment.
    await currentOrdersPort().shipmentCreated({
      tx,
      orderId: order.id,
      actor: input.actor,
    });

    await withEvents(tx, [
      await buildEvent({
        topic: 'shipment.created',
        organizationId: order.organization_id,
        storeId: order.store_id,
        aggregateType: 'shipment',
        aggregateId: shipment.id,
        actor: eventActor(input.actor),
        payload: {
          shipment_id: shipment.id,
          order_id: order.id,
          warehouse_id: input.warehouseId,
          carrier,
          service: input.service ?? null,
          items: input.items,
          destination_country: destinationCountry(order),
          currency: order.currency,
        },
      }),
    ]);
    return renderShipment(shipment, input.items);
  });
}

/**
 * Buys the carrier label for a planned shipment and moves it to `label_created`. Idempotent: a shipment that
 * already has a label is returned unchanged rather than buying a second one (the carrier call is not retried
 * either — see the EasyPost provider).
 */
export async function buyShipmentLabel(
  client: ScopedClient,
  shipmentId: string,
  input: { actor: Actor; parcel?: Parcel | undefined },
): Promise<StoreShipment> {
  return client.transaction(async (tx) => {
    const { shipment, items } = await loadShipment(tx, shipmentId);
    if (shipment.label_url) return renderShipment(shipment, items);
    if (shipment.status !== 'pending') {
      throw conflict('shipment is past label creation', {
        shipment_id: shipmentId,
        status: shipment.status,
      });
    }
    const order = await loadOrder(tx, shipment.order_id);
    const store = await tx.query<{ code: string; settings: Record<string, unknown> | null }>(
      `SELECT code, settings FROM store WHERE id = $1`,
      [shipment.store_id],
    );
    const storeRow = store.rows[0];
    if (!storeRow) throw notFound('store', shipment.store_id);
    const config = carrierConfigFor(storeRow.settings);
    const provider = resolveProvider(config.provider, storeRow.code);
    if (!provider) {
      throw new AppError('internal', 'no carrier provider is configured for this store', {
        provider: config.provider,
      });
    }
    const origin = await warehouseAddress(tx, shipment.warehouse_id);
    const destination = order.shipping_address ? toCarrierAddress(order.shipping_address) : null;
    if (!origin || !destination) {
      throw validationError('shipment has no usable origin or destination address', {
        shipment_id: shipmentId,
      });
    }

    const parcel = input.parcel ?? config.defaultParcel;
    let label;
    try {
      const rates = await provider.rates({
        from: origin,
        to: destination,
        parcels: [parcel],
        currency: shipment.currency,
        ...(config.carrierAccountIds.length > 0
          ? { carrierAccountIds: config.carrierAccountIds }
          : {}),
        ...(shipment.service ? { services: [shipment.service] } : {}),
      });
      const chosen =
        rates.find((rate) => rate.service === shipment.service) ??
        [...rates].sort((a, b) => a.priceMinor - b.priceMinor)[0];
      if (!chosen) {
        throw new CarrierError(
          provider.name,
          404,
          'rates',
          'carrier quoted nothing for this shipment',
        );
      }
      label = await provider.buyLabel({
        rateId: chosen.rateId,
        reference: shipment.id,
        labelFormat: config.labelFormat,
      });
    } catch (error) {
      const carrierError =
        error instanceof CarrierError
          ? error
          : new CarrierError(provider.name, 0, 'buyLabel', 'unexpected provider failure');
      // 502: our request was fine, the carrier was not. The shipment stays `pending` and can be retried.
      throw new AppError(
        'internal',
        `carrier could not produce a label: ${carrierError.message}`,
        {
          shipment_id: shipmentId,
          provider: carrierError.provider,
          status: carrierError.status,
        },
        502,
      );
    }

    const updated = await tx.query<ShipmentRow>(
      `UPDATE shipment SET status = 'label_created', carrier = $2, service = $3, tracking_number = $4,
              tracking_url = $5, label_url = $6, cost_minor = $7, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        shipmentId,
        label.carrier,
        label.service,
        label.trackingNumber,
        label.trackingUrl,
        label.labelUrl,
        label.costMinor,
      ],
    );
    return renderShipment(updated.rows[0]!, items);
  });
}

/**
 * `PATCH /admin/shipments/{shipmentId}` — attaches tracking or a label and advances the status. An illegal
 * transition (backwards, or out of a terminal state) is a 409; the legal ones each emit exactly one event.
 */
export async function updateShipment(
  client: ScopedClient,
  shipmentId: string,
  input: UpdateShipmentInput,
): Promise<StoreShipment> {
  return client.transaction(async (tx) => {
    const { shipment, items } = await loadShipment(tx, shipmentId);
    if (input.status && !canTransition(shipment.status, input.status)) {
      throw conflict('illegal shipment transition', {
        shipment_id: shipmentId,
        from: shipment.status,
        to: input.status,
      });
    }
    return applyTransition(tx, shipment, items, {
      status: input.status,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl,
      labelUrl: input.labelUrl,
      costMinor: input.costMinor,
      actor: input.actor,
    });
  });
}

/** Forward only; a terminal status is final. Equal statuses are refused here (the webhook path ignores them). */
export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  if (from === to) return false;
  if (TERMINAL.includes(from)) return false;
  if (to === 'cancelled') return from === 'pending' || from === 'label_created';
  if (to === 'failed') return true;
  return RANK[to] > RANK[from];
}

export interface TransitionInput {
  status?: ShipmentStatus | undefined;
  trackingNumber?: string | undefined;
  trackingUrl?: string | undefined;
  labelUrl?: string | undefined;
  costMinor?: number | undefined;
  /** Carrier's own timestamp for the scan, when there is one. */
  occurredAt?: string | undefined;
  actor: Actor;
}

/**
 * The one writer of a shipment's status. Writes the row, the events for the statuses it passes through, and the
 * order's fulfilment status — all on the caller's transaction.
 *
 * Skipped scans are filled in: a shipment that jumps straight to `delivered` still emits `shipment.shipped`
 * first, because accounting derives shipping cost and COGS timing from that event and must never miss it.
 */
export async function applyTransition(
  tx: Queryable,
  shipment: ShipmentRow,
  items: ShipmentItem[],
  input: TransitionInput,
): Promise<StoreShipment> {
  const at = input.occurredAt ?? new Date().toISOString();
  const target = input.status;
  const passesShipped =
    target !== undefined &&
    RANK[target] >= RANK.shipped &&
    RANK[target] <= RANK.delivered &&
    RANK[shipment.status] < RANK.shipped;
  const reachesDelivered = target === 'delivered' && shipment.status !== 'delivered';

  const shippedAt = iso(shipment.shipped_at) ?? (passesShipped ? at : null);
  const deliveredAt = iso(shipment.delivered_at) ?? (reachesDelivered ? at : null);

  const updated = await tx.query<ShipmentRow>(
    `UPDATE shipment SET
       status = coalesce($2, status),
       tracking_number = coalesce($3, tracking_number),
       tracking_url = coalesce($4, tracking_url),
       label_url = coalesce($5, label_url),
       cost_minor = coalesce($6, cost_minor),
       shipped_at = $7,
       delivered_at = $8,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      shipment.id,
      target ?? null,
      input.trackingNumber ?? null,
      input.trackingUrl ?? null,
      input.labelUrl ?? null,
      input.costMinor ?? null,
      shippedAt,
      deliveredAt,
    ],
  );
  const row = updated.rows[0]!;

  const events = [];
  if (passesShipped) {
    const legal = await tx.query<{ legal_entity_id: string }>(
      `SELECT s.legal_entity_id FROM store s WHERE s.id = $1`,
      [row.store_id],
    );
    events.push(
      await buildEvent({
        topic: 'shipment.shipped',
        organizationId: row.organization_id,
        storeId: row.store_id,
        aggregateType: 'shipment',
        aggregateId: row.id,
        actor: eventActor(input.actor),
        payload: {
          shipment_id: row.id,
          order_id: row.order_id,
          legal_entity_id: legal.rows[0]!.legal_entity_id,
          warehouse_id: row.warehouse_id,
          carrier: row.carrier,
          service: row.service,
          tracking_number: row.tracking_number,
          cost_minor: row.cost_minor === null ? null : Number(row.cost_minor),
          currency: row.currency,
          items,
          shipped_at: shippedAt ?? at,
        },
      }),
    );
  }
  if (reachesDelivered) {
    events.push(
      await buildEvent({
        topic: 'shipment.delivered',
        organizationId: row.organization_id,
        storeId: row.store_id,
        aggregateType: 'shipment',
        aggregateId: row.id,
        actor: eventActor(input.actor),
        payload: {
          shipment_id: row.id,
          order_id: row.order_id,
          delivered_at: deliveredAt ?? at,
        },
      }),
    );
  }
  if (events.length > 0) await withEvents(tx, events);

  if (target === 'cancelled') {
    await currentInventoryPort().releaseReservations({
      tx,
      organizationId: row.organization_id,
      storeId: row.store_id,
      orderId: row.order_id,
      shipmentId: row.id,
      actor: input.actor,
      items: items.map((item) => ({
        orderLineItemId: item.order_line_item_id,
        quantity: item.quantity,
      })),
    });
  }

  // What the order should know: these quantities left the warehouse, and later that they arrived. The orders
  // module owns `fulfilled_quantity`, `fulfillment_status` and `status` — shipping only reports the facts.
  const orders = currentOrdersPort();
  const call = { tx, orderId: row.order_id, actor: input.actor };
  if (passesShipped) {
    await orders.shipped({
      ...call,
      items: items.map((item) => ({
        orderLineItemId: item.order_line_item_id,
        quantity: item.quantity,
      })),
    });
  }
  if (reachesDelivered) await orders.delivered(call);
  return renderShipment(row, items);
}

export async function getShipment(
  client: ScopedClient,
  shipmentId: string,
): Promise<StoreShipment> {
  return client.transaction(async (tx) => {
    const { shipment, items } = await loadShipment(tx, shipmentId);
    return renderShipment(shipment, items);
  });
}

export async function listOrderShipments(
  client: ScopedClient,
  orderId: string,
): Promise<StoreShipment[]> {
  return client.transaction(async (tx) => {
    const rows = await tx.query<ShipmentRow>(
      `SELECT * FROM shipment WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    );
    const out: StoreShipment[] = [];
    for (const row of rows.rows) out.push(renderShipment(row, await loadItems(tx, row.id)));
    return out;
  });
}

/**
 * Reads one key of a shipment's `metadata`. The fulfillment module keeps its 3PL reference there (task 2.4): the
 * frozen schema has no fulfilment table, and `shipment.metadata` is this module's own column.
 */
export async function readShipmentMetadata(
  client: ScopedClient,
  shipmentId: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  const r = await client.query<{ value: Record<string, unknown> | null }>(
    `SELECT metadata -> $2 AS value FROM shipment WHERE id = $1`,
    [shipmentId, key],
  );
  const row = r.rows[0];
  if (!row) throw notFound('shipment', shipmentId);
  return row.value ?? null;
}

/**
 * Replaces one key of a shipment's `metadata`, leaving every other key alone. Not a status change, so no event:
 * the facts a 3PL reports that do move the shipment go through `updateShipment`.
 */
export async function writeShipmentMetadata(
  client: ScopedClient,
  shipmentId: string,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  const r = await client.query(
    `UPDATE shipment SET metadata = jsonb_set(metadata, ARRAY[$2::text], $3::jsonb, true), updated_at = now()
      WHERE id = $1`,
    [shipmentId, key, JSON.stringify(value)],
  );
  if ((r.rowCount ?? 0) === 0) throw notFound('shipment', shipmentId);
}

// ---- internals ----

interface OrderRow {
  id: string;
  organization_id: string;
  store_id: string;
  currency: string;
  shipping_address: ContractAddress | null;
  shipping_method: { carrier?: string } | null;
}

async function loadOrder(tx: Queryable, orderId: string): Promise<OrderRow> {
  const r = await tx.query<OrderRow>(
    `SELECT id, organization_id, store_id, currency, shipping_address, shipping_method
       FROM "order" WHERE id = $1`,
    [orderId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('order', orderId);
  return row;
}

export async function loadShipment(
  tx: Queryable,
  shipmentId: string,
): Promise<{ shipment: ShipmentRow; items: ShipmentItem[] }> {
  const r = await tx.query<ShipmentRow>(`SELECT * FROM shipment WHERE id = $1`, [shipmentId]);
  const shipment = r.rows[0];
  if (!shipment) throw notFound('shipment', shipmentId);
  return { shipment, items: await loadItems(tx, shipmentId) };
}

async function loadItems(tx: Queryable, shipmentId: string): Promise<ShipmentItem[]> {
  const r = await tx.query<{ order_line_item_id: string; quantity: number }>(
    `SELECT order_line_item_id, quantity FROM shipment_item WHERE shipment_id = $1 ORDER BY created_at, id`,
    [shipmentId],
  );
  return r.rows.map((row) => ({
    order_line_item_id: row.order_line_item_id,
    quantity: row.quantity,
  }));
}

/** Per line: ordered quantity minus what live (not cancelled) shipments already cover. */
async function outstandingQuantities(tx: Queryable, orderId: string): Promise<Map<string, number>> {
  const r = await tx.query<{ id: string; quantity: number; shipped: string }>(
    `SELECT l.id, l.quantity,
            coalesce((SELECT sum(si.quantity) FROM shipment_item si
                        JOIN shipment s ON s.id = si.shipment_id AND s.status <> 'cancelled'
                       WHERE si.order_line_item_id = l.id), 0)::text AS shipped
       FROM order_line_item l WHERE l.order_id = $1`,
    [orderId],
  );
  return new Map(r.rows.map((row) => [row.id, row.quantity - Number(row.shipped)]));
}

async function warehouseAddress(tx: Queryable, warehouseId: string) {
  const r = await tx.query<{ address: Record<string, unknown>; country: string }>(
    `SELECT address, country FROM warehouse WHERE id = $1`,
    [warehouseId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const a = row.address;
  const line1 = typeof a.line1 === 'string' ? a.line1 : null;
  const city = typeof a.city === 'string' ? a.city : null;
  const postal = typeof a.postal_code === 'string' ? a.postal_code : null;
  if (!line1 || !city || !postal) return null;
  return toCarrierAddress({
    first_name: typeof a.first_name === 'string' ? a.first_name : 'Warehouse',
    last_name: typeof a.last_name === 'string' ? a.last_name : '',
    company: typeof a.company === 'string' ? a.company : null,
    line1,
    line2: typeof a.line2 === 'string' ? a.line2 : null,
    city,
    region: typeof a.region === 'string' ? a.region : null,
    postal_code: postal,
    country: (typeof a.country === 'string' ? a.country : row.country).toUpperCase(),
    phone: typeof a.phone === 'string' ? a.phone : null,
  });
}

function resolveProvider(name: string, storeCode: string): CarrierProvider | null {
  const registered = carrierProvider(name);
  if (registered) return registered;
  if (name === 'easypost') {
    const credentials = easyPostCredentialsFor(storeCode);
    if (credentials) return createEasyPostProvider({ apiKey: credentials.apiKey });
  }
  return null;
}

function shippingMethodCarrier(order: OrderRow): string | null {
  const carrier = order.shipping_method?.carrier;
  return typeof carrier === 'string' && carrier !== '' ? carrier : null;
}

/** Country only — the event never carries the address itself. */
function destinationCountry(order: OrderRow): string {
  return (order.shipping_address?.country ?? 'XX').toUpperCase();
}
