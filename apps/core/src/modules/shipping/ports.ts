// How shipping reaches the two core modules it leans on but does not own. Both are window 1's and both are on
// main: the shapes were agreed on #191 and delivered by core 2.4 (inventory) and 2.6 (orders `…InTx` variants).
//
// **Orders:** `markShipmentCreatedInTx` when a shipment is planned, `markShippedInTx` with the quantities that
// actually left, `markDeliveredInTx` when the carrier says so. Shipping encodes none of that state machine; it
// reports facts and the orders module decides.
//
// **Inventory:** `consumeReservationsForShipment` when a shipment is planned, `releaseReservationsForShipment` when
// a planned shipment is cancelled. Both are idempotent per shipment on window 1's side.
//
// Everything runs on shipping's own transaction, so the shipment rows, their events, the order's status and the
// stock movements commit together or not at all.
//
// Orders calls are **advisory**: an order can legitimately refuse a transition (a shipment planned before anyone
// confirmed the order; delivery before every line has shipped). That 409 must not fail the shipment or make a
// carrier retry its webhook for ever, so it is reported in the outcome instead of thrown. Each call runs inside a
// SAVEPOINT, and a refusal rolls back to it — so a call that wrote some rows before refusing leaves nothing behind.
// Inventory calls are not advisory: a stock failure is a real failure and rolls the shipment back.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { consumeReservationsForShipment, releaseReservationsForShipment } from '../inventory';
import { markDeliveredInTx, markShipmentCreatedInTx, markShippedInTx } from '../orders';

export interface ShipmentLineRef {
  orderLineItemId: string;
  quantity: number;
}

export interface InventoryCall {
  tx: Queryable;
  organizationId: string;
  storeId: string;
  orderId: string;
  shipmentId: string;
  items: ShipmentLineRef[];
  actor: Actor;
}

export interface InventoryPort {
  /** A shipment was planned: the order's reservations become a stock decrement from that warehouse. */
  consumeReservations(input: InventoryCall & { warehouseId: string }): Promise<void>;
  /** A planned shipment was cancelled: the goods go back on hand and the reservation re-opens. */
  releaseReservations(input: InventoryCall): Promise<void>;
}

/** The real inventory module (core 2.4). */
export const coreInventoryPort: InventoryPort = {
  async consumeReservations({ tx, ...input }) {
    await consumeReservationsForShipment(tx, input);
  },
  async releaseReservations({ tx, ...input }) {
    await releaseReservationsForShipment(tx, input);
  },
};

let inventoryPort: InventoryPort = coreInventoryPort;

/** Replaces the inventory port (tests). Returns the previous one so it can be restored. */
export function setInventoryPort(next: InventoryPort): InventoryPort {
  const previous = inventoryPort;
  inventoryPort = next;
  return previous;
}

export function currentInventoryPort(): InventoryPort {
  return inventoryPort;
}

export interface OrdersCall {
  tx: Queryable;
  orderId: string;
  actor: Actor;
}

export interface OrdersOutcome {
  applied: boolean;
  /** Why the orders module refused, when it did. */
  reason?: string;
}

/** What shipping asks the orders module to record. Each call is advisory: a 409 is reported, never thrown. */
export interface OrdersPort {
  /** A shipment now exists for this order (`confirmed → processing`). */
  shipmentCreated(input: OrdersCall): Promise<OrdersOutcome>;
  /** These quantities actually left the warehouse (`fulfilled_quantity`, then the fulfilment status). */
  shipped(input: OrdersCall & { items: ShipmentLineRef[] }): Promise<OrdersOutcome>;
  /** The carrier reported delivery (`processing → completed`, only once the order is fulfilled). */
  delivered(input: OrdersCall): Promise<OrdersOutcome>;
}

let savepointSeq = 0;

/**
 * Runs an orders call inside a SAVEPOINT on our transaction. A `conflict` rolls back to the savepoint and becomes
 * an outcome; anything else propagates and rolls the whole shipment back.
 */
async function advisory(
  tx: Queryable,
  fn: () => Promise<unknown>,
  what: string,
): Promise<OrdersOutcome> {
  const savepoint = `shipping_orders_${++savepointSeq}`;
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    await fn();
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { applied: true };
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    if (error instanceof AppError && error.code === 'conflict') {
      return { applied: false, reason: `${what}: ${error.message}` };
    }
    throw error;
  }
}

/** The real orders module (core 2.3, transaction-taking variants from 2.6). */
export const coreOrdersPort: OrdersPort = {
  async shipmentCreated({ tx, orderId, actor }) {
    return advisory(
      tx,
      () => markShipmentCreatedInTx(tx, orderId, actor),
      'order status not advanced',
    );
  },
  async shipped({ tx, orderId, actor, items }) {
    if (items.length === 0) return { applied: false, reason: 'nothing shipped' };
    return advisory(
      tx,
      () =>
        markShippedInTx(
          tx,
          orderId,
          items.map((item) => ({ lineItemId: item.orderLineItemId, quantity: item.quantity })),
          actor,
        ),
      'fulfilment not recorded',
    );
  },
  async delivered({ tx, orderId, actor }) {
    return advisory(tx, () => markDeliveredInTx(tx, orderId, actor), 'order not completed');
  },
};

let ordersPort: OrdersPort = coreOrdersPort;

/** Replaces the orders port (tests). Returns the previous one. */
export function setOrdersPort(next: OrdersPort): OrdersPort {
  const previous = ordersPort;
  ordersPort = next;
  return previous;
}

export function currentOrdersPort(): OrdersPort {
  return ordersPort;
}
