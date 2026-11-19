// BI v2 wave 2 (#935) models on a small, hand-built history where every expected figure is known:
//   * dim_customer: the latest customer.* event gives the CURRENT group; fct_order / mart_sales_daily carry it;
//   * fct_order_sales: mart_sales_daily's counted orders and net sales, one row per order;
//   * fct_order_touch: every counted order once per touch model, utm normalised, in_campaign by the campaign's dates;
//   * fct_shipment / fct_order_fulfilment: time to ship (first shipped), time to deliver only when every shipment is
//     delivered, cancelled orders out;
//   * fct_payment_event: distinct payments per outcome, failure codes normalised (free text → `other`);
//   * no customer id, identity id, free-text return reason or utm term in any staging view.
// Opt-in like models.test (src/testing/clickhouse-gate.ts). One throwaway database, dropped at the end.
import { createValidator, makeEvent, type EventEnvelopeV1Base } from '@platform/events';
import {
  emailHash,
  orderCancelled,
  orderPlaced,
  ORG,
  paymentCaptured,
  paymentFailed,
  refundIssued,
  shipmentShipped,
  allItems,
  STORE_A,
} from '@platform/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChClient, createRawEventsSink, type ChClient } from './clickhouse.js';
import { loadConfig } from './config.js';
import { migrate, readSqlFiles } from './migrations.js';
import { classify } from './rows.js';
import { clickHouseSkipReason, throwawayDatabase } from './testing/clickhouse-gate.js';
import { toWire } from './testing/fakes.js';

const cfg = loadConfig(process.env, []).clickhouse;
const skip = await clickHouseSkipReason(cfg);
if (skip) console.warn(`models-wave2.test: ${skip} — skipped`);

const validator = createValidator();
const id = (n: number) => `00000000-0000-4000-8000-0000935${String(n).padStart(5, '0')}`;
const G1 = id(901);
const G2 = id(902);
const CAMPAIGN = id(903);
const W1 = id(911);
const W2 = id(912);

// ---- orders: o0..o7 in store A, EUR, 1 000 each, one per day at 10:00 ------------------------------------------
const KEYS = ['k1', 'k1', 'k1', 'k2', 'k3', 'k3', null, 'k4'] as const;
const orders = KEYS.map((k, i) => {
  const o = orderPlaced({
    orderId: id(i),
    storeId: STORE_A,
    lines: [{ quantity: 1, unit_price_minor: 1000, tax_rate_bp: 0 }],
    placed_at: `2026-10-0${i + 1}T10:00:00.000Z`,
  });
  (o.payload as { email_hash: string | null }).email_hash = k
    ? emailHash(`${k}@example.test`)
    : null;
  return o;
});
const [o0, o1, o2, o3, , o5, , o7] = orders as [
  (typeof orders)[number],
  ...(typeof orders)[number][],
];

const ev = (
  topic: string,
  aggregateType: string,
  aggregateId: string,
  at: string,
  payload: Record<string, unknown>,
) =>
  makeEvent({
    topic: topic as never,
    organizationId: ORG,
    storeId: STORE_A,
    aggregateType: aggregateType as never,
    aggregateId,
    occurredAt: new Date(at),
    payload: payload as never,
  }) as unknown as EventEnvelopeV1Base;

const customer = (
  topic: 'customer.created' | 'customer.updated',
  n: number,
  key: string,
  group: string | null,
  at: string,
) =>
  ev(topic, 'customer', id(500 + n), at, {
    customer_id: id(500 + n),
    identity_id: id(600 + n),
    email_hash: emailHash(`${key}@example.test`),
    status: 'registered',
    customer_group_id: group,
    marketing_consent: false,
    ...(topic === 'customer.updated' ? { changed_fields: ['customer_group_id'] } : {}),
  });

let touchCount = 0;
const touch = (
  o: (typeof orders)[number],
  kind: 'first' | 'last',
  source: string,
  campaign: string | null,
) =>
  ev('attribution.recorded', 'order', o.payload.order_id, o.payload.placed_at, {
    attribution_id: id(400 + touchCount++),
    order_id: o.payload.order_id,
    cart_id: null,
    touch: kind,
    utm_source: source,
    utm_medium: 'cpc',
    utm_campaign: 'Autumn',
    utm_term: 'shoes',
    utm_content: null,
    referrer: null,
    landing_path: '/',
    campaign_id: campaign,
    captured_at: o.payload.placed_at,
    recorded_at: o.payload.placed_at,
  });

