// #888: the ledger is idempotent by source event across consumer GROUPS. A group that re-reads topics another group
// already posted (offsets expired, a new group on an existing ledger, a rebuild) must recognise every event as a
// duplicate — no posting, no retry, no dead letter — and mark it processed for itself. Found on the dev stack: three
// shipments the Integration 4 group had posted dead-lettered with ShipmentExceedsOrder when the default group re-read
// shipment.shipped from offset 0. A generated EUR + GBP month plus Brand D orders in JPY (whole yen), three ways:
//   (1) group A in fact order, then group B re-reads everything with the orders LAST;
//   (2) A with the orders last, then B in fact order;
//   (3) A and B interleaved at random, each seeing every event once in its own order (they split the work);
// every way ends with the per-account totals of a single-group reference ledger, zero throws, nothing parked and
// every event processed for BOTH groups.
import type { EventEnvelopeV1Base } from '@platform/events';
import { createPgProcessedStore, type DecodedMessage } from '@platform/events';
import { SEED_IDS } from '@platform/db';
import { afterAll, describe, expect, it } from 'vitest';
import { handleLedgerEvent, PROCESSED_TABLE } from '../src/consumer.js';
import { balanceByCurrency } from '../src/ledger.js';
import {
  generateMonth,
  LE_A,
  LE_B,
  orderCancelled,
  orderPlaced,
  paymentCaptured,
  refundIssued,
  rng,
  shipmentShipped,
} from '../src/posting/fixtures.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const LE_D = SEED_IDS.legalEntities.brandD;
const STORE_D = SEED_IDS.stores.brandD;
const GROUP_A = 'accounting.ledger';
const GROUP_B = 'accounting.ledger.rebuild';
const dbs: AccountingTestDatabase[] = [];

/** Brand D K.K. in JPY: whole yen, 10 % tax. A fully shipped and paid order with a return, a partially shipped order
 * then cancelled, a paid order cancelled before shipping with its cancellation refund. */
