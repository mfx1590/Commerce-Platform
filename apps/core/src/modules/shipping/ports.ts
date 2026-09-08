// Local interface mirrors for the two core modules this one leans on but does not own. Window 1 delivers the
// real functions in core 2.3 (orders: fulfilment status transitions) and 2.4 (inventory: reservations); until
// they exist as public exports, shipping calls these ports and the interim implementations below. Swapping in
// the real functions is one call to `setOrdersPort` / `setInventoryPort` at boot — no call site changes.
//
// REQUEST filed with window 1 naming the exact shapes; if theirs differ, only this file moves.
import type { Queryable } from '@platform/db';

export interface ShipmentLineRef {
  orderLineItemId: string;
  quantity: number;
}

export interface InventoryPort {
  /**
   * A shipment left the warehouse: turn the order's reservations into a real stock decrement. Idempotent per
   * shipment — it is called inside the shipping transaction and must never double-decrement on a retry.
   */
  consumeReservations(input: {
    tx: Queryable;
    organizationId: string;
    storeId: string;
    orderId: string;
    warehouseId: string;
    shipmentId: string;
    items: ShipmentLineRef[];
  }): Promise<void>;

  /** A planned shipment was cancelled before picking: the reservation goes back to available (task 2.4). */
  releaseReservations(input: {
    tx: Queryable;
    organizationId: string;
    storeId: string;
    orderId: string;
    shipmentId: string;
    items: ShipmentLineRef[];
  }): Promise<void>;
}

export type FulfillmentStatus =
  'unfulfilled' | 'partially_fulfilled' | 'fulfilled' | 'partially_returned' | 'returned';

export interface OrdersPort {
  /**
   * Applies the fulfilment status shipping derived from what has actually shipped. Core 2.3 owns the order state
   * machine; this port exists so shipping never encodes it.
   */
  setFulfillmentStatus(input: {
    tx: Queryable;
    organizationId: string;
    storeId: string;
    orderId: string;
    status: FulfillmentStatus;
  }): Promise<void>;
}

/**
 * Interim inventory port: does nothing. Reservations are core 2.4's tables and rules, and a wrong decrement is
 * worse than a missing one — the shipment rows and events are still correct, and 2.4's function replaces this.
 */
export const noopInventoryPort: InventoryPort = {
  async consumeReservations() {
    /* core 2.4 */
  },
  async releaseReservations() {
    /* core 2.4 */
  },
};

/**
 * Interim orders port: writes `order.fulfillment_status` directly, inside the shipping transaction. It is the
 * one column shipping must move for the admin and the storefront to be truthful about a part-shipped order.
 * Replaced by core 2.3's public transition function the moment it exists (REQUEST filed).
 */
export const directOrdersPort: OrdersPort = {
  async setFulfillmentStatus({ tx, orderId, status }) {
    await tx.query(
      `UPDATE "order" SET fulfillment_status = $2, updated_at = now() WHERE id = $1 AND fulfillment_status <> $2`,
      [orderId, status],
    );
  },
};

let inventoryPort: InventoryPort = noopInventoryPort;
let ordersPort: OrdersPort = directOrdersPort;

/** Registers core 2.4's inventory functions. Returns the previous port so tests can restore it. */
export function setInventoryPort(next: InventoryPort): InventoryPort {
  const previous = inventoryPort;
  inventoryPort = next;
  return previous;
}

/** Registers core 2.3's order transition function. Returns the previous port so tests can restore it. */
export function setOrdersPort(next: OrdersPort): OrdersPort {
  const previous = ordersPort;
  ordersPort = next;
  return previous;
}

export function currentInventoryPort(): InventoryPort {
  return inventoryPort;
}

export function currentOrdersPort(): OrdersPort {
  return ordersPort;
}
