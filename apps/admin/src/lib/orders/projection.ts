/**
 * What an order looks like once it may cross to a client component.
 *
 * Next.js serialises a client component's props wholesale into the Flight payload, so handing a
 * panel the full `Order` puts the customer's email and both addresses in the browser even when
 * the panel never reads them (the #263 review caught exactly that). Each panel therefore receives
 * a projection built here — an object with exactly the keys it uses and nothing else — and the
 * projection types are **branded**, so the full `Order` does not typecheck as a panel prop: the
 * only way to obtain one is through these functions.
 *
 * None of the picked fields carries PII: line items, payments, refunds, shipments and returns are
 * ids, SKUs, quantities, money and statuses.
 */

import type { AdminComponents } from '../api/admin-client';

type Order = AdminComponents['Order'];

declare const clientSafe: unique symbol;
/** A nominal marker: only `projection.ts` produces values of these types. */
type ClientSafe<T> = T & { readonly [clientSafe]: true };

const brand = <T extends object>(value: T): ClientSafe<T> => value as ClientSafe<T>;

/** Cancel / refund / request-return: state, lines, payments, refunds, and the currency for money. */
export type OrderForActions = ClientSafe<
  Pick<Order, 'id' | 'display_id' | 'status' | 'currency' | 'items' | 'payments' | 'refunds'>
>;

export function forActions(order: Order): OrderForActions {
  return brand({
    id: order.id,
    display_id: order.display_id,
    status: order.status,
    currency: order.currency,
    items: order.items,
    payments: order.payments,
    refunds: order.refunds,
  });
}

/** The lines table with its pre-fulfilment edits. */
export type OrderForLines = ClientSafe<Pick<Order, 'id' | 'items'>>;

export function forLines(order: Order): OrderForLines {
  return brand({ id: order.id, items: order.items });
}

/** Shipments and returns with the `operations` actions. */
export type OrderForFulfilment = ClientSafe<Pick<Order, 'id' | 'items' | 'shipments' | 'returns'>>;

export function forFulfilment(order: Order): OrderForFulfilment {
  return brand({
    id: order.id,
    items: order.items,
    shipments: order.shipments,
    returns: order.returns,
  });
}

/** The keys that must never reach a client component; the test walks every projection for them. */
export const ORDER_PII_KEYS = [
  'email',
  'customer_id',
  'shipping_address',
  'billing_address',
  'metadata',
] as const;
