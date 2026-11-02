// The ClickHouse models (#601) on the shared generated month (@platform/test-utils, the #552 month: refunds,
// cancellations before and after partial shipments, unknown fees, three legal entities with Brand C / USD), written
// straight into raw_events of a throwaway database (no broker: the ingest itself is live.test's job).
//   * uniqueness and not-null per fact key; product_id through dim_variant (latest product event wins);
//   * mart_bookings_daily = a reference computed HERE from the same events with Postgres rpt_sales_daily's rules,
//     row for row (the Postgres = ClickHouse identity itself is #602's);
//   * mart_cash_daily = the same for rpt_payments_daily;
//   * late events and replays (a second database fed the month in reverse, every event twice, the MV created after
//     part of the data so its backfill runs) give the same marts and live tiles;
//   * live_orders_minute counts orders exactly per store × currency;
//   * no PII-named column in any model.
// Opt-in and skipped with a printed reason like live.test (src/testing/clickhouse-gate.ts). Self-cleaning.
import {
  createValidator,
  makeEvent,
  type EventEnvelopeV1Base,
  type EventEnvelope,
} from '@platform/events';
import { generateMonth, ORG } from '@platform/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChClient, createRawEventsSink, type ChClient } from './clickhouse.js';
import { loadConfig } from './config.js';
import { migrate, MigrationLockedError, readSqlFiles } from './migrations.js';
import { classify, type RawEventRow } from './rows.js';
import { clickHouseSkipReason, throwawayDatabase } from './testing/clickhouse-gate.js';
import { toWire } from './testing/fakes.js';

const cfg = loadConfig(process.env, []).clickhouse;
const skip = await clickHouseSkipReason(cfg);
if (skip) console.warn(`models.test: ${skip} — the ClickHouse model tests are skipped`);

const validator = createValidator();

// ---- the month, plus catalogue events so dim_variant has something to resolve -------------------------------

const month = generateMonth({ orders: 150, legalEntities: 3, deterministicIds: true, seed: 601 });
type Placed = EventEnvelope<'order.placed'>;
const placed = month.events.filter((e) => e.topic === 'order.placed') as unknown as Placed[];

/** Two of every three orders' variants are published (one product per order); the rest stay unpublished. */
const catalogue: EventEnvelopeV1Base[] = [];
const expectedProduct = new Map<string, string>(); // order_line_item_id → product_id
placed.forEach((o, i) => {
  if (i % 3 === 2) return;
  const productId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const variants = o.payload.line_items
    .filter((l) => l.variant_id)
    .map((l) => ({ variant_id: l.variant_id!, sku: l.sku, title: 'Fixture variant' }));
  catalogue.push(
    makeEvent({
      topic: 'product.published',
      organizationId: ORG,
      storeId: o.store_id,
      aggregateType: 'product',
      aggregateId: productId,
      occurredAt: new Date('2026-09-20T00:00:00.000Z'),
      payload: {
        product_id: productId,
        handle: `fixture-${i}`,
        title: 'Fixture product',
        category_id: null,
        variants,
        published_at: '2026-09-20T00:00:00.000Z',
      },
    }) as unknown as EventEnvelopeV1Base,
  );
  for (const l of o.payload.line_items)
    if (l.variant_id) expectedProduct.set(l.order_line_item_id, productId);
});
// a later product.updated moves the first order's variants to another product: the latest event wins
const moved = placed[0]!;
const movedTo = '00000000-0000-4000-8000-999999999999';
catalogue.push(
  makeEvent({
    topic: 'product.updated',
    organizationId: ORG,
    storeId: moved.store_id,
    aggregateType: 'product',
    aggregateId: movedTo,
    occurredAt: new Date('2026-09-25T00:00:00.000Z'),
    payload: {
      product_id: movedTo,
      handle: 'fixture-moved',
      status: 'published',
      changed_fields: ['variants'],
      variants: moved.payload.line_items.map((l) => ({
        variant_id: l.variant_id!,
        sku: l.sku,
        title: 'Fixture variant',
      })),
    },
  }) as unknown as EventEnvelopeV1Base,
);
for (const l of moved.payload.line_items) expectedProduct.set(l.order_line_item_id, movedTo);