const shipmentCreated = (
  o: (typeof orders)[number],
  shipmentId: string,
  warehouse: string,
  carrier: string,
  at: string,
) =>
  ev('shipment.created', 'shipment', shipmentId, at, {
    shipment_id: shipmentId,
    order_id: o.payload.order_id,
    warehouse_id: warehouse,
    carrier,
    service: 'standard',
    items: allItems(o),
    destination_country: 'NL',
    currency: 'EUR',
  });
const shipped = (o: (typeof orders)[number], shipmentId: string, warehouse: string, at: string) => {
  const e = shipmentShipped(o, allItems(o), { shipmentId, shipped_at: at });
  (e.payload as { warehouse_id: string; carrier: string }).warehouse_id = warehouse;
  return e as unknown as EventEnvelopeV1Base;
};
const delivered = (o: (typeof orders)[number], shipmentId: string, at: string) =>
  ev('shipment.delivered', 'shipment', shipmentId, at, {
    shipment_id: shipmentId,
    order_id: o.payload.order_id,
    delivered_at: at,
  });

const events: EventEnvelopeV1Base[] = [
  ...(orders as unknown as EventEnvelopeV1Base[]),
  orderCancelled(o7!) as unknown as EventEnvelopeV1Base,
  // customers: k1 moves G1 → G2 (current = G2); k2 in G1; k3 in no group; k4 never seen
  customer('customer.created', 1, 'k1', G1, '2026-09-01T00:00:00.000Z'),
  customer('customer.updated', 1, 'k1', G2, '2026-10-20T00:00:00.000Z'),
  customer('customer.created', 2, 'k2', G1, '2026-09-01T00:00:00.000Z'),
  customer('customer.created', 3, 'k3', null, '2026-09-01T00:00:00.000Z'),
  // payments: o0 authorised + captured; o2 captured (then refunded); o1 failed then captured by another payment (counted); o5 failed twice on
  // ONE payment (failed-only: out of sales), once with free text
  ev('payment.authorized', 'payment', id(700), o0!.payload.placed_at, {
    payment_id: id(700),
    order_id: o0!.payload.order_id,
    legal_entity_id: o0!.payload.legal_entity_id,
    provider: 'stripe',
    provider_payment_id: 'pi_fixture_a',
    amount_minor: 1000,
    currency: 'EUR',
    authorized_at: o0!.payload.placed_at,
  }),
  paymentCaptured(o0!, { paymentId: id(700) }) as unknown as EventEnvelopeV1Base,
  paymentFailed(o1!, { paymentId: id(701) }) as unknown as EventEnvelopeV1Base,
  paymentCaptured(o1!, { paymentId: id(702) }) as unknown as EventEnvelopeV1Base,
  paymentFailed(o5!, { paymentId: id(705) }) as unknown as EventEnvelopeV1Base,
  paymentFailed(o5!, {
    paymentId: id(705),
    failure_reason: 'Declined: call the bank',
    failed_at: '2026-10-06T10:05:00.000Z',
  }) as unknown as EventEnvelopeV1Base,
  paymentCaptured(o2!, { paymentId: id(703) }) as unknown as EventEnvelopeV1Base,
  refundIssued(o2!, paymentCaptured(o2!, { paymentId: id(703) }), {
    amount_minor: 300,
  }) as unknown as EventEnvelopeV1Base,
  // attribution: last touches on o0, o1 (campaign, inside its dates), o3 (campaign, after it ended), o5 (out of
  // sales); one first touch on o0
  touch(o0!, 'last', '  Google ', CAMPAIGN),
  touch(o0!, 'first', 'Newsletter', null),
  touch(o1!, 'last', 'google', CAMPAIGN),
  touch(o3!, 'last', 'FB', CAMPAIGN),
  touch(o5!, 'last', 'google', null),
  ev('campaign.launched', 'campaign', CAMPAIGN, '2026-09-30T00:00:00.000Z', {
    campaign_id: CAMPAIGN,
    name: 'Autumn',
    type: 'paid_search',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'autumn',
    budget: { amount_minor: 5000, currency: 'EUR' },
    starts_at: '2026-09-30T00:00:00.000Z',
    ends_at: '2026-10-03T00:00:00.000Z',
  }),
  // shipments: o0 two (one delivered, one not); o1 one, delivered; o2 created only; o7 (cancelled) one, shipped
  shipmentCreated(o0!, id(800), W1, 'DHL', '2026-10-01T12:00:00.000Z'),
  shipped(o0!, id(800), W1, '2026-10-01T20:00:00.000Z'),
  delivered(o0!, id(800), '2026-10-03T10:00:00.000Z'),
  shipmentCreated(o0!, id(801), W2, 'DHL', '2026-10-02T08:00:00.000Z'),
  shipped(o0!, id(801), W2, '2026-10-02T10:00:00.000Z'),
  shipmentCreated(o1!, id(810), W2, 'UPS', '2026-10-02T11:00:00.000Z'),
  shipped(o1!, id(810), W2, '2026-10-02T15:00:00.000Z'),
  delivered(o1!, id(810), '2026-10-04T10:00:00.000Z'),
  shipmentCreated(o2!, id(820), W1, 'DHL', '2026-10-03T12:00:00.000Z'),
  shipmentCreated(o7!, id(870), W1, 'DHL', '2026-10-08T12:00:00.000Z'),
  shipped(o7!, id(870), W1, '2026-10-08T14:00:00.000Z'),
  // carts and a return request whose free-text reason must not reach any model
  ...[1, 2].map((n) =>
    ev('cart.abandoned', 'cart', id(950 + n), '2026-10-09T00:00:00.000Z', {
      cart_id: id(950 + n),
      customer_id: null,
      email_hash: null,
      currency: 'EUR',
      total_minor: 2500 * n,
      line_item_count: n,
      last_activity_at: '2026-10-08T00:00:00.000Z',
      abandoned_at: '2026-10-09T00:00:00.000Z',
      has_attribution: false,
    }),
  ),
  ev('return.requested', 'return', id(960), '2026-10-10T00:00:00.000Z', {
    return_id: id(960),
    order_id: o1!.payload.order_id,
    reason: 'too small, call me back',
    items: [{ order_line_item_id: o1!.payload.line_items[0]!.order_line_item_id, quantity: 1 }],
    requested_at: '2026-10-10T00:00:00.000Z',
  }),
];
for (const e of events) {
  const check = validator.validateEnvelope(e);
  if (!check.ok) throw new Error(`fixture ${e.topic} invalid: ${check.errors.join('; ')}`);
}

