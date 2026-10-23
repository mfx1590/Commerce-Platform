// The SQL path on a seeded throwaway database (packages/db migrations incl. 0202/0203): one transaction per event with the
// processed mark, the chart seeded once per legal entity, a generated month balanced in SQL, the two idempotency
// guards, the failure path writing nothing, and RLS between stores.
import { createTenantClient, SEED_IDS } from '@platform/db';
import {
  createPgProcessedStore,
  type DecodedMessage,
  type EventEnvelopeV1Base,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLedgerEvent, LEDGER_GROUP, PROCESSED_TABLE } from '../src/consumer.js';
import { balanceByCurrency, trialBalance } from '../src/ledger.js';
import { orderIdOf, postEvent, type OrderProjection } from '../src/posting/index.js';
import {
  allItems,
  generateMonth,
  LE_A,
  LE_B,
  orderCancelled,
  orderPlaced,
  paymentCaptured,
  refundIssued,
  rng,
  shipmentShipped,
  STORE_A,
  STORE_B,
} from '../src/posting/fixtures.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

let t: AccountingTestDatabase;
const decoded = (e: EventEnvelopeV1Base): DecodedMessage => ({
  envelope: e,
  outboxId: e.event_id,
  schemaId: null,
  headers: {},
});

/** What the consumer does per message: post + mark in one transaction through the SDK's Postgres store. */
async function consume(e: EventEnvelopeV1Base) {
  const store = createPgProcessedStore(t.hq, PROCESSED_TABLE);
  if (await store.has(LEDGER_GROUP, e.event_id)) return { action: 'duplicate' as const };
  return handleLedgerEvent(t.hq, decoded(e), {
    markProcessed: (tx) => store.markProcessedWith!(tx, LEDGER_GROUP, e.event_id),
  });
}

const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (await t.hq.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!.n,
  );

beforeAll(async () => {
  t = await createAccountingTestDatabase();
  console.info(`ledger.test: database ${t.db.name}`);
}, 180_000);

afterAll(async () => {
  await t?.drop();
});

