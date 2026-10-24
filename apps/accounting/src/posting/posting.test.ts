// The pure posting functions: one worked example per topic (the README's), the balance invariants, the proportional
// rules on partial shipments / refunds / cancellations, and the producer defects that must dead-letter.
import { describe, expect, it } from 'vitest';
import { ACCOUNT } from '../chart.js';
import { aggregateLines, dateOf, line, proportion, roundShare } from './balance.js';
import {
  allItems,
  LE_A,
  orderCancelled,
  orderPlaced,
  paymentCaptured,
  refundIssued,
  shipmentShipped,
  STORE_A,
} from './fixtures.js';
import { postEvent } from './index.js';
import type { JournalEntry, JournalLine, OrderProjection } from './types.js';

const dr = (account: string, amount: number, currency = 'EUR'): JournalLine => ({
  account_code: account as JournalLine['account_code'],
  currency,
  debit_minor: amount,
  credit_minor: 0,
});
const cr = (account: string, amount: number, currency = 'EUR'): JournalLine => ({
  account_code: account as JournalLine['account_code'],
  currency,
  debit_minor: 0,
  credit_minor: amount,
});
const sorted = (lines: JournalLine[]) =>
  [...lines].sort((a, b) =>
    a.currency === b.currency
      ? a.account_code.localeCompare(b.account_code)
      : a.currency.localeCompare(b.currency),
  );
const expectLines = (entry: JournalEntry | undefined, lines: JournalLine[]) => {
  expect(entry).toBeDefined();
  expect(sorted(entry!.lines)).toEqual(sorted(lines));
};

/** The worked example of the README: 2 × 49.99 at 21% + 1 × 10.00 with 2.00 off at 21%, shipping 4.95 + VAT. */
const example = () =>
  orderPlaced({
    legalEntityId: LE_A,
    storeId: STORE_A,
    currency: 'EUR',
    lines: [
      { quantity: 2, unit_price_minor: 4_999, tax_rate_bp: 2100 }, // net 99.98, tax 21.00 (2099.58 → 2100)
      { quantity: 1, unit_price_minor: 1_000, discount_minor: 200, tax_rate_bp: 2100 }, // net 8.00, tax 1.68
    ],
    shipping_minor: 495,
    shipping_tax_minor: 104, // 4.95 × 21% = 1.0395 → 1.04
    placed_at: '2026-10-05T10:00:00.000Z',
  });

describe('arithmetic', () => {
  it('line(): negative flips the side, zero is no line, non-integers are refused', () => {
    expect(line(ACCOUNT.RECEIVABLE, 'EUR', 100, 'debit')).toEqual(dr('1200', 100));
    expect(line(ACCOUNT.RECEIVABLE, 'EUR', -100, 'debit')).toEqual(cr('1200', 100));
    expect(line(ACCOUNT.RECEIVABLE, 'EUR', 0, 'credit')).toBeNull();
    expect(() => line(ACCOUNT.RECEIVABLE, 'EUR', 1.5, 'credit')).toThrow(TypeError);
  });
  it('proportion() floors in exact arithmetic; roundShare() rounds half up', () => {
    expect(proportion(1000, 1, 3)).toBe(333);
    expect(proportion(1000, 2, 3)).toBe(666);
    expect(proportion(1000, 3, 3)).toBe(1000);
    // 9_007_199_254_740 × 7 = 63_050_394_783_180 (beyond 2^53: a float product would drift); / 9 = 7_005_599_420_353.3
    expect(proportion(9_007_199_254_740, 7, 9)).toBe(7_005_599_420_353);
    expect(roundShare(1000, 1, 3)).toBe(333);
    expect(roundShare(1000, 1, 2)).toBe(500);
    expect(roundShare(1001, 1, 2)).toBe(501); // 500.5 → 501
    expect(roundShare(12_167, 2_273, 12_167)).toBe(2_273);
  });
  it('aggregateLines() nets per account and currency, drops zero, keeps currencies apart', () => {
    expect(
      aggregateLines([
        dr('1200', 100),
        cr('1200', 30),
        dr('2200', 5),
        cr('2200', 5),
        dr('1200', 7, 'GBP'),
      ]),
    ).toEqual([dr('1200', 70), dr('1200', 7, 'GBP')]);
  });
  it('dateOf() is the UTC calendar date', () => {
    expect(dateOf('2026-10-05T23:30:00.000+02:00')).toBe('2026-10-05');
    expect(dateOf('2026-10-05T23:30:00.000Z')).toBe('2026-10-05');
    expect(() => dateOf('yesterday')).toThrow(TypeError);
  });
});

