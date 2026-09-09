// How shipping reaches the two core modules it leans on but does not own.
//
// **Orders (core 2.3, merged):** the real functions from `../orders` — `markShipmentCreated` when a shipment is
// planned, `markShipped` with the quantities that actually left, `markDelivered` when the carrier says so.
// Shipping encodes none of that state machine; it reports facts and window 1's module decides.
//
// **Inventory (core 2.4, NOT merged yet):** `apps/core/src/modules/inventory` does not exist on main — the
// reservation functions are still ahead of us. `InventoryPort` keeps mirroring them with a no-op default, and
// `setInventoryPort` swaps in the real ones the day they land (REQUEST #191).
//
// Two details worth knowing before changing anything here:
//
//  - The orders functions take a `ScopedClient` and open their own transaction. Shipping calls them from
//    *inside* its transaction through `clientOn(tx)`, so the shipment rows, their events and the order's status
//    commit together. Handing them the outer client instead would deadlock: our INSERT holds a key-share lock on
//    the order row that their `SELECT … FOR UPDATE` would wait for, on a connection we are waiting for.
//  - An order can legitimately be in a state that refuses the transition (a shipment planned before anyone
//    confirmed the order). That is a 409 from the orders module, and it must not fail the shipment or make a
//    carrier retry its webhook forever: `conflict` is swallowed and reported, anything else propagates.
import type { Queryable, ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { markDelivered, markShipmentCreated, markShipped } from '../orders';

export interface ShipmentLineRef {
  orderLineItemId: string;
  quantity: number;
}

export interface InventoryPort {
  /**
   * A shipment left the warehouse: turn the order's reservations into a real stock decrement. `shipmentId` is
   * passed so the implementation can be idempotent per shipment — shipping may retry, and a double decrement is
   * much worse than a late one.
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

  /** A planned shipment was cancelled before picking: the reservation goes back to available. */
  releaseReservations(input: {
    tx: Queryable;
    organizationId: string;
    storeId: string;
    orderId: string;
    shipmentId: string;
    items: ShipmentLineRef[];
  }): Promise<void>;
}

/**
 * Still the interim implementation: core 2.4 has not merged, so there is nothing to call. The shipment rows and
 * events are correct without it, and a wrong decrement would be worse than a missing one.
 */
export const noopInventoryPort: InventoryPort = {
  async consumeReservations() {
    /* core 2.4 — see REQUEST #191 */
  },
  async releaseReservations() {
    /* core 2.4 — see REQUEST #191 */
  },
};

let inventoryPort: InventoryPort = noopInventoryPort;

/** Registers core 2.4's inventory functions once they exist. Returns the previous port so tests can restore it. */
export function setInventoryPort(next: InventoryPort): InventoryPort {
  const previous = inventoryPort;
  inventoryPort = next;
  return previous;
}

export function currentInventoryPort(): InventoryPort {
  return inventoryPort;
}

/**
 * Presents an in-flight transaction as a `ScopedClient` so a module function that opens its own transaction runs
 * inside ours instead. `transaction(fn)` is `fn(tx)`: the tenant context and RLS scope are already applied by the
 * outer client, and a throw still rolls the whole thing back because it propagates to our transaction.
 */
export function clientOn(tx: Queryable, client: ScopedClient): ScopedClient {
  return {
    query: tx.query.bind(tx),
    transaction: <T>(fn: (inner: Queryable) => Promise<T>) => fn(tx),
    context: client.context,
    scope: client.scope,
  };
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

export interface OrdersCall {
  tx: Queryable;
  client: ScopedClient;
  orderId: string;
  actor: Actor;
}

export interface OrdersOutcome {
  applied: boolean;
  /** Why the orders module refused, when it did. */
  reason?: string;
}

/**
 * Runs an orders call on our transaction and turns its 409 into an outcome. Anything else is a real failure and
 * rolls the shipment back with it.
 */
async function advisory(fn: () => Promise<unknown>, what: string): Promise<OrdersOutcome> {
  try {
    await fn();
    return { applied: true };
  } catch (error) {
    if (error instanceof AppError && error.code === 'conflict') {
      // e.g. a shipment planned before the order was confirmed, or delivery before every line has shipped.
      return { applied: false, reason: `${what}: ${error.message}` };
    }
    throw error;
  }
}

/** The real orders module (core 2.3). */
export const coreOrdersPort: OrdersPort = {
  async shipmentCreated({ tx, client, orderId, actor }) {
    return advisory(
      () => markShipmentCreated(clientOn(tx, client), orderId, actor),
      'order status not advanced',
    );
  },
  async shipped({ tx, client, orderId, actor, items }) {
    if (items.length === 0) return { applied: false, reason: 'nothing shipped' };
    return advisory(
      () =>
        markShipped(
          clientOn(tx, client),
          orderId,
          items.map((item) => ({ lineItemId: item.orderLineItemId, quantity: item.quantity })),
          actor,
        ),
      'fulfilment not recorded',
    );
  },
  async delivered({ tx, client, orderId, actor }) {
    return advisory(
      () => markDelivered(clientOn(tx, client), orderId, actor),
      'order not completed',
    );
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