function yenOrders(): EventEnvelopeV1Base[] {
  const at = (d: number, h = 10) =>
    `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const jp = (lines: { q: number; p: number }[], day: number) =>
    orderPlaced({
      legalEntityId: LE_D,
      storeId: STORE_D,
      currency: 'JPY',
      lines: lines.map((l) => ({ quantity: l.q, unit_price_minor: l.p, tax_rate_bp: 1000 })),
      shipping_minor: 990,
      shipping_tax_minor: 99,
      placed_at: at(day),
    });
  const out: EventEnvelopeV1Base[] = [];
  const a = jp([{ q: 2, p: 1980 }], 3);
  const aPay = paymentCaptured(a, { fee_minor: 150, captured_at: at(3, 11) });
  const aLine = a.payload.line_items[0]!.order_line_item_id;
  out.push(
    a,
    aPay,
    shipmentShipped(a, [{ order_line_item_id: aLine, quantity: 2 }], {
      cost_minor: 0,
      shipped_at: at(4),
    }),
    refundIssued(a, aPay, { amount_minor: 2178, reason: 'return', issued_at: at(9) }),
  );
  const b = jp([{ q: 3, p: 1500 }], 5);
  const bLine = b.payload.line_items[0]!.order_line_item_id;
  out.push(
    b,
    shipmentShipped(b, [{ order_line_item_id: bLine, quantity: 1 }], {
      cost_minor: 0,
      shipped_at: at(6),
    }),
    orderCancelled(b, { cancelled_at: at(7) }),
  );
  const c = jp([{ q: 1, p: 3300 }], 8);
  const cPay = paymentCaptured(c, { fee_minor: 200, captured_at: at(8, 11) });
  out.push(
    c,
    cPay,
    orderCancelled(c, { cancelled_at: at(8, 15) }),
    refundIssued(c, cPay, {
      amount_minor: c.payload.totals.total_minor,
      reason: 'cancellation',
      issued_at: at(8, 16),
    }),
  );
  return out;
}

const month = generateMonth({
  orders: 60,
  seed: 888,
  legalEntities: 2,
  ordersPerDay: 3,
  deterministicIds: true,
});
const EVENTS: EventEnvelopeV1Base[] = [...month.events, ...yenOrders()].sort(
  (x, y) =>
    Date.parse(x.occurred_at) - Date.parse(y.occurred_at) || x.event_id.localeCompare(y.event_id),
);
const TOPICS_LAST = [
  'shipment.shipped',
  'refund.issued',
  'order.cancelled',
  'payment.captured',
  'order.placed',
];
/** the orders LAST: every shipment, refund and cancel arrives before its order and parks */
const ordersLast = (es: EventEnvelopeV1Base[]) =>
  TOPICS_LAST.flatMap((topic) => es.filter((e) => e.topic === topic));

const decoded = (e: EventEnvelopeV1Base): DecodedMessage => ({
  envelope: e,
  outboxId: e.event_id,
  schemaId: null,
  headers: {},
});
/** what one consumer group does per message: the SDK's own duplicate check, then post + mark in one transaction */
async function consumeAs(db: AccountingTestDatabase, group: string, e: EventEnvelopeV1Base) {
  const store = createPgProcessedStore(db.hq, PROCESSED_TABLE);
  if (await store.has(group, e.event_id)) return 'sdk-duplicate';
  const r = await handleLedgerEvent(db.hq, decoded(e), {
    markProcessed: (tx) => store.markProcessedWith!(tx, group, e.event_id),
  });
  return r.action;
}
async function fresh(): Promise<AccountingTestDatabase> {
  const db = await createAccountingTestDatabase();
  dbs.push(db);
  return db;
}
const totals = async (db: AccountingTestDatabase) =>
  Object.fromEntries(
    (
      await db.hq.query<{ k: string; diff: string }>(
        `SELECT legal_entity_id || '|' || currency || '|' || account_code AS k, (sum(debit_minor) - sum(credit_minor))::text AS diff
           FROM ledger_entry GROUP BY 1 ORDER BY 1`,
      )
    ).rows.map((r) => [r.k, Number(r.diff)]),
  );
const count = async (db: AccountingTestDatabase, sql: string, p: unknown[] = []) =>
  Number(
    (await db.hq.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, p)).rows[0]!.n,
  );
const tally = (actions: string[]) =>
  actions.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

afterAll(async () => {
  for (const db of dbs) await db.drop();
});

describe('idempotent by source event across consumer groups (#888)', () => {
  let reference: Record<string, number>;

  it('the reference: one group, fact order — every book balanced, JPY in whole yen', async () => {
    const db = await fresh();
    for (const e of EVENTS) await consumeAs(db, GROUP_A, e);
    reference = await totals(db);
    for (const le of [LE_A, LE_B, LE_D]) {
      const b = await db.hq.transaction((tx) => balanceByCurrency(tx, le));
      for (const v of Object.values(b)) expect(v).toBe(0);
    }
    expect(Object.keys(reference).some((k) => k.startsWith(`${LE_D}|JPY|`))).toBe(true);
    // whole yen: Brand D's receivable after the month is a sum of yen amounts, never a ×100 figure
    expect(Math.abs(reference[`${LE_D}|JPY|1200`] ?? 0)).toBeLessThan(100_000);
    expect(await count(db, 'accounting_parked_event')).toBe(0);
  }, 300_000);

  for (const [name, orderA, orderB] of [
    [
      '(1) A in fact order, then B re-reads everything with the orders last',
      (e: EventEnvelopeV1Base[]) => e,
      ordersLast,
    ],
    [
      '(2) A with the orders last, then B re-reads everything in fact order',
      ordersLast,
      (e: EventEnvelopeV1Base[]) => e,
    ],
  ] as const)
    it(`${name}: B recognises every event as a duplicate — nothing posted, nothing thrown, all marked for B`, async () => {
      const db = await fresh();
      for (const e of orderA(EVENTS)) await consumeAs(db, GROUP_A, e);
      const rows = await count(db, 'ledger_entry');
      const actions: string[] = [];
      for (const e of orderB(EVENTS)) actions.push(await consumeAs(db, GROUP_B, e)); // a throw fails the test
      // B posts and parks NOTHING: every event is a duplicate, or a noop when it posted nothing under A either (the
      // cancel of a fully shipped order) — and none throws
      const t = tally(actions);
      expect(Object.keys(t).every((k) => k === 'duplicate' || k === 'noop')).toBe(true);
      expect(t.duplicate).toBeGreaterThan(EVENTS.length * 0.9);
      expect(await count(db, 'ledger_entry')).toBe(rows);
      expect(await totals(db)).toEqual(reference);
      expect(await count(db, `${PROCESSED_TABLE} WHERE group_id = $1`, [GROUP_B])).toBe(
        EVENTS.length,
      );
      expect(await count(db, 'accounting_parked_event')).toBe(0);
    }, 300_000);

  it('(3) A and B interleaved at random, each in its own order: they split the work — the reference ledger, zero throws', async () => {
    const db = await fresh();
    const qa = [...EVENTS];
    const qb = ordersLast(EVENTS);
    const r = rng(888);
    const actions: string[] = [];
    while (qa.length || qb.length) {
      const takeA = qb.length === 0 || (qa.length > 0 && r() < 0.5);
      const [group, q] = takeA ? [GROUP_A, qa] : [GROUP_B, qb];
      actions.push(await consumeAs(db, group, q.shift()!));
    }
    const t = tally(actions);
    expect(t.posted ?? 0).toBeGreaterThan(0);
    expect(t.duplicate ?? 0).toBeGreaterThan(0);
    expect(Object.keys(t).every((k) => ['posted', 'parked', 'noop', 'duplicate'].includes(k))).toBe(
      true,
    );
    expect(await totals(db)).toEqual(reference);
    expect(await count(db, 'accounting_parked_event')).toBe(0);
    for (const g of [GROUP_A, GROUP_B])
      expect(await count(db, `${PROCESSED_TABLE} WHERE group_id = $1`, [g])).toBe(EVENTS.length);
  }, 300_000);
});
