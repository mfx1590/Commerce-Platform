// The richer generated month's month-end PSP payouts (#633) through the ledger and the payout reconciliation, on a
// seeded throwaway database: the Integration 5 gate's month (seed 6020, three legal entities, richPayments) consumed
// by the ledger, then each legal entity's payout (generateMonth().payouts, in this package's fixture-file shape)
// reconciles to the cent and posts Dr 1000 / Cr 1100 (psp.payout). So identity 3c (listPayouts = the ledger's 1000
// debits from psp.payout) has a key per legal entity and 0 difference. Split captures and retried payments are
// matched like any capture; failed payments never reach the ledger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLedgerEvent } from '../src/consumer.js';
import { LEDGER_TOPICS } from '../src/posting/index.js';
import { listPayouts } from '../src/api/queries.js';
import { generateMonth } from '../src/posting/fixtures.js';
import { reconcileAll } from '../src/reconcile/reconcile.js';
import { createFixtureSource, assertFixtureFile } from '../src/reconcile/source-fixture.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function postgresDown(): Promise<string | null> {
  try {
    const t = await createAccountingTestDatabase();
    await t.drop();
    return null;
  } catch (err) {
    return (err as Error).message.split('\n')[0] ?? 'unreachable';
  }
}
const down = await postgresDown();
if (down) console.warn(`month-payouts.test: Postgres ${down} — skipped`);

describe.runIf(down === null)(
  'the richer month: month-end payouts reconcile and post (#633)',
  () => {
    const month = generateMonth({
      orders: 150,
      seed: 6020,
      deterministicIds: true,
      legalEntities: 3,
      ordersPerDay: 5,
      richPayments: true,
    });
    let t: AccountingTestDatabase;

    beforeAll(async () => {
      t = await createAccountingTestDatabase();
      for (const e of month.events)
        if ((LEDGER_TOPICS as readonly string[]).includes(e.topic))
          await handleLedgerEvent(t.hq, {
            envelope: e,
            outboxId: e.event_id,
            schemaId: null,
            headers: {},
          });
    }, 180_000);
    afterAll(async () => {
      await t?.drop();
    });

    it('the payouts are valid fixture files, one per legal entity', () => {
      expect(month.payouts).toHaveLength(3);
      for (const f of month.payouts) expect(() => assertFixtureFile(f)).not.toThrow();
    });

    it('every payout reconciles with 0 differences and posts the bank entry; listPayouts = the 1000 debits', async () => {
      const deps = { client: t.hq, source: createFixtureSource(month.payouts), log: quiet };
      for (const f of month.payouts) {
        const results = await reconcileAll(deps, f.legal_entity_id);
        expect(results.map((r) => [r.status, r.discrepancies, r.posted])).toEqual([
          ['reconciled', [], true],
        ]);
        expect(results[0]!.matched).toBe(f.payouts[0]!.balance_transactions.length);
        const listed = await listPayouts(t.hq, f.legal_entity_id, {
          from: '2026-10-01',
          to: '2026-10-31',
          page: 1,
          limit: 100,
        });
        const bank = await t.hq.query<{ debit: string }>(
          `SELECT coalesce(sum(debit_minor), 0)::text AS debit FROM ledger_entry
          WHERE legal_entity_id = $1 AND account_code = '1000' AND source_topic = 'psp.payout'
            AND entry_date >= '2026-10-01' AND entry_date < '2026-11-01'`,
          [f.legal_entity_id],
        );
        expect(listed.items.map((p) => p.amount_minor)).toEqual([f.payouts[0]!.amount_minor]);
        expect(Number(bank.rows[0]!.debit)).toBe(f.payouts[0]!.amount_minor);
      }
    });
  },
);
