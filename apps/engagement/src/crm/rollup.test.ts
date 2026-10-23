// The rollup across placed / cancelled / refunded (#555's acceptance criterion), pure and exhaustive.

import { describe, expect, it } from 'vitest';
import { computeRollup, type RollupOrder, type RollupRefund } from './rollup.js';

const EUR = { defaultCurrency: 'EUR' };

const order = (over: Partial<RollupOrder> = {}): RollupOrder => ({
  id: 'o1',
  status: 'confirmed',
  total_minor: 10000,
  currency: 'EUR',
  placed_at: '2026-10-01T10:00:00.000Z',
  ...over,
});

const refund = (over: Partial<RollupRefund> = {}): RollupRefund => ({
  order_id: 'o1',
  status: 'succeeded',
  amount_minor: 2500,
  currency: 'EUR',
  ...over,
});

describe('computeRollup', () => {
  it('is all zeroes for a customer with no orders', () => {
    const r = computeRollup([], [], EUR);
    expect(r).toEqual({
      orders_count: 0,
      currency: 'EUR',
      net_revenue_minor: 0,
      gross_revenue_minor: 0,
      refunded_minor: 0,
      last_order_at: null,
      by_currency: {},
      mixed_currency: false,
    });
  });

  it('counts placed orders and sums their totals in minor units', () => {
    const r = computeRollup(
      [
        order({ id: 'o1', total_minor: 10000 }),
        order({ id: 'o2', total_minor: 2599, placed_at: '2026-10-05T10:00:00.000Z' }),
      ],
      [],
      EUR,
    );
    expect(r.orders_count).toBe(2);
    expect(r.gross_revenue_minor).toBe(12599);
    expect(r.net_revenue_minor).toBe(12599);
    expect(r.last_order_at).toBe('2026-10-05T10:00:00.000Z');
  });

  it('EXCLUDES a cancelled order entirely, from the count and the revenue', () => {
    const r = computeRollup(
      [
        order({ id: 'o1', total_minor: 10000 }),
        order({ id: 'o2', total_minor: 5000, status: 'cancelled' }),
      ],
      [],
      EUR,
    );
    // Not "2 orders worth 10000": a CRM contact saying 2 would mislead whoever reads it.
    expect(r.orders_count).toBe(1);
    expect(r.gross_revenue_minor).toBe(10000);
  });

  it('subtracts a succeeded refund from net but leaves gross alone', () => {
    const r = computeRollup([order({ total_minor: 10000 })], [refund({ amount_minor: 2500 })], EUR);
    expect(r.gross_revenue_minor).toBe(10000);
    expect(r.refunded_minor).toBe(2500);
    expect(r.net_revenue_minor).toBe(7500);
  });

  it('ignores a pending or failed refund: one may never happen, the other did not', () => {
    const r = computeRollup(
      [order({ total_minor: 10000 })],
      [refund({ status: 'pending' }), refund({ status: 'failed', amount_minor: 1000 })],
      EUR,
    );
    expect(r.refunded_minor).toBe(0);
    expect(r.net_revenue_minor).toBe(10000);
  });

  it('ignores a refund against a cancelled order: that revenue was never counted', () => {
    const r = computeRollup(
      [order({ id: 'o1', total_minor: 10000 }), order({ id: 'o2', status: 'cancelled' })],
      [refund({ order_id: 'o2', amount_minor: 5000 })],
      EUR,
    );
    expect(r.refunded_minor).toBe(0);
    expect(r.net_revenue_minor).toBe(10000);
  });

  it('sums several refunds against one order', () => {
    const r = computeRollup(
      [order({ total_minor: 10000 })],
      [refund({ amount_minor: 2500 }), refund({ amount_minor: 1500 })],
      EUR,
    );
    expect(r.refunded_minor).toBe(4000);
    expect(r.net_revenue_minor).toBe(6000);
  });

  it('a fully refunded order stays an order, with zero net', () => {
    const r = computeRollup(
      [order({ total_minor: 10000 })],
      [refund({ amount_minor: 10000 })],
      EUR,
    );
    expect(r.orders_count).toBe(1);
    expect(r.net_revenue_minor).toBe(0);
    expect(r.last_order_at).toBe('2026-10-01T10:00:00.000Z');
  });

  it('FLOORS net at zero when refunds exceed the total, without hiding the figures', () => {
    const r = computeRollup(
      [order({ total_minor: 10000 })],
      [refund({ amount_minor: 12000 })],
      EUR,
    );
    expect(r.net_revenue_minor).toBe(0);
    // Nothing is lost: the unclamped numbers are both still there.
    expect(r.gross_revenue_minor).toBe(10000);
    expect(r.refunded_minor).toBe(12000);
  });

  it('takes the NEWEST counting order as last_order_at, whatever order the rows arrive in', () => {
    const r = computeRollup(
      [
        order({ id: 'o2', placed_at: '2026-10-05T10:00:00.000Z' }),
        order({ id: 'o1', placed_at: '2026-10-01T10:00:00.000Z' }),
        order({ id: 'o3', placed_at: '2026-10-03T10:00:00.000Z' }),
      ],
      [],
      EUR,
    );
    expect(r.last_order_at).toBe('2026-10-05T10:00:00.000Z');
  });

  it('ignores a cancelled order when picking last_order_at', () => {
    const r = computeRollup(
      [
        order({ id: 'o1', placed_at: '2026-10-01T10:00:00.000Z' }),
        order({ id: 'o2', placed_at: '2026-10-09T10:00:00.000Z', status: 'cancelled' }),
      ],
      [],
      EUR,
    );
    expect(r.last_order_at).toBe('2026-10-01T10:00:00.000Z');
  });

  it('accepts a Date from node-postgres as well as a string', () => {
    const r = computeRollup([order({ placed_at: new Date('2026-10-07T10:00:00.000Z') })], [], EUR);
    expect(r.last_order_at).toBe('2026-10-07T10:00:00.000Z');
  });

  it('parses bigint columns that arrive as strings', () => {
    const r = computeRollup(
      [order({ total_minor: '10000' })],
      [refund({ amount_minor: '2500' })],
      EUR,
    );
    expect(r.gross_revenue_minor).toBe(10000);
    expect(r.net_revenue_minor).toBe(7500);
    expect(Number.isInteger(r.net_revenue_minor)).toBe(true);
  });

  it('refuses a non-numeric amount rather than reporting NaN revenue', () => {
    expect(() => computeRollup([order({ total_minor: 'lots' })], [], EUR)).toThrow(
      /non-numeric minor amount/,
    );
  });

  it('never divides minor units by a guessed 100 (a zero-decimal currency stays whole)', () => {
    const r = computeRollup([order({ total_minor: 1200, currency: 'JPY' })], [], {
      defaultCurrency: 'JPY',
    });
    expect(r.net_revenue_minor).toBe(1200);
    expect(r.currency).toBe('JPY');
  });

  it('keeps currencies apart and flags a mixed customer instead of summing them', () => {
    const r = computeRollup(
      [
        order({ id: 'o1', total_minor: 10000, currency: 'EUR' }),
        order({
          id: 'o2',
          total_minor: 8000,
          currency: 'GBP',
          placed_at: '2026-10-04T10:00:00.000Z',
        }),
      ],
      [refund({ order_id: 'o2', amount_minor: 1000, currency: 'GBP' })],
      EUR,
    );
    // The headline is the store's own currency only...
    expect(r.net_revenue_minor).toBe(10000);
    expect(r.currency).toBe('EUR');
    // ...the count is every order, and the other currency is visible rather than silently added.
    expect(r.orders_count).toBe(2);
    expect(r.mixed_currency).toBe(true);
    expect(r.by_currency).toEqual({
      EUR: { orders: 1, gross_minor: 10000, refunded_minor: 0, net_minor: 10000 },
      GBP: { orders: 1, gross_minor: 8000, refunded_minor: 1000, net_minor: 7000 },
    });
  });

  it('is not mixed when every order is in the store currency', () => {
    expect(computeRollup([order()], [], EUR).mixed_currency).toBe(false);
  });

  it('reports zeroes in the headline when the customer has only foreign-currency orders', () => {
    const r = computeRollup([order({ total_minor: 8000, currency: 'GBP' })], [], EUR);
    expect(r.orders_count).toBe(1);
    expect(r.net_revenue_minor).toBe(0);
    expect(r.mixed_currency).toBe(true);
    expect(r.by_currency.GBP?.net_minor).toBe(8000);
  });

  it('IS IDEMPOTENT: the same rows always give the same answer, which is the whole point', () => {
    const orders = [order({ id: 'o1' }), order({ id: 'o2', total_minor: 5000 })];
    const refunds = [refund({ order_id: 'o1' })];
    const first = computeRollup(orders, refunds, EUR);
    const second = computeRollup(orders, refunds, EUR);
    expect(second).toEqual(first);
    // ...and re-handling an event cannot double-count, because nothing accumulates.
    expect(computeRollup(orders, refunds, EUR).net_revenue_minor).toBe(first.net_revenue_minor);
  });

  it('handles the placed -> refunded -> cancelled life of one order in any arrival order', () => {
    // Whatever sequence of events brought us here, the rows are the rows.
    const asPlaced = computeRollup([order({ total_minor: 10000 })], [], EUR);
    const asRefunded = computeRollup([order({ total_minor: 10000 })], [refund()], EUR);
    const asCancelled = computeRollup([order({ status: 'cancelled' })], [refund()], EUR);

    expect(asPlaced.net_revenue_minor).toBe(10000);
    expect(asRefunded.net_revenue_minor).toBe(7500);
    expect(asCancelled).toMatchObject({ orders_count: 0, net_revenue_minor: 0, refunded_minor: 0 });
  });
});
