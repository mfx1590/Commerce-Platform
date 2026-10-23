// The context assembler: the shapes the contract allows, and the glance summary. Pure — no server, no database.
//
// Fixtures are typed from the contract (`@platform/contracts/admin`), so a drift in the Admin API breaks this
// file at compile time rather than at an agent's screen (#573 review).

import type { components } from '@platform/contracts/admin';
import { describe, expect, it } from 'vitest';
import type { SupportReader } from './admin-api.js';
import { buildContext, summarise } from './context.js';
import { SupportError, type SupportOrder } from './types.js';

type Schemas = components['schemas'];

const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const ORDER = '11111111-1111-4111-8111-111111111111';
const LINE = '66666666-6666-4666-8666-666666666666';
const WAREHOUSE = '00000000-0000-4000-8000-000000000021';
const PAYMENT = '22222222-2222-4222-8222-222222222222';

const customer: Schemas['Customer'] = {
  id: CUSTOMER,
  identity_id: null,
  email: 'ada@example.test',
  first_name: 'Ada',
  last_name: null,
  phone: null,
  customer_group_id: null,
  status: 'registered',
  consent: {},
  created_at: '2026-10-01T10:00:00.000Z',
};

function summaryOf(over: Partial<Schemas['OrderSummary']> = {}): Schemas['OrderSummary'] {
  return {
    id: ORDER,
    display_id: 1001,
    email: 'ada@example.test',
    customer_id: CUSTOMER,
    status: 'completed',
    payment_status: 'captured',
    fulfillment_status: 'fulfilled',
    total: { amount_minor: 10000, currency: 'EUR' },
    placed_at: '2026-10-05T10:00:00.000Z',
    ...over,
  };
}

