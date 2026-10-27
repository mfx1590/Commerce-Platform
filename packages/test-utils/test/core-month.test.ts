// writeMonthToCoreDb proven before the #602 gate trusts it: the generated month (150 orders, three legal entities)
// projected into a seeded throwaway database, then the reporting views (packages/db 0200, the SQL behind the core's
// report functions) return exactly the counts and minor-unit sums the EVENTS carry: sales (non-cancelled orders,
// their cohort refunds), captured payments with known and unknown fees, refunds by reason. Read through an
// organization-scoped client (RLS on), as the core reads them. Skips with a printed reason when Postgres is down.
import { createOrganizationClient, seed, SEED_IDS, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import type { EventEnvelopeV1Base } from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertThrowawayCoreDatabase,
  generateMonth,
  NotAThrowawayDatabaseError,
  writeMonthToCoreDb,
} from '../src/index.js';

type P = Record<string, unknown>;
const pl = (e: EventEnvelopeV1Base) => e.payload as unknown as P;

async function postgresDown(): Promise<string | null> {
  try {
    const db = await createTestDatabase('test_utils_probe');
    await db.drop();
    return null;
  } catch (err) {
    return (err as Error).message.split('\n')[0] ?? 'unreachable';
  }
}
const down = await postgresDown();
if (down) console.warn(`core-month.test: Postgres ${down} — skipped (pnpm compose:up)`);

describe('assertThrowawayCoreDatabase', () => {
  const named = (name: string) => ({ query: async () => ({ rows: [{ name }] as never[] }) });
  it('refuses the shared dev database and anything that is not a createTestDatabase name', async () => {
    for (const name of ['platform', 'postgres', 'analytics', 'platform_prod_abcdefgh', 'mytest'])
      await expect(assertThrowawayCoreDatabase(named(name))).rejects.toBeInstanceOf(
        NotAThrowawayDatabaseError,
      );
    await expect(assertThrowawayCoreDatabase(named('platform_test_k3j9x0aa'))).resolves.toBe(
      'platform_test_k3j9x0aa',
    );
  });
});

describe.runIf(down === null)(
  'writeMonthToCoreDb: the projected month = the events, through the reporting views',
  () => {
    const month = generateMonth({
      orders: 150,
      legalEntities: 3,
      deterministicIds: true,
      seed: 602,
    });
    const ev = (topic: string) => month.events.filter((e) => e.topic === topic);
    let db: TestDatabase;
    let hq: ScopedClient;
    const one = async (sql: string): Promise<Record<string, string>> =>
      (await hq.query<Record<string, string>>(sql)).rows[0]!;

    beforeAll(async () => {
      db = await createTestDatabase('test_utils_month');
      await seed(db.owner);
      hq = createOrganizationClient(db.app, { organizationId: SEED_IDS.organization });
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('projects every order, payment and refund, and refuses nothing it should keep', async () => {
      const counts = await writeMonthToCoreDb(db.owner, month.events);
      expect(counts).toMatchObject({
        orders: month.orders,
        cancelled: month.cancellations,
        payments: month.captures,
        refunds: month.refunds,
      });
    });

    it('rpt_sales_daily: non-cancelled orders, their totals and their cohort refunds', async () => {
      const cancelled = new Set(ev('order.cancelled').map((e) => String(pl(e).order_id)));
      const kept = ev('order.placed').filter((e) => !cancelled.has(String(pl(e).order_id)));
      const keptIds = new Set(kept.map((e) => String(pl(e).order_id)));
      const total = kept.reduce((n, e) => n + Number((pl(e).totals as P).total_minor), 0);
      const refunded = ev('refund.issued')
        .filter((e) => keptIds.has(String(pl(e).order_id)))
        .reduce((n, e) => n + Number(pl(e).amount_minor), 0);
      const r = await one(
        'SELECT sum(orders) AS orders, sum(total_minor) AS total, sum(refunded_minor) AS refunded, sum(net_minor) AS net, count(DISTINCT currency) AS currencies FROM rpt_sales_daily',
      );
      expect(Number(r.orders)).toBe(kept.length);
      expect(Number(r.total)).toBe(total);
      expect(Number(r.refunded)).toBe(refunded);
      expect(Number(r.net)).toBe(total - refunded);
      expect(Number(r.currencies)).toBe(3);
    });

    it('rpt_payments_daily: every capture, its amount, the known fees and the unknown ones', async () => {
      const caps = ev('payment.captured');
      const r = await one(
        'SELECT sum(captured_count) AS n, sum(captured_minor) AS amount, sum(fee_minor) AS fee, sum(fee_unknown) AS unknown FROM rpt_payments_daily',
      );
      expect(Number(r.n)).toBe(caps.length);
      expect(Number(r.amount)).toBe(caps.reduce((n, e) => n + Number(pl(e).amount_minor), 0));
      expect(Number(r.fee)).toBe(caps.reduce((n, e) => n + Number(pl(e).fee_minor ?? 0), 0));
      expect(Number(r.unknown)).toBe(caps.filter((e) => pl(e).fee_minor === null).length);
    });

    it('rpt_refunds_daily: every refund by reason and amount, on its issue day', async () => {
      const rows = (
        await hq.query<{ reason: string; refunds: string; refunded_minor: string }>(
          'SELECT reason, sum(refunds) AS refunds, sum(refunded_minor) AS refunded_minor FROM rpt_refunds_daily GROUP BY reason ORDER BY reason',
        )
      ).rows;
      const want = new Map<string, { n: number; amount: number }>();
      for (const e of ev('refund.issued')) {
        const w = want.get(String(pl(e).reason)) ?? { n: 0, amount: 0 };
        w.n += 1;
        w.amount += Number(pl(e).amount_minor);
        want.set(String(pl(e).reason), w);
      }
      expect(rows.map((r) => [r.reason, Number(r.refunds), Number(r.refunded_minor)])).toEqual(
        [...want].sort(([a], [b]) => a.localeCompare(b)).map(([k, w]) => [k, w.n, w.amount]),
      );
      // the issue day is the event's: refund.created_at = issued_at
      const days = (
        await hq.query<{ day: string; n: string }>(
          `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, count(*) AS n FROM refund GROUP BY 1 ORDER BY 1`,
        )
      ).rows.map((r) => [r.day, Number(r.n)]);
      const wantDays = new Map<string, number>();
      for (const e of ev('refund.issued')) {
        const d = String(pl(e).issued_at).slice(0, 10);
        wantDays.set(d, (wantDays.get(d) ?? 0) + 1);
      }
      expect(days).toEqual([...wantDays].sort(([a], [b]) => a.localeCompare(b)));
    });

    it('keeps the event ids, so every projected row is traceable to its event', async () => {
      const ids = ev('order.placed').map((e) => String(pl(e).order_id));
      const r = (
        await hq.query<{ n: string }>(
          'SELECT count(*) AS n FROM "order" WHERE id = ANY($1::uuid[])',
          [ids],
        )
      ).rows[0]!;
      expect(Number(r.n)).toBe(month.orders);
    });
  },
);
