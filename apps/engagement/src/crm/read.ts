// The database reads the rollup is computed from (#555).
//
// Through a STORE-SCOPED client for the event's own store, like the consent read (#554): a customer belongs to
// one store, and so do their orders. Read-only, and nothing but the columns the rollup needs — in particular
// not `email`, not the addresses: the PII comes from the Admin API with this service's own permission
// (`admin-api.ts`), never from a direct table read, so the permission check is never bypassed.

import type { Queryable, ScopedClient } from '@platform/db';
import type { RollupOrder, RollupRefund } from './rollup.js';

/** Everything one customer's rollup needs, in two statements. */
export interface CustomerOrderHistory {
  orders: RollupOrder[];
  refunds: RollupRefund[];
}

/**
 * One customer's orders and the refunds against them. Bounded by one customer, so it stays a small read even
 * for a frequent buyer; a customer with thousands of orders would want an aggregate in SQL instead, and the
 * rollup is a pure function precisely so that swap changes nothing else.
 */
export async function readOrderHistory(
  q: ScopedClient | Queryable,
  customerId: string,
): Promise<CustomerOrderHistory> {
  const orders = await q.query(
    `SELECT id, status, total_minor, currency, placed_at
       FROM "order"
      WHERE customer_id = $1`,
    [customerId],
  );
  const refunds = await q.query(
    `SELECT r.order_id, r.status, r.amount_minor, r.currency
       FROM refund r
       JOIN "order" o ON o.id = r.order_id
      WHERE o.customer_id = $1`,
    [customerId],
  );
  return {
    orders: orders.rows as RollupOrder[],
    refunds: refunds.rows as RollupRefund[],
  };
}

/** The store's code and default currency — the rollup's headline currency and the contact's store. */
export interface StoreFacts {
  code: string;
  defaultCurrency: string;
}

export async function readStoreFacts(
  q: ScopedClient | Queryable,
  storeId: string,
): Promise<StoreFacts | null> {
  const r = await q.query('SELECT code, default_currency FROM store WHERE id = $1', [storeId]);
  const row = r.rows[0] as { code: string; default_currency: string } | undefined;
  return row ? { code: row.code, defaultCurrency: row.default_currency } : null;
}