describe('order.placed', () => {
  it('posts receivable vs contract liability (goods, shipping) + VAT, and builds the projection', () => {
    const e = example();
    expect(e.payload.totals).toEqual({
      subtotal_minor: 10_998,
      discount_minor: 200,
      shipping_minor: 495,
      tax_minor: 2_100 + 168 + 104,
      total_minor: 10_998 - 200 + 495 + 2_372,
    });
    const r = postEvent(e, null);
    expect(r.entries).toHaveLength(1);
    const entry = r.entries[0]!;
    expect(entry).toMatchObject({
      journal: 'sales',
      entry_date: '2026-10-05',
      legal_entity_id: LE_A,
      store_id: STORE_A,
      source_event_id: e.event_id,
      source_topic: 'order.placed',
      reference_type: 'order',
      reference_id: e.payload.order_id,
    });
    expectLines(entry, [
      dr('1200', 13_665),
      cr('2300', 9_998 + 800),
      cr('2310', 495),
      cr('2200', 2_372),
    ]);
    expect(r.order).toMatchObject({
      order_id: e.payload.order_id,
      currency: 'EUR',
      total_minor: 13_665,
      tax_minor: 2_372,
      goods_net_minor: 10_798,
      shipping_net_minor: 495,
      goods_released_minor: 0,
      shipping_released: false,
      status: 'placed',
      source_event_id: e.event_id,
    });
    expect(
      r.order!.lines.map((l) => [l.quantity, l.net_minor, l.shipped_quantity, l.released_minor]),
    ).toEqual([
      [2, 9_998, 0, 0],
      [1, 800, 0, 0],
    ]);
  });

  it('tax-inclusive store: line net = total − tax, shipping net = shipping without its tax, still balanced', () => {
    const e = orderPlaced({
      inclusive: true,
      lines: [{ quantity: 1, unit_price_minor: 12_100, tax_rate_bp: 2100, tax_minor: 2_100 }],
      shipping_minor: 605,
      shipping_tax_minor: 0, // inside 6.05 in this fixture's totals; the line-level tax is what the event carries
    });
    // total = 12100 + 605 = 12705, tax = 2100 → goods net 10000, shipping net 605
    const r = postEvent(e, null);
    expectLines(r.entries[0], [
      dr('1200', 12_705),
      cr('2300', 10_000),
      cr('2310', 605),
      cr('2200', 2_100),
    ]);
  });

  it('a fully discounted order with free shipping posts nothing but still builds the projection', () => {
    const e = orderPlaced({
      lines: [{ quantity: 1, unit_price_minor: 1_000, discount_minor: 1_000, tax_rate_bp: 2100 }],
    });
    const r = postEvent(e, null);
    expect(r.entries).toEqual([]);
    expect(r.order?.total_minor).toBe(0);
  });

  it('a redelivery with the same event id posts nothing; a second placement is a defect', () => {
    const e = example();
    const first = postEvent(e, null);
    expect(postEvent(e, first.order!)).toEqual({ entries: [] });
    const again = orderPlaced({
      orderId: e.payload.order_id,
      lines: [{ quantity: 1, unit_price_minor: 100, tax_rate_bp: 0 }],
    });
    expect(() => postEvent(again, first.order!)).toThrow(/DuplicateOrderPlaced|placed by event/);
    try {
      postEvent(again, first.order!);
    } catch (err) {
      expect((err as Error).name).toBe('DuplicateOrderPlaced');
    }
  });
});

describe('payment.captured', () => {
  it('posts PSP clearing (amount − fee) + PSP fees vs receivable, and the payment projection', () => {
    const e = example();
    const pay = paymentCaptured(e, {
      amount_minor: 13_665,
      fee_minor: 421,
      captured_at: '2026-10-05T10:00:05Z',
    });
    const r = postEvent(pay, null);
    expect(r.entries[0]).toMatchObject({
      journal: 'psp_fees',
      entry_date: '2026-10-05',
      reference_type: 'payment',
      reference_id: pay.payload.payment_id,
    });
    expectLines(r.entries[0], [dr('1100', 13_244), dr('6100', 421), cr('1200', 13_665)]);
    expect(r.payment).toMatchObject({
      payment_id: pay.payload.payment_id,
      fee_minor: 421,
      provider: 'stripe',
    });
  });
  it('a null fee is zero', () => {
    const pay = paymentCaptured(example(), { amount_minor: 1_000, fee_minor: null });
    const r = postEvent(pay, null);
    expectLines(r.entries[0], [dr('1100', 1_000), cr('1200', 1_000)]);
    expect(r.payment?.fee_minor).toBe(0);
  });
});