/** A full `Order`: the summary plus everything `getOrder` embeds. */
function detailOf(over: Partial<Schemas['Order']> = {}): Schemas['Order'] {
  return {
    ...summaryOf(),
    sales_channel_id: '88888888-8888-4888-8888-888888888888',
    currency: 'EUR',
    locale: 'en-GB',
    items: [],
    shipping_address: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      line1: '12 Example Street',
      city: 'Berlin',
      postal_code: '10115',
      country: 'DE',
    },
    billing_address: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      line1: '12 Example Street',
      city: 'Berlin',
      postal_code: '10115',
      country: 'DE',
    },
    shipping_method: {
      code: 'standard',
      name: 'Standard',
      carrier: 'dhl',
      price: { amount_minor: 499, currency: 'EUR' },
    },
    promotion_codes: [],
    totals: {
      subtotal: { amount_minor: 9000, currency: 'EUR' },
      discount: { amount_minor: 0, currency: 'EUR' },
      shipping: { amount_minor: 499, currency: 'EUR' },
      tax: { amount_minor: 501, currency: 'EUR' },
      total: { amount_minor: 10000, currency: 'EUR' },
    },
    payments: [],
    refunds: [],
    shipments: [],
    returns: [],
    cancel_reason: null,
    metadata: {},
    ...over,
  } as Schemas['Order'];
}

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

  it('normalises the customer, keeping nulls as nulls and dropping the phone', async () => {
    const c = await build();
    expect(c.customer).toEqual({
      id: CUSTOMER,
      email: 'ada@example.test',
      first_name: 'Ada',
      last_name: null,
      status: 'registered',
      created_at: '2026-10-01T10:00:00.000Z',
    });
    // `phone` and `consent` are in the Admin API's Customer and are deliberately not carried over.
    expect(Object.keys(c.customer)).not.toContain('phone');
    expect(Object.keys(c.customer)).not.toContain('consent');
  });

  it('reads the amount and the currency from Money, on both summary and detail', async () => {
    const s = summaryOf({ total: { amount_minor: 10994, currency: 'EUR' } });
    const c = await build({
      listOrders: async () => [s],
      getOrder: async () => detailOf({ total: { amount_minor: 10994, currency: 'EUR' } }),
    });
    expect(c.orders[0]).toMatchObject({ total_minor: 10994, currency: 'EUR' });
    expect(c.summary).toMatchObject({ gross_minor: 10994, currency: 'EUR', mixed_currency: false });
  });

  it('reads a foreign currency off the summary and flags the customer as mixed', async () => {
    const s = summaryOf({ total: { amount_minor: 8000, currency: 'GBP' } });
    const c = await build({ listOrders: async () => [s], getOrder: async () => null });
    expect(c.orders[0]!.currency).toBe('GBP');
    expect(c.summary.mixed_currency).toBe(true);
    // The headline stays the store's own currency, so it is 0 here rather than a summed 8000.
    expect(c.summary.gross_minor).toBe(0);
  });

  it('never produces NaN from a bigint-ish amount', async () => {
    const s = summaryOf({
      total: { amount_minor: '2599' as unknown as number, currency: 'EUR' },
    });
    const c = await build({ listOrders: async () => [s], getOrder: async () => null });
    expect(c.orders[0]!.total_minor).toBe(2599);
    expect(Number.isInteger(c.orders[0]!.total_minor)).toBe(true);
  });

  it('maps the embedded payments, refunds, shipments and returns from their Money shapes', async () => {
    const s = summaryOf();
    const detail = detailOf({
      payments: [
        {
          id: PAYMENT,
          provider: 'stripe',
          provider_payment_id: 'pi-alpha',
          amount: { amount_minor: 10000, currency: 'EUR' },
          status: 'captured',
          fee_minor: 250,
          captured_at: '2026-10-05T10:05:00.000Z',
        },
      ],
      refunds: [
        {
          id: 'r1',
          order_id: ORDER,
          payment_id: PAYMENT,
          return_id: null,
          amount: { amount_minor: 2500, currency: 'EUR' },
          reason: 'return',
          status: 'succeeded',
          provider_refund_id: 're-alpha',
          created_at: '2026-10-06T10:00:00.000Z',
        },
      ],
      shipments: [
        {
          id: 's1',
          order_id: ORDER,
          warehouse_id: WAREHOUSE,
          carrier: 'dhl',
          service: 'standard',
          tracking_number: 'TRACK-ALPHA-WORDS',
          tracking_url: null,
          label_url: null,
          cost: { amount_minor: 499, currency: 'EUR' },
          status: 'delivered',
          items: [],
          shipped_at: '2026-10-06T08:00:00.000Z',
          delivered_at: '2026-10-08T08:00:00.000Z',
        },
      ],
      returns: [
        {
          id: 'rt1',
          order_id: ORDER,
          status: 'received',
          reason: null,
          warehouse_id: null,
          refund_id: null,
          items: [{ order_line_item_id: LINE, quantity: 1, condition: 'resellable' }],
          requested_at: '2026-10-07T10:00:00.000Z',
          received_at: '2026-10-08T10:00:00.000Z',
        },
      ],
    });

    const c = await build({ listOrders: async () => [s], getOrder: async () => detail });
    const o = c.orders[0]!;
    expect(o.payments).toEqual([
      { id: PAYMENT, provider: 'stripe', status: 'captured', amount_minor: 10000, currency: 'EUR' },
    ]);
    expect(o.refunds).toEqual([
      { id: 'r1', status: 'succeeded', amount_minor: 2500, currency: 'EUR', reason: 'return' },
    ]);
    expect(o.shipments[0]).toMatchObject({
      status: 'delivered',
      carrier: 'dhl',
      tracking_number: 'TRACK-ALPHA-WORDS',
      shipped_at: '2026-10-06T08:00:00.000Z',
      delivered_at: '2026-10-08T08:00:00.000Z',
    });
    expect(o.returns).toEqual([
      { id: 'rt1', status: 'received', requested_at: '2026-10-07T10:00:00.000Z' },
    ]);
    // The refund is reflected in the glance summary.
    expect(c.summary.refunded_minor).toBe(2500);
  });

  it('tolerates a detail response with empty embedded arrays', async () => {
    const s = summaryOf();
    const c = await build({ listOrders: async () => [s], getOrder: async () => detailOf() });
    expect(c.orders[0]).toMatchObject({ payments: [], refunds: [], shipments: [], returns: [] });
    expect(c.notes).toEqual([]);
  });

  it('keeps an order whose detail is gone, and says so in notes', async () => {
    const s = summaryOf({
      display_id: 1001,
      status: 'pending',
      total: { amount_minor: 500, currency: 'EUR' },
    });
    const c = await build({ listOrders: async () => [s], getOrder: async () => null });
    expect(c.orders).toHaveLength(1);
    // Built from the summary, so the amount and currency still reach the agent.
    expect(c.orders[0]).toMatchObject({ total_minor: 500, currency: 'EUR' });
    expect(c.notes).toEqual(['order 1001: details are no longer available']);
  });

  it('notes an order whose detail THREW, rather than losing the order', async () => {
    const s = summaryOf({ display_id: 1002 });
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
    for (const status of [401, 403]) {
      const err = (await build({
        listOrders: async () => [summaryOf()],
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