const allEvents = [...catalogue, ...month.events];
for (const e of allEvents) {
  const check = validator.validateEnvelope(e);
  if (!check.ok) throw new Error(`fixture ${e.topic} invalid: ${check.errors.join('; ')}`);
}

function rowsOf(events: readonly EventEnvelopeV1Base[], at: string): RawEventRow[] {
  return events.map((e, i) => {
    const c = classify(
      toWire(e, i),
      { topic: e.topic, partition: 0 },
      {
        groupId: 'analytics.raw',
        validator,
        now: new Date(at),
      },
    );
    if (c.kind !== 'row')
      throw new Error(`fixture ${e.topic} was dead-lettered: ${c.letter.error_class}`);
    return c.row;
  });
}

// ---- the references, computed from the events with the Postgres report rules ---------------------------------

const day = (iso: string) => iso.slice(0, 10);
const cancelled = new Set(
  month.events
    .filter((e) => e.topic === 'order.cancelled')
    .map((e) => (e.payload as { order_id: string }).order_id),
);
const refunded = new Map<string, number>();
for (const e of month.events.filter((x) => x.topic === 'refund.issued')) {
  const p = e.payload as { order_id: string; amount_minor: number };
  refunded.set(p.order_id, (refunded.get(p.order_id) ?? 0) + p.amount_minor);
}

type Row = Record<string, string | number>;
function bookingsReference(): Row[] {
  const by = new Map<string, Row>();
  for (const o of placed) {
    const p = o.payload;
    if (cancelled.has(p.order_id)) continue; // rpt_sales_daily: status <> 'cancelled' (no failed payments in the month)
    const key = `${o.store_id}|${day(p.placed_at)}|${p.currency}`;
    const r = by.get(key) ?? {
      organization_id: o.organization_id,
      store_id: o.store_id!,
      day: day(p.placed_at),
      currency: p.currency,
      orders: 0,
      gross_minor: 0,
      discount_minor: 0,
      shipping_minor: 0,
      tax_minor: 0,
      total_minor: 0,
      refunded_minor: 0,
      net_minor: 0,
    };
    const ref = refunded.get(p.order_id) ?? 0;
    r.orders = Number(r.orders) + 1;
    r.gross_minor = Number(r.gross_minor) + p.totals.subtotal_minor;
    r.discount_minor = Number(r.discount_minor) + p.totals.discount_minor;
    r.shipping_minor = Number(r.shipping_minor) + p.totals.shipping_minor;
    r.tax_minor = Number(r.tax_minor) + p.totals.tax_minor;
    r.total_minor = Number(r.total_minor) + p.totals.total_minor;
    r.refunded_minor = Number(r.refunded_minor) + ref;
    r.net_minor = Number(r.net_minor) + p.totals.total_minor - ref;
    by.set(key, r);
  }
  return sortRows([...by.values()]);
}

function cashReference(): Row[] {
  const by = new Map<string, Row>();
  for (const e of month.events.filter((x) => x.topic === 'payment.captured')) {
    const p = e.payload as {
      provider: string;
      amount_minor: number;
      fee_minor: number | null;
      currency: string;
      captured_at: string;
    };
    const key = `${e.store_id}|${day(p.captured_at)}|${p.currency}|${p.provider}`;
    const r = by.get(key) ?? {
      organization_id: e.organization_id,
      store_id: e.store_id!,
      day: day(p.captured_at),
      currency: p.currency,
      provider: p.provider,
      captured_count: 0,
      captured_minor: 0,
      fee_minor: 0,
      fee_unknown: 0,
    };
    r.captured_count = Number(r.captured_count) + 1;
    r.captured_minor = Number(r.captured_minor) + p.amount_minor;
    r.fee_minor = Number(r.fee_minor) + (p.fee_minor ?? 0);
    r.fee_unknown = Number(r.fee_unknown) + (p.fee_minor === null ? 1 : 0);
    by.set(key, r);
  }
  return sortRows([...by.values()]);
}

function sortRows(rows: Row[]): Row[] {
  const k = (r: Row) => `${r.store_id}|${r.day}|${r.currency}|${r.provider ?? ''}`;
  return [...rows].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
}

/** ClickHouse JSON gives 64-bit integers as strings: numbers back, so rows compare with the reference. */
function numeric(rows: Row[]): Row[] {
  return sortRows(
    rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v,
        ]),
      ),
    ),
  );
}