describe('shipment.shipped', () => {
  it('full shipment releases every line and the shipping to revenue, and posts the carrier cost', () => {
    const e = example();
    const order = postEvent(e, null).order!;
    const ship = shipmentShipped(e, allItems(e), {
      cost_minor: 450,
      shipped_at: '2026-10-07T08:00:00Z',
    });
    const r = postEvent(ship, order);
    expect(r.entries.map((x) => x.journal)).toEqual(['sales', 'shipping']);
    expectLines(r.entries[0], [
      dr('2300', 10_798),
      cr('4000', 10_798),
      dr('2310', 495),
      cr('4010', 495),
    ]);
    expectLines(r.entries[1], [dr('6000', 450), cr('2100', 450)]);
    expect(
      r.entries.every(
        (x) =>
          x.reference_type === 'shipment' &&
          x.reference_id === ship.payload.shipment_id &&
          x.entry_date === '2026-10-07',
      ),
    ).toBe(true);
    expect(r.order).toMatchObject({ goods_released_minor: 10_798, shipping_released: true });
    expect(r.order!.lines.map((l) => l.released_minor)).toEqual([9_998, 800]);
  });

  it('partial shipments release floor(net × shipped / qty) cumulatively; the remainder lands on the last unit', () => {
    const e = orderPlaced({
      lines: [{ quantity: 3, unit_price_minor: 3_333, tax_rate_bp: 0 }],
      shipping_minor: 500,
    });
    // net 9999 → 1 of 3 = 3333, 2 of 3 = 6666, 3 of 3 = 9999
    let order = postEvent(e, null).order!;
    const lineId = e.payload.line_items[0]!.order_line_item_id;
    const s1 = postEvent(
      shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 1 }], { cost_minor: null }),
      order,
    );
    expectLines(s1.entries[0], [
      dr('2300', 3_333),
      cr('4000', 3_333),
      dr('2310', 500),
      cr('4010', 500),
    ]);
    expect(s1.entries).toHaveLength(1); // no cost → no shipping entry
    order = s1.order!;
    const s2 = postEvent(
      shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 1 }], { cost_minor: 0 }),
      order,
    );
    expectLines(s2.entries[0], [dr('2300', 3_333), cr('4000', 3_333)]); // shipping already released
    order = s2.order!;
    const s3 = postEvent(
      shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 1 }], { cost_minor: 0 }),
      order,
    );
    expectLines(s3.entries[0], [dr('2300', 3_333), cr('4000', 3_333)]);
    expect(s3.order).toMatchObject({ goods_released_minor: 9_999, shipping_released: true });
    expect(s3.order!.lines[0]).toMatchObject({ shipped_quantity: 3, released_minor: 9_999 });
  });

  it('uneven split: 10 units of 1.00 net shipped 3 + 7 releases 300 + 700, never a cent lost', () => {
    const e = orderPlaced({
      lines: [{ quantity: 10, unit_price_minor: 100, discount_minor: 1, tax_rate_bp: 0 }],
    });
    const lineId = e.payload.line_items[0]!.order_line_item_id;
    let order = postEvent(e, null).order!;
    expect(order.goods_net_minor).toBe(999);
    const a = postEvent(
      shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 3 }], { cost_minor: 0 }),
      order,
    );
    order = a.order!;
    const b = postEvent(
      shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 7 }], { cost_minor: 0 }),
      order,
    );
    const released = (x: typeof a) =>
      x.entries[0]!.lines.find((l) => l.account_code === '4000')!.credit_minor;
    expect(released(a)).toBe(299); // floor(999 × 3 / 10)
    expect(released(b)).toBe(700);
    expect(b.order!.goods_released_minor).toBe(999);
  });

  it('shipment currency can differ from the order currency: the cost posts in the shipment currency', () => {
    const e = example();
    const order = postEvent(e, null).order!;
    const r = postEvent(
      shipmentShipped(e, allItems(e), { cost_minor: 1_200, currency: 'USD' }),
      order,
    );
    expectLines(r.entries[1], [dr('6000', 1_200, 'USD'), cr('2100', 1_200, 'USD')]);
  });

  it('defects: missing projection (retryable), over-shipment, unknown line, cancelled order', () => {
    const e = example();
    const order = postEvent(e, null).order!;
    const named = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as Error).name;
      }
      return 'no error';
    };
    expect(named(() => postEvent(shipmentShipped(e, allItems(e)), null))).toBe(
      'OrderProjectionMissing',
    );
    const lineId = e.payload.line_items[1]!.order_line_item_id; // quantity 1
    expect(
      named(() =>
        postEvent(shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 2 }]), order),
      ),
    ).toBe('ShipmentExceedsOrder');
    expect(
      named(() =>
        postEvent(
          shipmentShipped(e, [
            { order_line_item_id: '00000000-0000-4000-8000-00000000dead', quantity: 1 },
          ]),
          order,
        ),
      ),
    ).toBe('UnknownOrderLine');
    const cancelled = postEvent(orderCancelled(e), order).order!;
    expect(named(() => postEvent(shipmentShipped(e, allItems(e)), cancelled))).toBe(
      'ShipmentOfCancelledOrder',
    );
  });
});