describe('one event, one transaction', () => {
  it('posts the worked example, seeds the chart for its legal entity and marks the event processed together', async () => {
    const e = orderPlaced({
      legalEntityId: LE_A,
      storeId: STORE_A,
      lines: [
        { quantity: 2, unit_price_minor: 4_999, tax_rate_bp: 2100 },
        { quantity: 1, unit_price_minor: 1_000, discount_minor: 200, tax_rate_bp: 2100 },
      ],
      shipping_minor: 495,
      shipping_tax_minor: 104,
    });
    const r = await consume(e);
    expect(r).toMatchObject({ action: 'posted', entries: 1, lines: 4, legal_entity_id: LE_A });
    const rows = await t.hq.query<{
      account_code: string;
      debit_minor: string;
      credit_minor: string;
      journal: string;
      entry_date: Date;
    }>(
      `SELECT account_code, debit_minor::text, credit_minor::text, journal, entry_date FROM ledger_entry WHERE source_event_id = $1 ORDER BY account_code`,
      [e.event_id],
    );
    expect(
      rows.rows.map((x) => [
        x.account_code,
        Number(x.debit_minor),
        Number(x.credit_minor),
        x.journal,
      ]),
    ).toEqual([
      ['1200', 13_665, 0, 'sales'],
      ['2200', 0, 2_372, 'sales'],
      ['2300', 0, 10_798, 'sales'],
      ['2310', 0, 495, 'sales'],
    ]);
    expect(await count('ledger_account WHERE legal_entity_id = $1', [LE_A])).toBe(12);
    expect(
      await count(`${PROCESSED_TABLE} WHERE group_id = $1 AND outbox_id = $2`, [
        LEDGER_GROUP,
        e.event_id,
      ]),
    ).toBe(1);
    expect(await count('accounting_order WHERE order_id = $1', [e.payload.order_id])).toBe(1);
    expect(await count('accounting_order_line WHERE order_id = $1', [e.payload.order_id])).toBe(2);

    // the processed mark makes the redelivery a no-op before any posting
    expect(await consume(e)).toEqual({ action: 'duplicate' });
    // and even without it, a redelivered order.placed posts nothing (same source event on the projection)
    expect(await handleLedgerEvent(t.hq, decoded(e))).toMatchObject({ action: 'noop', entries: 0 });
    expect(await count('ledger_entry WHERE source_event_id = $1', [e.event_id])).toBe(4);
  });

  it('the second guard: the same payment posted twice without the mark is refused by UNIQUE (source_event_id, account_code) and nothing changes', async () => {
    const e = orderPlaced({
      lines: [{ quantity: 1, unit_price_minor: 10_000, tax_rate_bp: 2100 }],
    });
    await consume(e);
    const pay = paymentCaptured(e, { fee_minor: 300 });
    expect(await handleLedgerEvent(t.hq, decoded(pay))).toMatchObject({
      action: 'posted',
      lines: 3,
    });
    const before = await count('ledger_entry');
    await expect(handleLedgerEvent(t.hq, decoded(pay))).rejects.toMatchObject({ code: '23505' });
    expect(await count('ledger_entry')).toBe(before);
    expect(await count('accounting_payment WHERE payment_id = $1', [pay.payload.payment_id])).toBe(
      1,
    );
  });

  it('a real failure writes nothing: a shipment of more than was ordered, no rows, no mark, chart untouched', async () => {
    const e = orderPlaced({
      legalEntityId: LE_B,
      storeId: STORE_B,
      currency: 'GBP',
      lines: [{ quantity: 1, unit_price_minor: 5_000, tax_rate_bp: 2000 }],
    });
    await consume(e);
    const lineId = e.payload.line_items[0]!.order_line_item_id;
    const tooMany = shipmentShipped(e, [{ order_line_item_id: lineId, quantity: 2 }]);
    const entries = await count('ledger_entry');
    await expect(consume(tooMany)).rejects.toMatchObject({ name: 'ShipmentExceedsOrder' });
    expect(await count('ledger_entry')).toBe(entries);
    expect(await count(`${PROCESSED_TABLE} WHERE outbox_id = $1`, [tooMany.event_id])).toBe(0);
    expect(await count('accounting_parked_event')).toBe(0);
  });

  it('shipment, return refund and cancel BEFORE their order are parked with their mark; the order applies them in occurred_at order and deletes them; balanced', async () => {
    const example = () =>
      orderPlaced({
        legalEntityId: LE_B,
        storeId: STORE_B,
        currency: 'GBP',
        lines: [{ quantity: 2, unit_price_minor: 5_000, tax_rate_bp: 2000 }], // net 10000, tax 2000
        shipping_minor: 1_000,
        shipping_tax_minor: 200, // total 13200
        placed_at: '2026-10-05T10:00:00.000Z',
      });
    const parkedRows = (orderId: string) =>
      count('accounting_parked_event WHERE order_id = $1', [orderId]);
    const entriesOf = (eventId: string) =>
      count('ledger_entry WHERE source_event_id = $1', [eventId]);
    const before = await t.hq.transaction((tx) => balanceByCurrency(tx, LE_B));

    // (a) shipment before order
    const a = example();
    const aShip = shipmentShipped(a, allItems(a), { cost_minor: 310 });
    expect(await consume(aShip)).toMatchObject({ action: 'parked', entries: 0 });
    expect(await parkedRows(a.payload.order_id)).toBe(1);
    expect(await entriesOf(aShip.event_id)).toBe(0);
    expect(await count(`${PROCESSED_TABLE} WHERE outbox_id = $1`, [aShip.event_id])).toBe(1);
    expect(await consume(aShip)).toEqual({ action: 'duplicate' }); // a redelivery of a parked event
    expect(await consume(a)).toMatchObject({ action: 'posted', entries: 3, applied_parked: 1 });
    expect(await parkedRows(a.payload.order_id)).toBe(0);
    expect(await entriesOf(a.event_id)).toBe(4);
    expect(await entriesOf(aShip.event_id)).toBe(6);
    const aRow = await t.hq.query<{ goods_released_minor: string; shipping_released: boolean }>(
      'SELECT goods_released_minor::text, shipping_released FROM accounting_order WHERE order_id = $1',
      [a.payload.order_id],
    );
    expect(aRow.rows[0]).toEqual({ goods_released_minor: '10000', shipping_released: true });

    // (b) a return refund before order (cancellation refunds never park: they need no projection)
    const b = example();
    const bPay = paymentCaptured(b, { fee_minor: 200 });
    const bRefund = refundIssued(b, bPay, { amount_minor: 6_600, reason: 'return' });
    expect(await consume(bPay)).toMatchObject({ action: 'posted' });
    expect(await consume(bRefund)).toMatchObject({ action: 'parked' });
    expect(await consume(b)).toMatchObject({ action: 'posted', entries: 2, applied_parked: 1 });
    expect(await entriesOf(bRefund.event_id)).toBe(3); // 4090 5600, 2200 1000, 1100 6600
    expect(await parkedRows(b.payload.order_id)).toBe(0);

    // (c) cancel before order
    const c = example();
    const cCancel = orderCancelled(c, { cancelled_at: '2026-10-06T09:00:00.000Z' });
    expect(await consume(cCancel)).toMatchObject({ action: 'parked' });
    expect(await consume(c)).toMatchObject({ action: 'posted', entries: 2, applied_parked: 1 });
    expect(await entriesOf(cCancel.event_id)).toBe(4);
    expect(
      (
        await t.hq.query<{ status: string }>(
          'SELECT status FROM accounting_order WHERE order_id = $1',
          [c.payload.order_id],
        )
      ).rows[0]!.status,
    ).toBe('cancelled');

    // (d) two parked events applied by occurred_at, not by arrival: the cancel (10-08) arrived first, the partial
    //     shipment (10-07) second; the shipment must post before the cancel reverses the rest
    const d = example();
    const dLine = d.payload.line_items[0]!.order_line_item_id;
    const dCancel = orderCancelled(d, { cancelled_at: '2026-10-08T09:00:00.000Z' });
    const dShip = shipmentShipped(d, [{ order_line_item_id: dLine, quantity: 1 }], {
      cost_minor: 0,
      shipped_at: '2026-10-07T08:00:00.000Z',
    });
    expect(await consume(dCancel)).toMatchObject({ action: 'parked' });
    expect(await consume(dShip)).toMatchObject({ action: 'parked' });
    expect(await parkedRows(d.payload.order_id)).toBe(2);
    expect(await consume(d)).toMatchObject({ action: 'posted', entries: 3, applied_parked: 2 });
    expect(await entriesOf(dShip.event_id)).toBe(4); // release 5000 + shipping 1000
    const dCancelRows = await t.hq.query<{ account_code: string; debit_minor: string }>(
      'SELECT account_code, debit_minor::text FROM ledger_entry WHERE source_event_id = $1 AND debit_minor > 0 ORDER BY account_code',
      [dCancel.event_id],
    );
    expect(dCancelRows.rows).toEqual([
      { account_code: '2200', debit_minor: '1000' },
      { account_code: '2300', debit_minor: '5000' },
    ]);
    expect(await count('accounting_parked_event')).toBe(0);

    const after = await t.hq.transaction((tx) => balanceByCurrency(tx, LE_B));
    expect(after).toEqual({ ...before, GBP: 0 });
  });

  it('an event of another organization is refused before any write', async () => {
    const e = orderPlaced({ lines: [{ quantity: 1, unit_price_minor: 100, tax_rate_bp: 0 }] });
    const foreign = { ...e, organization_id: '00000000-0000-4000-8000-0000000000ff' };
    await expect(handleLedgerEvent(t.hq, decoded(foreign))).rejects.toMatchObject({
      name: 'ForeignOrganization',
    });
  });

  it('an invalid payload (schema) is refused with the InvalidEvent class', async () => {
    const e = orderPlaced({ lines: [{ quantity: 1, unit_price_minor: 100, tax_rate_bp: 0 }] });
    const broken = {
      ...e,
      payload: { ...e.payload, totals: { ...e.payload.totals, total_minor: 1.5 } },
    };
    await expect(
      handleLedgerEvent(t.hq, decoded(broken as EventEnvelopeV1Base)),
    ).rejects.toMatchObject({ name: 'InvalidEvent' });
  });
});