// ---- the tests ------------------------------------------------------------------------------------------------

describe.runIf(skip === null)('ClickHouse models on the generated month', () => {
  const dbA = throwawayDatabase(); // in order, once
  const dbB = `${throwawayDatabase()}_late`; // reversed, every event twice, MV created after part of the data
  let admin: ChClient;
  let a: ChClient;
  let b: ChClient;

  const q = async (c: ChClient, query: string): Promise<Row[]> =>
    (await c.query({ query, format: 'JSONEachRow' })).json<Row>();

  beforeAll(async () => {
    admin = createChClient(cfg, 'default');
    a = createChClient(cfg, dbA);
    b = createChClient(cfg, dbB);
    const files = readSqlFiles();

    await migrate(admin, a, dbA, files);
    await createRawEventsSink(a).insert(rowsOf(allEvents, '2026-11-01T00:00:00.000Z'));

    // B: raw_events only, half the month (reversed), then the rest of the schema (the MV backfill runs), then
    // everything again in reverse, then the whole month once more with a later ingested_at (a replay)
    await migrate(
      admin,
      b,
      dbB,
      files.filter((f) => f.name === '0001_raw_events.sql'),
    );
    const reversed = [...allEvents].reverse();
    const sinkB = createRawEventsSink(b);
    await sinkB.insert(
      rowsOf(reversed.slice(0, Math.floor(reversed.length / 2)), '2026-11-01T00:00:00.000Z'),
    );
    await migrate(admin, b, dbB, files);
    await sinkB.insert(rowsOf(reversed, '2026-11-01T00:00:01.000Z'));
    await sinkB.insert(rowsOf(allEvents, '2026-11-02T00:00:00.000Z'));
  });

  afterAll(async () => {
    for (const db of [dbA, dbB])
      await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => undefined);
    await Promise.allSettled([admin?.close(), a?.close(), b?.close()]);
  });

  it('the month has what the identities need (refunds, cancellations, unknown fees, three currencies)', () => {
    expect(month.refunds).toBeGreaterThan(0);
    expect(month.cancellations).toBeGreaterThan(0);
    expect(new Set(placed.map((o) => o.payload.currency))).toEqual(new Set(['EUR', 'GBP', 'USD']));
  });

  it('facts: one row per key, no NULL keys', async () => {
    const [o] = await q(a, 'SELECT count() n, uniqExact(order_id) u FROM fct_order');
    expect(numeric([o!])[0]).toMatchObject({ n: placed.length, u: placed.length });
    const lines = placed.reduce((n, p) => n + p.payload.line_items.length, 0);
    const [l] = await q(
      a,
      'SELECT count() n, uniqExact(order_line_item_id) u, countIf(isNull(store_id)) ns FROM fct_order_line',
    );
    expect(numeric([l!])[0]).toMatchObject({ n: lines, u: lines, ns: 0 });
    const [p] = await q(
      a,
      "SELECT count() n, uniqExact(payment_id) u FROM fct_payment WHERE status = 'captured'",
    );
    expect(numeric([p!])[0]).toMatchObject({ n: month.captures, u: month.captures });
    const [r] = await q(a, 'SELECT count() n, uniqExact(refund_id) u FROM fct_refund');
    expect(numeric([r!])[0]).toMatchObject({ n: month.refunds, u: month.refunds });
    const shipped = month.events
      .filter((e) => e.topic === 'shipment.shipped')
      .reduce((n, e) => n + (e.payload as { items: unknown[] }).items.length, 0);
    const [s] = await q(
      a,
      'SELECT count() n, uniqExact(shipment_id, order_line_item_id) u FROM fct_shipment_line',
    );
    expect(numeric([s!])[0]).toMatchObject({ n: shipped, u: shipped });
    const [c] = await q(a, "SELECT countIf(order_status = 'cancelled') c FROM fct_order");
    expect(Number(c!.c)).toBe(cancelled.size);
  });

  it('a line never ships more than was ordered', async () => {
    const over = await q(
      a,
      `SELECT l.order_line_item_id, l.quantity, s.shipped FROM fct_order_line AS l
       INNER JOIN (SELECT order_line_item_id, sum(quantity) AS shipped FROM fct_shipment_line GROUP BY order_line_item_id) AS s
       ON s.order_line_item_id = l.order_line_item_id WHERE s.shipped > l.quantity`,
    );
    expect(over).toEqual([]);
  });

  it('product_id comes through dim_variant: the latest product event wins, unpublished variants are NULL', async () => {
    const rows = await q(
      a,
      'SELECT toString(order_line_item_id) id, toString(product_id) p FROM fct_order_line',
    );
    const got = new Map(rows.map((r) => [String(r.id), r.p === null ? null : String(r.p)]));
    let published = 0;
    let unpublished = 0;
    for (const o of placed)
      for (const l of o.payload.line_items) {
        const want = expectedProduct.get(l.order_line_item_id) ?? null;
        expect(got.get(l.order_line_item_id)).toBe(want);
        if (want) published += 1;
        else unpublished += 1;
      }
    expect(published).toBeGreaterThan(0);
    expect(unpublished).toBeGreaterThan(0);
    const [d] = await q(a, 'SELECT count() n, uniqExact(store_id, variant_id) u FROM dim_variant');
    expect(Number(d!.n)).toBe(Number(d!.u));
  });

  it('mart_bookings_daily = the rpt_sales_daily reference, row for row', async () => {
    const got = await q(
      a,
      'SELECT toString(organization_id) organization_id, toString(store_id) store_id, toString(day) day, currency, orders, gross_minor, discount_minor, shipping_minor, tax_minor, total_minor, refunded_minor, net_minor FROM mart_bookings_daily',
    );
    expect(numeric(got)).toEqual(bookingsReference());
  });

  it('mart_cash_daily = the rpt_payments_daily reference, row for row', async () => {
    const got = await q(
      a,
      'SELECT toString(organization_id) organization_id, toString(store_id) store_id, toString(day) day, currency, provider, captured_count, captured_minor, fee_minor, fee_unknown FROM mart_cash_daily',
    );
    const ref = cashReference();
    expect(ref.some((r) => Number(r.fee_unknown) > 0)).toBe(true);
    expect(numeric(got)).toEqual(ref);
  });

  it('late events, a reversed order, double inserts and an MV backfill change no mart and no tile', async () => {
    for (const view of [
      'mart_bookings_daily',
      'mart_cash_daily',
      'live_orders_minute',
      'fct_order_line',
    ]) {
      const order = view === 'fct_order_line' ? 'order_line_item_id' : 'store_id, currency, 3';
      const sql = `SELECT * FROM ${view} ORDER BY ${order}`;
      expect(await q(b, sql), view).toEqual(await q(a, sql));
    }
  });

  it('live_orders_minute counts every placed order exactly, per store and currency', async () => {
    const got = await q(
      a,
      'SELECT toString(store_id) store_id, currency, sum(orders) orders, sum(total_minor) total_minor FROM live_orders_minute GROUP BY store_id, currency',
    );
    const want = new Map<string, Row>();
    for (const o of placed) {
      const key = `${o.store_id}|${o.payload.currency}`;
      const r = want.get(key) ?? {
        store_id: o.store_id!,
        currency: o.payload.currency,
        orders: 0,
        total_minor: 0,
      };
      r.orders = Number(r.orders) + 1;
      r.total_minor = Number(r.total_minor) + o.payload.totals.total_minor;
      want.set(key, r);
    }
    expect(numeric(got)).toEqual(sortRows([...want.values()]));
  });

  it('no model column is named like personal data', async () => {
    const rows = await q(
      a,
      `SELECT table, name FROM system.columns WHERE database = '${dbA}'
       AND (table LIKE 'stg_%' OR table LIKE 'dim_%' OR table LIKE 'fct_%' OR table LIKE 'mart_%' OR table LIKE 'live_%')
       AND match(name, '(?i)(email|customer|phone|address|first_name|last_name|postcode)')`,
    );
    // the one allowed: the pseudonymous, erasure-aware customer key (#623), in the order staging view and fct_order
    // only, never returned by any operation; erasure.test.ts proves it goes NULL for an erased customer
    const allowed = new Set([
      'stg_order_placed_v1.customer_key',
      'stg_order_placed_v2.customer_key', // #696
      'stg_order_placed.customer_key', // v1 UNION ALL v2
      'fct_order.customer_key',
      // counts, not identifiers (#603 new vs returning)
      'mart_customers_daily.new_customers',
      'mart_customers_daily.returning_customers',
    ]);
    expect(rows.filter((r) => !allowed.has(`${r.table}.${r.name}`))).toEqual([]);
  });
});

