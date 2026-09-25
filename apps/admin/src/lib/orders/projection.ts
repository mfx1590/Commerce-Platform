/**
 * What an order looks like once it may cross to a client component (see `src/lib/client-safe.ts`
 * for the rule and the reason). None of the picked fields carries PII: line items, payments,
 * refunds, shipments and returns are ids, SKUs, quantities, money and statuses; the list row keeps
 * the email the table shows and drops the `customer_id` it does not.
 */

import type { AdminComponents } from '../api/admin-client';
import { makeProjection, type ClientSafe } from '../client-safe';

type Order = AdminComponents['Order'];
type OrderSummary = AdminComponents['OrderSummary'];

/** Cancel / refund / request-return: state, lines, payments, refunds, and the currency for money. */
export type OrderForActions = ClientSafe<
  Pick<Order, 'id' | 'display_id' | 'status' | 'currency' | 'items' | 'payments' | 'refunds'>
>;
export const forActions = (order: Order): OrderForActions =>
  makeProjection(order, ['id', 'display_id', 'status', 'currency', 'items', 'payments', 'refunds']);

/** The lines table with its pre-fulfilment edits. */
export type OrderForLines = ClientSafe<Pick<Order, 'id' | 'items'>>;
export const forLines = (order: Order): OrderForLines => makeProjection(order, ['id', 'items']);

/** Shipments and returns with the `operations` actions. */
export type OrderForFulfilment = ClientSafe<Pick<Order, 'id' | 'items' | 'shipments' | 'returns'>>;
export const forFulfilment = (order: Order): OrderForFulfilment =>
  makeProjection(order, ['id', 'items', 'shipments', 'returns']);

/** One row of the orders list: exactly the columns the table renders. */
export type OrderRow = ClientSafe<
  Pick<
    OrderSummary,
    | 'id'
    | 'display_id'
    | 'email'
    | 'status'
    | 'payment_status'
    | 'fulfillment_status'
    | 'total'
    | 'placed_at'
  >
>;
export const forOrderRow = (order: OrderSummary): OrderRow =>
  makeProjection(order, [
    'id',
    'display_id',
    'email',
    'status',
    'payment_status',
    'fulfillment_status',
    'total',
    'placed_at',
  ]);
export const forOrderRows = (orders: readonly OrderSummary[]): OrderRow[] =>
  orders.map(forOrderRow);

/** The keys that must never reach a client component; the tests walk every projection for them. */
export const ORDER_PII_KEYS = [
  'customer_id',
  'shipping_address',
  'billing_address',
  'metadata',
] as const;
