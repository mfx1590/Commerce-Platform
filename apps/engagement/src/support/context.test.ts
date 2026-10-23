// The context assembler: the shapes the contract allows, and the glance summary. Pure — no server, no database.

import { describe, expect, it } from 'vitest';
import type { RawCustomer, RawOrderDetail, RawOrderSummary, SupportReader } from './admin-api.js';
import { buildContext, summarise } from './context.js';
import { SupportError, type SupportOrder } from './types.js';

const CUSTOMER = '77777777-7777-4777-8777-777777777777';

const customer: RawCustomer = {
  id: CUSTOMER,
  email: 'ada@example.test',
  first_name: 'Ada',
  last_name: null,
  status: 'registered',
  created_at: '2026-10-01T10:00:00.000Z',
};

const order = (over: Partial<SupportOrder> = {}): SupportOrder => ({
  id: 'o1',
  display_id: 1001,
  status: 'completed',
  payment_status: 'captured',
  fulfillment_status: 'fulfilled',
  total_minor: 10000,
  currency: 'EUR',
  placed_at: '2026-10-05T10:00:00.000Z',
  payments: [],
  refunds: [],
  shipments: [],
  returns: [],
  ...over,
});

function reader(over: Partial<SupportReader> = {}): SupportReader {
  return {
    async getCustomer() {
      return customer;
    },
    async listOrders() {
      return [];
    },
    async getOrder() {
      return null;
    },
    ...over,
  };
}

const build = (over: Partial<SupportReader> = {}) =>
  buildContext({
    reader: reader(over),
    storeId: 'store-1',
    storeCode: 'brand-a',
    defaultCurrency: 'EUR',
    customerId: CUSTOMER,
    authorization: 'Bearer agent',
  });

describe('summarise', () => {
  it('is zeroes for no orders', () => {
    expect(summarise([], 'EUR')).toEqual({
      orders_count: 0,
      open_orders: 0,
      cancelled_orders: 0,
      currency: 'EUR',
      gross_minor: 0,
      refunded_minor: 0,
      last_order_at: null,
      mixed_currency: false,
    });
  });

  it('counts open orders as "not completed", which is what an agent is asked about', () => {
    const s = summarise(
      [
        order({ id: 'a', status: 'completed' }),
        order({ id: 'b', status: 'processing' }),
        order({ id: 'c', status: 'pending' }),
      ],
      'EUR',
    );
    expect(s.orders_count).toBe(3);
    expect(s.open_orders).toBe(2);
  });

  it('excludes a cancelled order from the count and counts it separately', () => {
    const s = summarise([order({ id: 'a' }), order({ id: 'b', status: 'cancelled' })], 'EUR');
    expect(s.orders_count).toBe(1);
    expect(s.cancelled_orders).toBe(1);
    expect(s.gross_minor).toBe(10000);
  });

  it('sums only succeeded refunds', () => {
    const s = summarise(
      [
        order({
          refunds: [
            { id: 'r1', status: 'succeeded', amount_minor: 2500, currency: 'EUR', reason: null },
            { id: 'r2', status: 'pending', amount_minor: 1000, currency: 'EUR', reason: null },
            { id: 'r3', status: 'failed', amount_minor: 1000, currency: 'EUR', reason: null },
          ],
        }),
      ],
      'EUR',
    );
    expect(s.refunded_minor).toBe(2500);
  });

  it('keeps the totals to the store currency and flags a mixed customer', () => {
    const s = summarise(
      [
        order({ id: 'a', currency: 'EUR', total_minor: 10000 }),
        order({ id: 'b', currency: 'GBP', total_minor: 8000 }),
      ],
      'EUR',
    );
    expect(s.gross_minor).toBe(10000);
    expect(s.orders_count).toBe(2);
    expect(s.mixed_currency).toBe(true);
  });

  it('takes the newest counting order as last_order_at', () => {
    const s = summarise(
      [
        order({ id: 'a', placed_at: '2026-10-01T10:00:00.000Z' }),
        order({ id: 'b', placed_at: '2026-10-09T10:00:00.000Z' }),
        order({ id: 'c', placed_at: '2026-10-11T10:00:00.000Z', status: 'cancelled' }),
      ],
      'EUR',
    );
    expect(s.last_order_at).toBe('2026-10-09T10:00:00.000Z');
  });
});