describe('a generated month through SQL', () => {
  it('balances per legal entity per currency; the chart is seeded once; projections are consistent', async () => {
    const month = generateMonth({ orders: 120, seed: 1234 });
    const t0 = Date.now();
    let posted = 0;
    let lines = 0;
    for (const e of month.events) {
      const r = await consume(e);
      if (r.action === 'posted') {
        posted += 1;
        lines += r.lines;
      }
    }
    const ms = Date.now() - t0;
    for (const le of [LE_A, LE_B]) {
      const byCurrency = await t.hq.transaction((tx) => balanceByCurrency(tx, le));
      expect(Object.keys(byCurrency).length).toBeGreaterThan(0);
      for (const [currency, diff] of Object.entries(byCurrency))
        expect(diff, `${le} ${currency}`).toBe(0);
      const tb = await t.hq.transaction((tx) => trialBalance(tx, le));
      expect(tb.reduce((a, r) => a + r.balance_minor, 0)).toBe(0);
      expect(await count('ledger_account WHERE legal_entity_id = $1', [LE_A])).toBe(12);
    }
    // every line of a projection sums to the order's released amount
    const bad = await t.hq.query<{ order_id: string }>(
      `SELECT o.order_id FROM accounting_order o
         LEFT JOIN accounting_order_line l ON l.order_id = o.order_id
        GROUP BY o.order_id, o.goods_released_minor
       HAVING coalesce(sum(l.released_minor), 0) <> o.goods_released_minor`,
    );
    expect(bad.rows).toEqual([]);
    expect(
      await count(`${PROCESSED_TABLE} WHERE group_id = $1`, [LEDGER_GROUP]),
    ).toBeGreaterThanOrEqual(month.events.length);
    console.info(
      JSON.stringify({ test: 'ledger-sql-month', events: month.events.length, posted, lines, ms }),
    );
    expect(month.events.length).toBeGreaterThan(300);

    // a second pass of the whole month is a no-op (the processed store)
    const entries = await count('ledger_entry');
    for (const e of month.events) expect(await consume(e)).toEqual({ action: 'duplicate' });
    expect(await count('ledger_entry')).toBe(entries);
  }, 300_000);

  it('the same month delivered in SHUFFLED topic order (every order.placed last) parks and applies to the identical ledger', async () => {
    const month = generateMonth({ orders: 90, seed: 777 });
    // what the in-order posting yields, per (account, currency), for exactly these events
    const expected = new Map<string, number>();
    const projections = new Map<string, OrderProjection>();
    for (const e of month.events) {
      const r = postEvent(e, projections.get(orderIdOf(e)) ?? null);
      if (r.order) projections.set(r.order.order_id, r.order);
      for (const en of r.entries)
        for (const l of en.lines) {
          const k = `${en.legal_entity_id}|${l.currency}|${l.account_code}`;
          expected.set(k, (expected.get(k) ?? 0) + l.debit_minor - l.credit_minor);
        }
    }
    // deliver by topic, the orders last, each topic's events in a scrambled order
    const rank: Record<string, number> = {
      'shipment.shipped': 0,
      'refund.issued': 1,
      'order.cancelled': 2,
      'payment.captured': 3,
      'order.placed': 4,
    };
    const random = rng(99);
    const shuffled = month.events
      .map((e) => ({ e, r: rank[e.topic]!, x: random() }))
      .sort((a, b) => a.r - b.r || a.x - b.x)
      .map((s) => s.e);
    let parked = 0;
    let applied = 0;
    for (const e of shuffled) {
      const r = await consume(e);
      if (r.action === 'parked') parked += 1;
      if (r.action === 'posted' || r.action === 'noop') applied += r.applied_parked;
    }
    expect(parked).toBeGreaterThan(100);
    expect(applied).toBe(parked);
    const ids = month.events.map((e) => e.event_id);
    expect(await count('accounting_parked_event WHERE outbox_id = ANY($1::uuid[])', [ids])).toBe(0);
    const actual = await t.hq.query<{ k: string; diff: string }>(
      `SELECT legal_entity_id || '|' || currency || '|' || account_code AS k,
              (sum(debit_minor) - sum(credit_minor))::text AS diff
         FROM ledger_entry WHERE source_event_id = ANY($1::uuid[])
        GROUP BY legal_entity_id, currency, account_code`,
      [ids],
    );
    const got = new Map(
      actual.rows.map((r) => [r.k, Number(r.diff)] as [string, number]).filter(([, v]) => v !== 0),
    );
    expect(Object.fromEntries([...got].sort())).toEqual(
      Object.fromEntries([...expected].filter(([, v]) => v !== 0).sort()),
    );
    for (const le of [LE_A, LE_B]) {
      const byCurrency = await t.hq.transaction((tx) => balanceByCurrency(tx, le));
      for (const [currency, diff] of Object.entries(byCurrency))
        expect(diff, `${le} ${currency}`).toBe(0);
    }
    console.info(
      JSON.stringify({ test: 'ledger-sql-shuffled', events: shuffled.length, parked, applied }),
    );
  }, 300_000);
});