describe.runIf(skip === null)('ClickHouse runner under concurrency', () => {
  const made: string[] = [];
  let admin: ChClient;
  const clients: ChClient[] = [];
  const open = (db: string): ChClient => {
    const c = createChClient(cfg, db);
    clients.push(c);
    return c;
  };
  const q = async (c: ChClient, query: string): Promise<Row[]> =>
    (await c.query({ query, format: 'JSONEachRow' })).json<Row>();

  beforeAll(() => {
    admin = createChClient(cfg, 'default');
  });

  afterAll(async () => {
    for (const db of made)
      await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => undefined);
    await Promise.allSettled([admin?.close(), ...clients.map((c) => c.close())]);
  });

  it('the 0002 backfill racing the MV (rows arriving during the migration) leaves one row per event after FINAL', async () => {
    const db = throwawayDatabase();
    made.push(db);
    const c = open(db);
    const files = readSqlFiles();
    await migrate(
      admin,
      c,
      db,
      files.filter((f) => f.name === '0001_raw_events.sql'),
    );
    const rows = rowsOf(allEvents, '2026-11-01T00:00:00.000Z');
    const sink = createRawEventsSink(c);
    const half = Math.floor(rows.length / 2);
    await sink.insert(rows.slice(0, half));
    // the rest arrives in small inserts WHILE the migration creates the MV and runs its backfill
    const trickle = (async () => {
      for (let i = half; i < rows.length; i += 25) await sink.insert(rows.slice(i, i + 25));
    })();
    await Promise.all([migrate(admin, open(db), db, files), trickle]);
    const [r] = await q(
      c,
      `SELECT count() n, uniqExact(event_id) u FROM orders_minute_events FINAL`,
    );
    expect(Number(r!.n)).toBe(placed.length);
    expect(Number(r!.u)).toBe(placed.length);
    const [t] = await q(c, 'SELECT sum(orders) n FROM live_orders_minute');
    expect(Number(t!.n)).toBe(placed.length);
  });

  // #685, deterministic: ONE slow insert that begins before the MV exists and commits only after the backfill would
  // have read raw_events. Before the drain this lost every order.placed row of that insert (86 of 150, every run);
  // the runner now waits for it before backfilling. No polling: the count is asserted once, right after migrate.
  it('an insert in flight across the 0002 migration (begun before the MV, committed after the backfill) loses no row', async () => {
    const db = throwawayDatabase();
    made.push(db);
    const c = open(db);
    const files = readSqlFiles();
    await migrate(
      admin,
      c,
      db,
      files.filter((f) => f.name === '0001_raw_events.sql'),
    );
    const rows = rowsOf(allEvents, '2026-11-01T00:00:00.000Z');
    const half = Math.floor(rows.length / 2);
    await createRawEventsSink(c).insert(rows.slice(0, half));
    // the second half staged in a throwaway table, then copied into raw_events as ONE block that takes ~3 s to
    // build (sleepEachRow), so it is still running when the MV is created and when the backfill would read
    await c.command({ query: 'CREATE TABLE stage AS raw_events' });
    await createRawEventsSink(c, 'stage').insert(rows.slice(half));
    const inFlight = rows.length - half;
    const slow = c.command({
      query: `INSERT INTO raw_events SELECT * FROM stage WHERE sleepEachRow(${(2.5 / inFlight).toFixed(4)}) = 0`,
      clickhouse_settings: { max_threads: 1 },
    });
    // migrate only once the slow insert is visibly running, so it truly began before the MV — and fail if it never
    // was (#687 review): otherwise this test could pass without the drain having anything to wait for
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      const [p] = await q(
        admin,
        `SELECT count() n FROM system.processes WHERE query_kind = 'Insert' AND current_database = '${db}'`,
      );
      seen = Number(p!.n) > 0;
      if (!seen) await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toBe(true);
    // The negative control (2026-11-02, ClickHouse 25.8): with the drain line in migrate() commented out
    // (`if (INSERT.test(statement)) await waitForRunningInserts(…)`), this test fails at 64 of 150 — 86 orders lost.
    await migrate(admin, open(db), db, files);
    await slow;
    const [r] = await q(
      c,
      `SELECT count() n, uniqExact(event_id) u FROM orders_minute_events FINAL`,
    );
    expect(Number(r!.n)).toBe(placed.length);
    expect(Number(r!.u)).toBe(placed.length);
    const [t] = await q(c, 'SELECT sum(orders) n FROM live_orders_minute');
    expect(Number(t!.n)).toBe(placed.length);
  });

  // #689: 0006 swaps the MV (new one first, then the old one dropped) while inserts run — no gap, no double count
  it('migration 0006 replaces the orders MV while inserts run: every order exactly once, the old MV gone (#689)', async () => {
    const db = throwawayDatabase();
    made.push(db);
    const c = open(db);
    const files = readSqlFiles();
    await migrate(
      admin,
      c,
      db,
      files.filter((f) => f.kind === 'migration' && f.name < '0006'),
    );
    const rows = rowsOf(allEvents, '2026-11-01T00:00:00.000Z');
    const third = Math.floor(rows.length / 3);
    await createRawEventsSink(c).insert(rows.slice(0, third));
    // one slow insert begun BEFORE 0006 (it keeps the old MV it began with) …
    await c.command({ query: 'CREATE TABLE stage AS raw_events' });
    await createRawEventsSink(c, 'stage').insert(rows.slice(third, 2 * third));
    const slow = c.command({
      query: `INSERT INTO raw_events SELECT * FROM stage WHERE sleepEachRow(${(2.5 / third).toFixed(4)}) = 0`,
      clickhouse_settings: { max_threads: 1 },
    });
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      const [p] = await q(
        admin,
        `SELECT count() n FROM system.processes WHERE query_kind = 'Insert' AND current_database = '${db}'`,
      );
      seen = Number(p!.n) > 0;
      if (!seen) await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toBe(true);
    // … and small inserts that keep arriving WHILE 0006 swaps the views
    const sink = createRawEventsSink(c);
    const trickle = (async () => {
      for (let i = 2 * third; i < rows.length; i += 25) await sink.insert(rows.slice(i, i + 25));
    })();
    // up to 0006 (0007 replaces this MV in turn; its own test is below)
    const r6 = await migrate(
      admin,
      open(db),
      db,
      files.filter((f) => f.kind !== 'migration' || f.name < '0007'),
    );
    await Promise.all([slow, trickle]);
    expect(r6.applied).toContain('0006_orders_minute_mv_v2.sql');
    const [r] = await q(
      c,
      'SELECT count() n, uniqExact(event_id) u FROM orders_minute_events FINAL',
    );
    expect(Number(r!.n)).toBe(placed.length);
    expect(Number(r!.u)).toBe(placed.length);
    const [t] = await q(c, 'SELECT sum(orders) n FROM live_orders_minute');
    expect(Number(t!.n)).toBe(placed.length);
    const views = (
      await q(
        admin,
        `SELECT name FROM system.tables WHERE database = '${db}' AND engine = 'MaterializedView' ORDER BY name`,
      )
    ).map((v) => v.name);
    expect(views).toEqual(['mv_orders_minute_v2']);
  });

  it('a store-less order.placed: under the zero uuid through 0002, deleted by 0006, and kept out after it (#689)', async () => {
    const db = throwawayDatabase();
    made.push(db);
    const c = open(db);
    const files = readSqlFiles();
    await migrate(
      admin,
      c,
      db,
      files.filter((f) => f.kind === 'migration' && f.name < '0006'),
    );
    const sink = createRawEventsSink(c);
    const [one] = rowsOf(
      [placed[0]! as unknown as EventEnvelopeV1Base],
      '2026-11-01T00:00:00.000Z',
    );
    const storeless = (eventId: string) => ({ ...one!, event_id: eventId, store_id: null });
    const zero = async () =>
      Number(
        (
          await q(
            c,
            "SELECT count() n FROM orders_minute_events FINAL WHERE store_id = toUUID('00000000-0000-0000-0000-000000000000')",
          )
        )[0]!.n,
      );
    await sink.insert([storeless('00000000-0000-4000-8000-0000000689a1')]);
    expect(await zero()).toBe(1); // 0002's no-op filter let it through
    await migrate(admin, c, db, files);
    expect(await zero()).toBe(0); // 0006 deleted it
    await sink.insert([storeless('00000000-0000-4000-8000-0000000689a2')]);
    expect(await zero()).toBe(0); // and the new MV keeps one out
  });

  // #696 gate: order.placed v2 (email_hash nullable) next to v1. classify makes a v2 row the v1 row with version 2
  // (rows.order-placed-v2.test.ts), so the v2 rows here are exactly that, with the replay's scrub on some of them.
  it('order.placed v1 AND v2 through 0007 and the models: every order once, a null email_hash unattributed (#696)', async () => {
    const db = throwawayDatabase();
    made.push(db);
    const c = open(db);
    const files = readSqlFiles();
    // 0007 runs over a live v1 tile, as on dev
    await migrate(
      admin,
      c,
      db,
      files.filter((f) => f.kind !== 'migration' || f.name < '0007'),
    );
    const rows = rowsOf(allEvents, '2026-11-01T00:00:00.000Z');
    const asV2 = new Set(
      rows.filter((r) => r.topic === 'order.placed').filter((_, i) => i % 3 === 0),
    );
    const v1Rows = rows.filter((r) => !asV2.has(r));
    // every third order arrives as v2: half of those named (hash kept), half scrubbed by the replay (both null)
    let erased = 0;
    const v2Rows = [...asV2].map((r, i) => {
      const payload = JSON.parse(r.payload) as Record<string, unknown>;
      if (i % 2 === 0) {
        erased += 1;
        payload.email_hash = null;
        payload.customer_id = null;
      }
      return { ...r, version: 2, payload: JSON.stringify(payload) };
    });
    expect(v2Rows.length).toBeGreaterThan(10);
    expect(erased).toBeGreaterThan(5);
    // 0007 LATE (#708 review): the first half of the v2 orders is ingested BEFORE it, where mv_orders_minute_v2 (v1
    // only) does not see them; 0007's refill must put them in the tile. The rest arrive after it, through v3.
    const early = v2Rows.slice(0, Math.floor(v2Rows.length / 2));
    await createRawEventsSink(c).insert([...v1Rows, ...early]);
    const tileOf = async () =>
      Number((await q(c, 'SELECT count() n FROM orders_minute_events FINAL'))[0]!.n);
    expect(await tileOf()).toBe(placed.length - v2Rows.length); // the early v2 orders are missing
    const r7 = await migrate(admin, open(db), db, files);
    expect(r7.applied).toEqual(['0007_orders_minute_mv_v3.sql']);
    expect(await tileOf()).toBe(placed.length - v2Rows.length + early.length); // repaired
    await createRawEventsSink(c).insert(v2Rows.slice(early.length));
    // the replay itself: a v1 order republished as v2, scrubbed, under the SAME event_id and a later ingested_at. It
    // folds with its v1 copy (raw_events is keyed (topic, event_id)): still one order, now unattributed. This test
    // builds its v2 rows itself (no @2 mock), so it stays when testing/order-placed-v2.ts goes (#708 review)
    const replayed = v1Rows.find((r) => r.topic === 'order.placed')!;
    const scrubbed = {
      ...(JSON.parse(replayed.payload) as Record<string, unknown>),
      email_hash: null,
      customer_id: null,
    };
    await createRawEventsSink(c).insert([
      {
        ...replayed,
        version: 2,
        payload: JSON.stringify(scrubbed),
        ingested_at: '2026-11-01 00:00:01.000',
      },
    ]);
    erased += 1;

    const one = async (query: string) => (await q(c, query))[0]!;
    // the live tile and the facts: every order exactly once, whatever its version
    const tile = await one(
      'SELECT count() n, uniqExact(event_id) u FROM orders_minute_events FINAL',
    );
    expect([Number(tile.n), Number(tile.u)]).toEqual([placed.length, placed.length]);
    const live = await one('SELECT sum(orders) n, sum(total_minor) t FROM live_orders_minute');
    const total = placed.reduce((sum, o) => sum + o.payload.totals.total_minor, 0);
    expect([Number(live.n), Number(live.t)]).toEqual([placed.length, total]);
    const fact = await one(
      'SELECT count() n, uniqExact(order_id) u, sum(total_minor) t, countIf(customer_key IS NULL) k FROM fct_order',
    );
    expect([Number(fact.n), Number(fact.u), Number(fact.t), Number(fact.k)]).toEqual([
      placed.length,
      placed.length,
      total,
      erased,
    ]);
    const lines = await one('SELECT count() n FROM fct_order_line');
    expect(Number(lines.n)).toBe(placed.reduce((n, o) => n + o.payload.line_items.length, 0));
    // the scrubbed orders belong to nobody: counted as unknown, never joined to a customer (no join on NULL)
    const named = new Set(
      v1Rows
        .filter((r) => r !== replayed)
        .concat(v2Rows)
        .filter((r) => r.topic === 'order.placed')
        .map((r) => [
          r.store_id,
          (JSON.parse(r.payload) as { email_hash: string | null }).email_hash,
        ])
        .filter(([, h]) => h !== null)
        .map(([s, h]) => `${s}:${h}`),
    );
    const mart = await one(
      'SELECT sum(unknown_orders) unknown, sum(new_customers) fresh FROM mart_customers_daily',
    );
    expect([Number(mart.unknown), Number(mart.fresh)]).toEqual([erased, named.size]);
    const views = (
      await q(
        admin,
        `SELECT name FROM system.tables WHERE database = '${db}' AND engine = 'MaterializedView' ORDER BY name`,
      )
    ).map((v) => v.name);
    expect(views).toEqual(['mv_orders_minute_v3']);
  });

  it('migration 0005 refills the order rows an earlier 0002 run lost, and only those (#685)', async () => {
    const db = throwawayDatabase();
    made.push(db);
    const c = open(db);
    const files = readSqlFiles();
    await migrate(
      admin,
      c,
      db,
      files.filter((f) => f.name === '0001_raw_events.sql'),
    );
    await createRawEventsSink(c).insert(rowsOf(allEvents, '2026-11-01T00:00:00.000Z'));
    await migrate(
      admin,
      c,
      db,
      files.filter((f) => f.kind === 'migration' && f.name < '0005'),
    );
    // a database migrated before the fix: some order rows never reached orders_minute_events
    const lost = placed.slice(0, 40).map((p) => p.event_id);
    await c.command({
      query: 'DELETE FROM orders_minute_events WHERE event_id IN {lost:Array(UUID)}',
      query_params: { lost },
    });
    const count = async () =>
      Number((await q(c, 'SELECT count() n FROM orders_minute_events FINAL'))[0]!.n);
    expect(await count()).toBe(placed.length - lost.length);
    const r = await migrate(admin, c, db, files);
    expect(r.applied).toContain('0005_orders_minute_refill.sql');
    expect(await count()).toBe(placed.length);
    const [u] = await q(
      c,
      "SELECT uniqExact(event_id) u, countIf(store_id = toUUID('00000000-0000-0000-0000-000000000000')) z FROM orders_minute_events FINAL",
    );
    expect(Number(u!.u)).toBe(placed.length);
    expect(Number(u!.z)).toBe(0); // no NULL store slipped through as the zero uuid
  });

  it('a second runner exits cleanly while the first holds the lock, and no file is applied twice', async () => {
    const db = throwawayDatabase();
    made.push(db);
    const files = readSqlFiles();
    const outcomes = await Promise.allSettled([
      migrate(admin, open(db), db, files),
      migrate(admin, open(db), db, files),
    ]);
    const done = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const o of refused)
      expect((o as PromiseRejectedResult).reason).toBeInstanceOf(MigrationLockedError);
    const c = open(db);
    // every file recorded exactly once (a second application would add a second row before FINAL folds it)
    const perFile = await q(c, 'SELECT name, count() n FROM _migrations GROUP BY name');
    expect(perFile.map((r) => r.name).sort()).toEqual(files.map((f) => f.name).sort());
    expect(perFile.every((r) => Number(r.n) === 1)).toBe(true);
    // the lock is released, so the next run is a clean no-op
    const again = await migrate(admin, c, db, files);
    expect(again.applied).toEqual([]);
    expect(again.reapplied).toEqual([]);
    const [l] = await q(c, 'SELECT count() n FROM _migrations_lock');
    expect(Number(l!.n)).toBe(0);
  });
});