type Row = Record<string, string | number | null>;

describe.runIf(skip === null)('BI v2 wave 2 models (#935)', () => {
  const db = throwawayDatabase();
  let admin: ChClient;
  let c: ChClient;
  // 64-bit integers may come back as strings: numbers everywhere, so expectations are plain numbers
  const num = (v: unknown): unknown =>
    typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : Array.isArray(v) ? v.map(num) : v;
  const q = async (query: string): Promise<Row[]> =>
    (await (await c.query({ query, format: 'JSONEachRow' })).json<Row>()).map(
      (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])) as Row,
    );

  beforeAll(async () => {
    admin = createChClient(cfg, 'default');
    c = createChClient(cfg, db);
    await migrate(admin, c, db, readSqlFiles());
    await createRawEventsSink(c).insert(
      events.map((e, i) => {
        const r = classify(
          toWire(e, i),
          { topic: e.topic, partition: 0 },
          { groupId: 'analytics.raw', validator, now: new Date('2026-11-01T00:00:00.000Z') },
        );
        if (r.kind !== 'row') throw new Error(`fixture ${e.topic} dead-lettered`);
        return r.row;
      }),
    );
  });

  afterAll(async () => {
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => undefined);
    await Promise.allSettled([admin?.close(), c?.close()]);
  });

  it('dim_customer: the latest customer event gives the CURRENT group; orders carry it, no key → no group', async () => {
    const rows = await q(
      `SELECT toString(order_id) o, toString(customer_group_id) g FROM fct_order ORDER BY o`,
    );
    expect(rows.map((r) => r.g)).toEqual([G2, G2, G2, G1, null, null, null, null]);
    const [s] = await q(
      `SELECT sum(orders) n, sumIf(orders, customer_group_id = toUUID('${G2}')) g2 FROM mart_sales_daily`,
    );
    // o5 (failed-only) and o7 (cancelled) are not counted; o0..o2 are k1's (G2)
    expect(s).toEqual({ n: 6, g2: 3 });
  });

  it('fct_order_sales: one row per counted order, net = total − refunds (mart_sales_daily = its sums)', async () => {
    const [r] = await q(`SELECT count() n, sum(net_minor) net FROM fct_order_sales`);
    const [m] = await q(`SELECT sum(orders) n, sum(net_minor) net FROM mart_sales_daily`);
    expect(r).toEqual({ n: 6, net: 5700 });
    expect(m).toEqual(r);
  });

  it('fct_order_touch: two rows per counted order; utm normalised; in_campaign by the campaign dates', async () => {
    const rows = await q(
      `SELECT touch, countIf(attributed = 1) a, count() n, groupArraySorted(10)(ifNull(utm_source, '-')) src,
              sum(in_campaign) inc, sumIf(net_minor, attributed = 1) net
       FROM fct_order_touch GROUP BY touch ORDER BY touch`,
    );
    expect(rows).toEqual([
      {
        touch: 'first',
        a: 1,
        n: 6,
        src: ['-', '-', '-', '-', '-', 'newsletter'],
        inc: 0,
        net: 1000,
      },
      {
        touch: 'last',
        a: 3,
        n: 6,
        src: ['-', '-', '-', 'fb', 'google', 'google'],
        inc: 2,
        net: 3000,
      },
    ]);
  });

  it('dim_campaign: the planned budget, its currency and dates', async () => {
    const [r] = await q(
      `SELECT name, type, budget_minor b, budget_currency cur, toString(starts_at) s FROM dim_campaign`,
    );
    expect(r).toEqual({
      name: 'Autumn',
      type: 'paid_search',
      b: 5000,
      cur: 'EUR',
      s: '2026-09-30 00:00:00.000',
    });
  });

  it('fct_order_fulfilment: first shipment to ship, last delivery only when all are delivered; cancelled out', async () => {
    const rows = await q(
      `SELECT toString(order_id) o, toString(warehouse_id) w, carrier, hours_to_ship h, hours_to_deliver d
       FROM fct_order_fulfilment ORDER BY o`,
    );
    expect(rows).toEqual([
      { o: id(0), w: W1, carrier: 'dhl', h: 10, d: null }, // the second shipment is not delivered
      { o: id(1), w: W2, carrier: 'ups', h: 5, d: 48 },
      { o: id(2), w: W1, carrier: 'dhl', h: null, d: null }, // created, never shipped
    ]);
    const [s] = await q(
      `SELECT count() n, countIf(cost_minor IS NOT NULL) costed, countIf(destination_country = 'NL') nl FROM fct_shipment`,
    );
    expect(s).toEqual({ n: 5, costed: 4, nl: 5 });
  });

  it('fct_payment_event: distinct payments per outcome; free-text failure reasons become `other`', async () => {
    const rows = await q(
      `SELECT outcome, uniqExact(payment_id) n, groupUniqArray(toString(failure_code)) codes
       FROM fct_payment_event GROUP BY outcome ORDER BY outcome`,
    );
    expect(
      rows.map((r) => ({ ...r, codes: [...(r.codes as unknown as string[])].sort() })),
    ).toEqual([
      { outcome: 'authorized', n: 1, codes: [''] },
      { outcome: 'captured', n: 3, codes: [''] },
      { outcome: 'failed', n: 2, codes: ['card_declined', 'other'] },
    ]);
  });

  it('carts and return requests are counted; no staging view holds a customer id, identity, reason or utm term', async () => {
    const [carts] = await q(`SELECT count() n, sum(total_minor) v FROM stg_cart_abandoned_v1`);
    expect(carts).toEqual({ n: 2, v: 7500 });
    const [ret] = await q(`SELECT count() n FROM stg_return_requested_v1`);
    expect(ret).toEqual({ n: 1 });
    const cols = await q(
      `SELECT table, name FROM system.columns WHERE database = currentDatabase()
       AND table IN ('stg_customer_v1', 'dim_customer', 'stg_attribution_v1', 'fct_order_touch', 'stg_cart_abandoned_v1',
                     'stg_return_requested_v1', 'stg_payment_failure_v1', 'stg_campaign_v1')
       AND match(name, '(?i)(customer_id|identity|email|reason|utm_term|utm_content|referrer|landing)')`,
    );
    expect(cols).toEqual([]);
  });
});