describe('buildContext', () => {
  it('404s a customer the store does not have', async () => {
    const err = (await build({ getCustomer: async () => null }).catch(
      (e: unknown) => e,
    )) as SupportError;
    expect(err).toBeInstanceOf(SupportError);
    expect(err.status).toBe(404);
  });

  it('normalises the customer, keeping nulls as nulls', async () => {
    const c = await build();
    expect(c.customer).toEqual({
      id: CUSTOMER,
      email: 'ada@example.test',
      first_name: 'Ada',
      last_name: null,
      status: 'registered',
      created_at: '2026-10-01T10:00:00.000Z',
    });
  });

  it('accepts `total` as a number or a bigint string, and never produces NaN', async () => {
    const summaries: RawOrderSummary[] = [
      {
        id: 'a',
        display_id: 1,
        status: 'completed',
        payment_status: 'captured',
        fulfillment_status: 'fulfilled',
        total: 10994,
        currency: 'EUR',
        placed_at: null,
      },
      {
        id: 'b',
        display_id: 2,
        status: 'completed',
        payment_status: 'captured',
        fulfillment_status: 'fulfilled',
        total: '2599',
        currency: 'EUR',
        placed_at: null,
      },
      {
        id: 'c',
        display_id: 3,
        status: 'completed',
        payment_status: 'captured',
        fulfillment_status: 'fulfilled',
        total: null,
        currency: 'EUR',
        placed_at: null,
      },
    ];
    const c = await build({
      listOrders: async () => summaries,
      getOrder: async (_s, id) => summaries.find((o) => o.id === id) ?? null,
    });
    expect(c.orders.map((o) => o.total_minor)).toEqual([10994, 2599, 0]);
    for (const o of c.orders) expect(Number.isInteger(o.total_minor)).toBe(true);
  });

  it('tolerates a detail response with no embedded arrays', async () => {
    const s: RawOrderSummary = {
      id: 'a',
      display_id: 1,
      status: 'completed',
      payment_status: 'captured',
      fulfillment_status: 'fulfilled',
      total: 100,
      currency: 'EUR',
      placed_at: null,
    };
    const c = await build({
      listOrders: async () => [s],
      getOrder: async () => s as RawOrderDetail,
    });
    expect(c.orders[0]).toMatchObject({ payments: [], refunds: [], shipments: [], returns: [] });
    expect(c.notes).toEqual([]);
  });

  it('keeps an order whose detail is gone, and says so in notes', async () => {
    const s: RawOrderSummary = {
      id: 'a',
      display_id: 1001,
      status: 'pending',
      payment_status: 'awaiting',
      fulfillment_status: 'unfulfilled',
      total: 500,
      currency: 'EUR',
      placed_at: '2026-10-05T10:00:00.000Z',
    };
    const c = await build({ listOrders: async () => [s], getOrder: async () => null });
    expect(c.orders).toHaveLength(1);
    expect(c.orders[0]!.total_minor).toBe(500);
    expect(c.notes).toEqual(['order 1001: details are no longer available']);
  });

  it('notes an order whose detail THREW, rather than losing the order', async () => {
    const s: RawOrderSummary = {
      id: 'a',
      display_id: 1002,
      status: 'pending',
      payment_status: 'awaiting',
      fulfillment_status: 'unfulfilled',
      total: 500,
      currency: 'EUR',
      placed_at: null,
    };
    const c = await build({
      listOrders: async () => [s],
      getOrder: async () => {
        throw new SupportError(502, 'upstream_error', 'The core answered 500 (order)');
      },
    });
    expect(c.orders).toHaveLength(1);
    expect(c.notes).toEqual(['order 1002: details could not be read']);
  });

  it('RE-THROWS a 401 or 403 from an order read: that is not a note, it is a refusal', async () => {
    const s: RawOrderSummary = {
      id: 'a',
      display_id: 1,
      status: 'pending',
      payment_status: 'awaiting',
      fulfillment_status: 'unfulfilled',
      total: 1,
      currency: 'EUR',
      placed_at: null,
    };
    for (const status of [401, 403]) {
      const err = (await build({
        listOrders: async () => [s],
        getOrder: async () => {
          throw new SupportError(status, status === 401 ? 'unauthorized' : 'forbidden', 'refused');
        },
      }).catch((e: unknown) => e)) as SupportError;
      expect(err.status).toBe(status);
    }
  });

  it('carries the store code the server resolved', async () => {
    expect((await build()).store_code).toBe('brand-a');
  });
});