describe('refund.issued', () => {
  it('return / goodwill / chargeback reverse revenue and VAT in the order proportion vs PSP clearing', () => {
    const e = example(); // total 13665, tax 2372
    const order = postEvent(e, null).order!;
    const pay = paymentCaptured(e);
    const full = postEvent(
      refundIssued(e, pay, {
        amount_minor: 13_665,
        reason: 'return',
        issued_at: '2026-10-12T15:00:00Z',
      }),
      order,
    );
    expect(full.entries[0]).toMatchObject({
      journal: 'refunds',
      entry_date: '2026-10-12',
      reference_type: 'refund',
    });
    expectLines(full.entries[0], [dr('4090', 11_293), dr('2200', 2_372), cr('1100', 13_665)]);
    const part = postEvent(
      refundIssued(e, pay, { amount_minor: 1_000, reason: 'goodwill' }),
      order,
    );
    // 1000 × 2372 / 13665 = 173.58 → 174
    expectLines(part.entries[0], [dr('4090', 826), dr('2200', 174), cr('1100', 1_000)]);
    const cb = postEvent(refundIssued(e, pay, { amount_minor: 500, reason: 'chargeback' }), order);
    expectLines(cb.entries[0], [dr('4090', 413), dr('2200', 87), cr('1100', 500)]);
    expect(part.refund).toMatchObject({ reason: 'goodwill', amount_minor: 1_000 });
  });

  it('reason cancellation settles the customer credit: receivable vs PSP clearing, no projection needed', () => {
    const e = example();
    const pay = paymentCaptured(e);
    const r = postEvent(
      refundIssued(e, pay, { amount_minor: 13_665, reason: 'cancellation' }),
      null,
    );
    expectLines(r.entries[0], [dr('1200', 13_665), cr('1100', 13_665)]);
  });

  it('a return without a projection is retryable', () => {
    const e = example();
    try {
      postEvent(refundIssued(e, paymentCaptured(e), { amount_minor: 100, reason: 'return' }), null);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).name).toBe('OrderProjectionMissing');
    }
  });
});

describe('order.cancelled', () => {
  it('unshipped: reverses the placed entry exactly', () => {
    const e = example();
    const order = postEvent(e, null).order!;
    const r = postEvent(orderCancelled(e, { cancelled_at: '2026-10-06T09:00:00Z' }), order);
    expect(r.entries[0]).toMatchObject({
      journal: 'sales',
      entry_date: '2026-10-06',
      reference_type: 'order',
      reference_id: e.payload.order_id,
    });
    expectLines(r.entries[0], [
      dr('2300', 10_798),
      dr('2310', 495),
      dr('2200', 2_372),
      cr('1200', 13_665),
    ]);
    expect(r.order).toMatchObject({
      status: 'cancelled',
      cancelled_at: '2026-10-06T09:00:00Z',
      // the projection keeps what was actually released (nothing): a late shipment dated before the cancel needs it
      goods_released_minor: 0,
      shipping_released: false,
    });
  });

  it('partially shipped: reverses only the unreleased goods and the proportional VAT', () => {
    const e = orderPlaced({
      lines: [{ quantity: 2, unit_price_minor: 5_000, tax_rate_bp: 2000 }], // net 10000, tax 2000
      shipping_minor: 1_000,
      shipping_tax_minor: 200,
    }); // total 13200, tax 2200
    const lineId = e.payload.line_items[0]!.order_line_item_id;
    let order = postEvent(e, null).order!;
    order = postEvent(
      shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 1 }], { cost_minor: 0 }),
      order,
    ).order!;
    // released: goods 5000 + shipping 1000; remaining goods 5000 of base 11000 → VAT 2200 × 5000 / 11000 = 1000
    const r = postEvent(orderCancelled(e), order);
    expectLines(r.entries[0], [dr('2300', 5_000), dr('2200', 1_000), cr('1200', 6_000)]);
  });

  it('a second cancel posts nothing; a cancel without a projection is retryable', () => {
    const e = example();
    const cancelled = postEvent(orderCancelled(e), postEvent(e, null).order!).order!;
    expect(postEvent(orderCancelled(e), cancelled).entries).toEqual([]);
    try {
      postEvent(orderCancelled(e), null);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).name).toBe('OrderProjectionMissing');
    }
  });
});