// #935: refunds by product — a refund for a return split over the returned lines, exactly
describe.runIf(skip === null)(
  'fct_refund_line: a refund split over its returned lines (#935)',
  () => {
    const db = throwawayDatabase();
    let admin: ChClient;
    let c: ChClient;
    // two lines: 1 × 1 000 and 2 × 500; one unit of each returned → weights 1 000 and 500
    const o = orderPlaced({
      orderId: id(990),
      storeId: STORE_A,
      lines: [
        { quantity: 1, unit_price_minor: 1000, tax_rate_bp: 0 },
        { quantity: 2, unit_price_minor: 500, tax_rate_bp: 0 },
      ],
      placed_at: '2026-10-01T10:00:00.000Z',
    });
    const [l1, l2] = o.payload.line_items as [
      { order_line_item_id: string },
      { order_line_item_id: string },
    ];
    const pay = paymentCaptured(o, { paymentId: id(991) });
    const refund = refundIssued(o, pay, { amount_minor: 1001, refundId: id(992) });
    (refund.payload as { return_id: string | null }).return_id = id(993);
    const plain = refundIssued(o, pay, { amount_minor: 50, refundId: id(994) }); // no return: order level
    const events = [
      o,
      pay,
      refund,
      plain,
      ev('return.received', 'return', id(993), '2026-10-05T00:00:00.000Z', {
        return_id: id(993),
        order_id: o.payload.order_id,
        warehouse_id: W1,
        items: [
          { order_line_item_id: l1.order_line_item_id, quantity: 1, condition: 'resellable' },
          { order_line_item_id: l2.order_line_item_id, quantity: 1, condition: 'resellable' },
        ],
        received_at: '2026-10-05T00:00:00.000Z',
      }),
    ] as unknown as EventEnvelopeV1Base[];

    beforeAll(async () => {
      admin = createChClient(cfg, 'default');
      c = createChClient(cfg, db);
      await migrate(admin, c, db, readSqlFiles());
      await createRawEventsSink(c).insert(
        events.map((e, i) => {
          const r = classify(
            toWire(e, i),
            { topic: e.topic, partition: 0 },
            { groupId: 'analytics.raw', validator, now: new Date('2026-11-01T00:00:00.000Z') },
          );
          if (r.kind !== 'row') throw new Error(`fixture ${e.topic} dead-lettered`);
          return r.row;
        }),
      );
    });
    afterAll(async () => {
      await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => undefined);
      await Promise.allSettled([admin?.close(), c?.close()]);
    });

    it('shares by paid value, the remainder on the heaviest line; a refund with no return stays order-level', async () => {
      const rows = await (
        await c.query({
          query: `SELECT toString(refund_id) AS r, toString(product_id) AS p, amount_minor AS a
                FROM fct_refund_line ORDER BY r, a DESC`,
          format: 'JSONEachRow',
        })
      ).json<{ r: string; p: string | null; a: string | number }>();
      expect(rows.map((x) => [x.r, Number(x.a)])).toEqual([
        [id(992), 668], // 1 001 × 1 000 / 1 500 = 667, + the remainder 1
        [id(992), 333], // 1 001 × 500 / 1 500
        [id(994), 50],
      ]);
      expect(rows[2]!.p).toBeNull();
      const [sum] = await (
        await c.query({
          query: `SELECT (SELECT sum(amount_minor) FROM fct_refund_line) AS l, (SELECT sum(amount_minor) FROM fct_refund) AS f`,
          format: 'JSONEachRow',
        })
      ).json<{ l: string | number; f: string | number }>();
      expect(Number(sum!.l)).toBe(Number(sum!.f));
    });
  },
);