describe('row-level security (0203 rev 3: every accounting table is organization_only)', () => {
  const tables = [
    'ledger_entry',
    'ledger_account',
    'accounting_order',
    'accounting_order_line',
    'accounting_payment',
    'accounting_refund',
    'accounting_parked_event',
    'psp_payout',
    'psp_payout_line',
    PROCESSED_TABLE,
  ];
  const countAs = async (client: ReturnType<typeof createTenantClient>, table: string) =>
    Number(
      (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n,
    );

  it('a store session (even of the store whose facts they are) reads none of it; HQ reads it all', async () => {
    const storeA = createTenantClient(t.db.app, {
      organizationId: SEED_IDS.organization,
      storeIds: [STORE_A, STORE_B],
    });
    for (const table of tables) expect(await countAs(storeA, table), table).toBe(0);
    for (const table of [
      'ledger_entry',
      'ledger_account',
      'accounting_order',
      'accounting_payment',
      PROCESSED_TABLE,
    ])
      expect(await count(table), table).toBeGreaterThan(0);
    // a store session cannot write either
    await expect(
      storeA.query(
        `INSERT INTO ledger_account (organization_id, legal_entity_id, code, name, type) VALUES ($1, $2, '9999', 'x', 'asset')`,
        [SEED_IDS.organization, LE_A],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('another organization sees nothing', async () => {
    const other = createTenantClient(t.db.app, {
      organizationId: '00000000-0000-4000-8000-0000000000ff',
      storeIds: [STORE_A],
    });
    for (const table of tables) expect(await countAs(other, table), table).toBe(0);
  });
});

describe('immutability by grants (0203 rev 3)', () => {
  const denied = async (sql: string) =>
    expect(t.hq.query(sql)).rejects.toMatchObject({ code: '42501' });

  it('ledger_entry: no DELETE, no UPDATE of amounts; the ERP columns are updatable and the trigger still stamps updated_at', async () => {
    await denied('DELETE FROM ledger_entry');
    await denied('UPDATE ledger_entry SET debit_minor = debit_minor + 1');
    await denied("UPDATE ledger_entry SET account_code = '9999'");
    await denied('UPDATE ledger_entry SET store_id = NULL');
    const row = await t.hq.query<{ id: string; updated_at: Date }>(
      'SELECT id, updated_at FROM ledger_entry ORDER BY created_at LIMIT 1',
    );
    const id = row.rows[0]!.id;
    await new Promise((r) => setTimeout(r, 20));
    await t.hq.query(
      "UPDATE ledger_entry SET posted_to_erp_at = now(), erp_reference = 'odoo-move-fixture' WHERE id = $1",
      [id],
    );
    const after = await t.hq.query<{ erp_reference: string; updated_at: Date; posted: Date }>(
      'SELECT erp_reference, updated_at, posted_to_erp_at AS posted FROM ledger_entry WHERE id = $1',
      [id],
    );
    expect(after.rows[0]!.erp_reference).toBe('odoo-move-fixture');
    expect(after.rows[0]!.posted).not.toBeNull();
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(row.rows[0]!.updated_at.getTime());
  });

  it('ledger_account, accounting_payment, accounting_refund, psp_payout_line: no DELETE; ledger_account stays updatable', async () => {
    await denied('DELETE FROM ledger_account');
    await denied('DELETE FROM accounting_payment');
    await denied('DELETE FROM accounting_refund');
    await denied('DELETE FROM psp_payout_line');
    const r = await t.hq.query(
      "UPDATE ledger_account SET name = name WHERE legal_entity_id = $1 AND code = '1000'",
      [LE_A],
    );
    expect(r.rowCount).toBe(1);
  });

  it('a payout-style line with store_id NULL is accepted (legal-entity level) and balances', async () => {
    const r = await t.hq.query<{ n: string }>(
      `INSERT INTO ledger_entry (organization_id, legal_entity_id, store_id, journal, entry_date, account_code,
         debit_minor, credit_minor, currency, source_event_id, source_topic, reference_type, reference_id)
       SELECT $1, $2, NULL, 'bank', '2026-10-08', a, d, c, 'EUR', $3, 'psp.payout', 'payout', $3
         FROM unnest(ARRAY['1000', '1100'], ARRAY[500, 0]::bigint[], ARRAY[0, 500]::bigint[]) AS x(a, d, c)
       RETURNING 1 AS n`,
      [SEED_IDS.organization, LE_A, '00000000-0000-4000-8000-00000000c0de'],
    );
    expect(r.rowCount).toBe(2);
    const sums = await t.hq.query<{ d: string; c: string }>(
      "SELECT sum(debit_minor)::text AS d, sum(credit_minor)::text AS c FROM ledger_entry WHERE source_topic = 'psp.payout' AND store_id IS NULL",
    );
    expect(sums.rows[0]).toEqual({ d: '500', c: '500' });
    expect(await count('ledger_entry WHERE store_id IS NULL')).toBe(2);
  });

  it('parked events keep DELETE (the order applies and removes them)', async () => {
    const r = await t.hq.query(
      "DELETE FROM accounting_parked_event WHERE order_id = '00000000-0000-4000-8000-0000000000de'",
    );
    expect(r.rowCount).toBe(0);
  });
});
