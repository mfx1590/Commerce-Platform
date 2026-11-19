// BI v2 wave 2 (#935) on REAL ClickHouse: every new metric compiles and runs with each dimension it accepts, each
// filter and each grain (a SQL error anywhere fails here, not in production); and on a store built so every figure is
// known: distinct and repeat customers, the small-cell rule (with its complementary cell and the total), the
// quantile total from its own query (never an average of rows), payments counted once per payment, attribution by
// touch. Opt-in like metrics-live (ANALYTICS_LIVE=1 or CI); one throwaway database, dropped at the end.
import { makeEvent, type EventEnvelopeV1Base } from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIMENSION_INFO, METRIC_IDS, METRICS, type Dimension, type MetricId } from './catalogue';
import { executeMetricQuery, type MetricsReader } from './execute';
import { parseMetricQuery } from './query';

const CH = {
  url: process.env.CLICKHOUSE_URL?.trim() || 'http://127.0.0.1:18123',
  username: process.env.CLICKHOUSE_USER?.trim() || 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
};

async function skipReason(): Promise<string | null> {
  if (process.env.ANALYTICS_LIVE !== '1' && process.env.CI !== 'true')
    return 'not opted in (set ANALYTICS_LIVE=1 once you hold the machine)';
  try {
    const auth = Buffer.from(`${CH.username}:${CH.password}`).toString('base64');
    const res = await fetch(`${CH.url}/?query=SELECT%201`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? null : `ClickHouse ${CH.url}: HTTP ${res.status} for user ${CH.username}`;
  } catch (err) {
    return `ClickHouse ${CH.url}: ${(err as Error).name}`;
  }
}
const skip = await skipReason();
if (skip) console.warn(`metrics-wave2-live.test: ${skip} — skipped`);

const id = (n: number) => `00000000-0000-4000-8000-0000935${String(n).padStart(5, '0')}`;
const D = id(1); // a store of its own: every figure below is known
const G1 = id(901);
const G2 = id(902);
const W1 = id(911);
const W2 = id(912);
const CAMPAIGN = id(903);
const WAVE2 = METRIC_IDS.slice(METRIC_IDS.indexOf('customers')) as MetricId[];

describe.runIf(skip === null)('BI v2 wave 2 metrics on ClickHouse (#935)', () => {
  const db = `analytics_test_w2${Math.random().toString(36).slice(2, 7)}`;
  let close: () => Promise<void> = async () => {};
  let reader: MetricsReader;
  const noPromotions = { promotions: async () => [] };

  beforeAll(async () => {
    const ingest = await import('@platform/analytics-ingest');
    const tu = await import('@platform/test-utils');
    const { createValidator } = await import('@platform/events');
    const admin = ingest.createChClient({ ...CH, database: 'default' }, 'default');
    const ch = ingest.createChClient({ ...CH, database: db }, db);
    close = async () => {
      await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => {});
      await Promise.allSettled([admin.close(), ch.close()]);
    };
    await ingest.migrate(admin, ch, db, ingest.readSqlFiles());
    const ev = (topic: string, type: string, agg: string, at: string, payload: object) =>
      makeEvent({
        topic: topic as never,
        organizationId: tu.ORG,
        storeId: D,
        aggregateType: type as never,
        aggregateId: agg,
        occurredAt: new Date(at),
        payload: payload as never,
      }) as unknown as EventEnvelopeV1Base;
    // 7 customers in store D: k1 three orders, k2 two, k3..k7 one; k1, k2 in G1, the rest in G2. 1 000 EUR each.
    const keys = ['k1', 'k1', 'k1', 'k2', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'];
    const orders = keys.map((k, i) => {
      const o = tu.orderPlaced({
        orderId: id(100 + i),
        storeId: D,
        lines: [{ quantity: 1, unit_price_minor: 1000, tax_rate_bp: 0 }],
        placed_at: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
      });
      (o.payload as { email_hash: string }).email_hash = tu.emailHash(`${k}@example.test`);
      return o;
    });
    const customer = (n: number, group: string) =>
      ev('customer.created', 'customer', id(500 + n), '2026-09-01T00:00:00.000Z', {
        customer_id: id(500 + n),
        identity_id: null,
        email_hash: tu.emailHash(`k${n}@example.test`),
        status: 'registered',
        customer_group_id: group,
        marketing_consent: false,
      });
    const shipped = (o: (typeof orders)[number], n: number, warehouse: string, hours: number) => {
      const placed = Date.parse(o.payload.placed_at);
      const at = new Date(placed + hours * 3_600_000).toISOString();
      const e = tu.shipmentShipped(o, tu.allItems(o), { shipmentId: id(800 + n), shipped_at: at });
      (e.payload as { warehouse_id: string }).warehouse_id = warehouse;
      return e as unknown as EventEnvelopeV1Base;
    };
    let touches = 0;
    const touch = (o: (typeof orders)[number], kind: string, source: string) =>
      ev('attribution.recorded', 'order', o.payload.order_id, o.payload.placed_at, {
        attribution_id: id(400 + touches++),
        order_id: o.payload.order_id,
        cart_id: null,
        touch: kind,
        utm_source: source,
        utm_medium: 'cpc',
        utm_campaign: 'autumn',
        utm_term: null,
        utm_content: null,
        referrer: null,
        landing_path: '/',
        campaign_id: CAMPAIGN,
        captured_at: o.payload.placed_at,
        recorded_at: o.payload.placed_at,
      });
    const events: EventEnvelopeV1Base[] = [
      ...(orders as unknown as EventEnvelopeV1Base[]),
      ...[1, 2].map((n) => customer(n, G1)),
      ...[3, 4, 5, 6, 7].map((n) => customer(n, G2)),
      // time to ship: W1 10 h and 20 h, W2 30 h → per warehouse 10/20 and 30; over all three the median is 20
      shipped(orders[0]!, 0, W1, 10),
      shipped(orders[1]!, 1, W1, 20),
      shipped(orders[2]!, 2, W2, 30),
      // payments: one payment failing twice then captured (counts once failed, once captured); another captured
      tu.paymentFailed(orders[3]!, { paymentId: id(700) }) as unknown as EventEnvelopeV1Base,
      tu.paymentFailed(orders[3]!, {
        paymentId: id(700),
        failure_reason: 'Please call your bank',
        failed_at: '2026-10-04T10:01:00.000Z',
      }) as unknown as EventEnvelopeV1Base,
      tu.paymentCaptured(orders[3]!, { paymentId: id(700) }) as unknown as EventEnvelopeV1Base,
      tu.paymentCaptured(orders[4]!, { paymentId: id(701) }) as unknown as EventEnvelopeV1Base,
      // attribution: last touch on three orders (two google, one an e-mail-shaped value), first touch on one
      touch(orders[0]!, 'last', 'google'),
      touch(orders[1]!, 'last', 'Google '),
      touch(orders[2]!, 'last', 'someone@example.test'),
      touch(orders[0]!, 'first', 'newsletter'),
    ];
    // and the generated month in stores A–C, so every metric has rows of other stores to stay out of
    const month = tu.generateMonth({
      orders: 60,
      legalEntities: 3,
      deterministicIds: true,
      seed: 935,
    });
    const validator = createValidator();
    await ingest.createRawEventsSink(ch).insert(
      [...events, ...month.events].map((e, i) => {
        const c = ingest.classify(
          {
            key: null,
            value: JSON.stringify(e),
            headers: { outbox_id: e.event_id },
            offset: String(i),
            timestamp: String(Date.parse(e.occurred_at)),
          },
          { topic: e.topic, partition: 0 },
          { groupId: 'analytics.raw', validator, now: new Date('2026-11-01T00:00:00Z') },
        );
        if (c.kind !== 'row') throw new Error(`fixture ${e.topic} dead-lettered`);
        return c.row;
      }),
    );
    reader = ch as unknown as MetricsReader;
  }, 300_000);

  afterAll(async () => {
    await close();
  });

  const run = (body: Record<string, unknown>, scope: string[] = [D]) =>
    executeMetricQuery(
      reader,
      parseMetricQuery({ from: '2026-10-01', to: '2026-11-01', grain: 'total', ...body }),
      scope,
      noPromotions,
    );

  it('every wave 2 metric runs on ClickHouse with each dimension it accepts, each grain, and each filter', async () => {
    const filterValue: Partial<Record<Dimension, unknown[]>> = {
      customer_group: [G1],
      campaign: [CAMPAIGN],
      promotion: [CAMPAIGN],
      utm_source: ['google'],
      utm_medium: ['cpc'],
      utm_campaign: ['autumn'],
      carrier: ['manual'],
      warehouse: [W1],
      country: ['NL'],
      store: [D],
    };
    let runs = 0;
    for (const m of WAVE2) {
      const def = METRICS[m];
      for (const grain of ['day', 'total'])
        for (const dims of [[], ...def.dimensions.map((d) => [d])]) {
          await run({ metrics: [m], dimensions: dims, grain });
          runs++;
        }
      for (const d of def.dimensions) {
        const f = DIMENSION_INFO[d].filter;
        const v = filterValue[d];
        if (!f || !v) continue;
        await run({ metrics: [m], filters: { [f]: v } });
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(200);
  }, 300_000);

  it('customers: distinct per store, repeat = 2+ orders, orders and net of known customers', async () => {
    const r = await run({
      metrics: [
        'customers',
        'repeat_customers',
        'customer_orders',
        'repeat_rate_bp',
        'orders_per_customer_bp',
      ],
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.values).toEqual({
      customers: 7,
      repeat_customers: 2,
      customer_orders: 10,
      repeat_rate_bp: 2857, // 2 / 7
      orders_per_customer_bp: 14286, // 10 / 7
    });
  });

  it('small cells: a group under 5 customers is suppressed, its complement too; the total (7) is shown', async () => {
    const r = await run({
      metrics: ['customers', 'revenue_per_customer_minor'],
      dimensions: ['customer_group'],
    });
    const by = Object.fromEntries(r.rows.map((x) => [x.customer_group_id, x]));
    expect(by[G1]).toMatchObject({
      suppressed: true,
      values: { customers: 2, revenue_per_customer_minor: null },
    });
    // G2 has 5 customers, but showing it would reveal G1 from the total: the complementary cell
    expect(by[G2]).toMatchObject({
      suppressed: true,
      values: { customers: 5, revenue_per_customer_minor: null },
    });
    expect(r.currency_totals).toEqual([
      { currency: 'EUR', values: { customers: 7, revenue_per_customer_minor: 1429 } }, // 10 000 / 7
    ]);
  });

  it('quantiles: per warehouse, and the total is its OWN quantile over every order, never an average of rows', async () => {
    const r = await run({
      metrics: ['hours_to_ship_p50', 'orders_shipped'],
      dimensions: ['warehouse'],
    });
    const by = Object.fromEntries(r.rows.map((x) => [x.warehouse_id, x.values]));
    expect(by[W2]).toEqual({ hours_to_ship_p50: 30, orders_shipped: 1 });
    expect(by[W1]!.orders_shipped).toBe(2);
    expect(r.currency_totals).toEqual([
      { currency: null, values: { hours_to_ship_p50: 20, orders_shipped: 3 } },
    ]);
  });

  it('payments: distinct payments per outcome; retries count once; free text is `other`', async () => {
    const r = await run({
      metrics: [
        'payments_failed',
        'payments_captured',
        'payments_with_outcome',
        'payment_failure_rate_bp',
      ],
    });
    expect(r.rows[0]!.values).toEqual({
      payments_failed: 1,
      payments_captured: 2,
      payments_with_outcome: 2,
      payment_failure_rate_bp: 5000,
    });
    const codes = await run({ metrics: ['payments_failed'], dimensions: ['failure_reason'] });
    expect(
      codes.rows
        .filter((x) => x.failure_reason !== null)
        .map((x) => [x.failure_reason, x.values.payments_failed]),
    ).toEqual([
      ['card_declined', 1],
      ['other', 1],
    ]);
  });

  it('attribution: by touch; utm normalised, an e-mail-shaped value is `other`; unattributed counted', async () => {
    const last = await run({
      metrics: ['attributed_orders', 'attributed_net_sales_minor'],
      dimensions: ['utm_source'],
    });
    expect(last.rows.map((x) => [x.utm_source, x.values.attributed_orders])).toEqual([
      ['google', 2],
      ['other', 1],
      [null, 0],
    ]);
    const first = await run({
      metrics: ['attributed_orders', 'unattributed_orders'],
      filters: { touch: 'first' },
    });
    expect(first.rows[0]!.values).toEqual({ attributed_orders: 1, unattributed_orders: 9 });
  });

  it('nothing of store D reaches another scope (the month stores A–C only)', async () => {
    const tu = await import('@platform/test-utils');
    const r = await run({ metrics: ['customers', 'orders_shipped'], dimensions: ['store'] }, [
      tu.STORE_A,
    ]);
    expect(r.rows.every((x) => x.store_id === tu.STORE_A)).toBe(true);
  });
});
