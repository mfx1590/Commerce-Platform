/**
 * What can still happen to an order line, as arithmetic over the contract's counters.
 *
 * `LineItem` carries `quantity`, `fulfilled_quantity` and `returned_quantity`; everything a form
 * may offer follows from those three. Pure, so the guards are unit-tested without a screen, and so
 * the same numbers cap the inputs client-side that the core enforces server-side.
 */

import type { AdminComponents } from '../api/admin-client';

export type LineItem = AdminComponents['LineItem'];
export type Order = AdminComponents['Order'];

/** Units not yet put into a shipment. */
export function fulfillable(line: LineItem): number {
  return Math.max(0, line.quantity - line.fulfilled_quantity);
}

/** Units shipped and not yet returned — the most a return request may ask for. */
export function returnable(line: LineItem): number {
  return Math.max(0, line.fulfilled_quantity - line.returned_quantity);
}

/**
 * The contract's line edits are "before fulfilment": a line with anything already shipped can no
 * longer be lowered or cancelled from here.
 */
export function editable(line: LineItem): boolean {
  return line.fulfilled_quantity === 0;
}

/** Lowering means strictly lower than now and at least one (the contract: `minimum: 1`). */
export function canLowerTo(line: LineItem, quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= 1 && quantity < line.quantity;
}

/**
 * The last line cannot be cancelled — the contract says "cancel the order" — so the UI does not
 * offer it rather than letting the server refuse with a 409.
 */
export function isLastLine(order: Pick<Order, 'items'>): boolean {
  return order.items.length <= 1;
}

/** An order can be cancelled while nothing has shipped and it is not already closed. */
export function cancellable(order: Pick<Order, 'status' | 'items'>): boolean {
  if (order.status === 'cancelled' || order.status === 'completed') return false;
  return order.items.every((line) => line.fulfilled_quantity === 0);
}

export function hasFulfillableLines(order: Pick<Order, 'items'>): boolean {
  return order.items.some((line) => fulfillable(line) > 0);
}

export function hasReturnableLines(order: Pick<Order, 'items'>): boolean {
  return order.items.some((line) => returnable(line) > 0);
}