describe('full lifecycle of one order nets every balance-sheet account to zero except the PSP fee and the cost', () => {
  it('placed → captured → shipped → returned in full', () => {
    const e = example();
    let order: OrderProjection | null = null;
    const all: JournalLine[] = [];
    const post = (ev: Parameters<typeof postEvent>[0]) => {
      const r = postEvent(ev, order);
      if (r.order) order = r.order;
      for (const en of r.entries) all.push(...en.lines);
    };
    const pay = paymentCaptured(e, { fee_minor: 421 });
    post(e);
    post(pay);
    post(shipmentShipped(e, allItems(e), { cost_minor: 450 }));
    post(refundIssued(e, pay, { amount_minor: 13_665, reason: 'return' }));
    const net = aggregateLines(all);
    const by = Object.fromEntries(net.map((l) => [l.account_code, l.debit_minor - l.credit_minor]));
    expect(by).toEqual({
      '1100': -421, // the PSP kept its fee
      '6100': 421,
      '4000': -10_798,
      '4010': -495,
      '4090': 11_293,
      '6000': 450,
      '2100': -450,
    });
    expect(Object.values(by).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('a shipment that happened before the cancellation but arrives after it (separate partitions)', () => {
  it('recognises the shipped part against the receivable and gives back the over-reversed VAT; the ledger equals fact order', () => {
    // 2 × 50.00 at 20 %, shipping 10.00 + 2.00: total 132.00, tax 22.00; one unit shipped (10-07), then cancelled (10-08)
    const e = orderPlaced({
      lines: [{ quantity: 2, unit_price_minor: 5_000, tax_rate_bp: 2000 }],
      shipping_minor: 1_000,
      shipping_tax_minor: 200,
    });
    const lineId = e.payload.line_items[0]!.order_line_item_id;
    const ship = shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 1 }], {
      cost_minor: 0,
      shipped_at: '2026-10-07T08:00:00.000Z',
    });
    const cancel = orderCancelled(e, { cancelled_at: '2026-10-08T09:00:00.000Z' });
    const collect = (events: Parameters<typeof postEvent>[0][]) => {
      let order: OrderProjection | null = null;
      const lines: JournalLine[] = [];
      for (const ev of events) {
        const r = postEvent(ev, order);
        if (r.order) order = r.order;
        for (const en of r.entries) lines.push(...en.lines);
      }
      return {
        order,
        net: Object.fromEntries(
          aggregateLines(lines).map((l) => [l.account_code, l.debit_minor - l.credit_minor]),
        ),
      };
    };
    const factOrder = collect([e, ship, cancel]);
    const lateShipment = collect([e, cancel, ship]);
    // fact order: placed (AR 13200 / CL 10000 / CLS 1000 / VAT 2200), shipped (release 5000 + shipping 1000), cancel reverses 5000 + VAT 1000
    expect(factOrder.net).toEqual({
      '1200': 7_200,
      '4000': -5_000,
      '4010': -1_000,
      '2200': -1_200,
    });
    expect(lateShipment.net).toEqual(factOrder.net);
    expect(lateShipment.order).toMatchObject({
      status: 'cancelled',
      goods_released_minor: 5_000,
      shipping_released: true,
    });
    // the late shipment itself: Dr 1200 (5000 + 1000 + VAT delta 1200), Cr 4000 5000, Cr 4010 1000, Cr 2200 1200
    const cancelled = postEvent(cancel, postEvent(e, null).order!).order!;
    const late = postEvent(ship, cancelled);
    expect(sorted(late.entries[0]!.lines)).toEqual(
      sorted([dr('1200', 7_200), cr('4000', 5_000), cr('4010', 1_000), cr('2200', 1_200)]),
    );
    // a shipment dated after the cancellation stays a defect
    const after = shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 1 }], {
      shipped_at: '2026-10-09T08:00:00.000Z',
    });
    expect(() => postEvent(after, cancelled)).toThrow(/cancelled order/);
  });
});
