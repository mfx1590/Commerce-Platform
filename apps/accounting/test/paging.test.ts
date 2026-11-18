// #854: every list of the Finance read API pages over a TOTAL order — a page boundary can never skip or repeat a row.
// The journal lines were already totally ordered through UNIQUE (source_event_id, account_code); the order now ends in
// the line id so it does not depend on that constraint. The payouts list had a real tie: its unique key is (legal
// entity, provider, payout id), the order was (arrival date, payout id), so two providers' payouts with the same id on
// the same day could swap between pages; it now ends in (provider, id). Own throwaway database; rows inserted with the
// owner pool so they share one timestamp exactly (the worst case for a pager).
import { SEED_IDS } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listJournalLines, listPayouts } from '../src/api/queries.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const LE = SEED_IDS.legalEntities.brandA;
const STORE = SEED_IDS.stores.brandA;
const AT = '2026-10-05T10:00:00.000Z';
let t: AccountingTestDatabase;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

beforeAll(async () => {
  t = await createAccountingTestDatabase();
  // 4 events × 4 accounts = 16 journal lines on ONE entry date with ONE created_at
  for (let ev = 0; ev < 4; ev++) {
    const eventId = uuid();
    for (const [account, dr, cr] of [
      ['1200', 1_000, 0],
      ['2200', 0, 100],
      ['2300', 0, 800],
      ['2310', 0, 100],
    ] as const)
      await t.db.owner.query(
        `INSERT INTO ledger_entry (organization_id, legal_entity_id, store_id, journal, entry_date, account_code,
           debit_minor, credit_minor, currency, source_event_id, source_topic, reference_type, reference_id, created_at)
         VALUES ($1, $2, $3, 'sales', '2026-10-05', $4, $5, $6, 'EUR', $7, 'order.placed', 'order', $7, $8)`,
        [SEED_IDS.organization, LE, STORE, account, dr, cr, eventId, AT],
      );
  }
  // two providers, the SAME payout id, the SAME arrival date (+ a third payout on that day)
  for (const [provider, payoutId] of [
    ['stripe', 'po_same'],
    ['adyen', 'po_same'],
    ['adyen', 'po_other'],
  ] as const)
    await t.db.owner.query(
      `INSERT INTO psp_payout (organization_id, legal_entity_id, provider, provider_payout_id, currency, amount_minor, arrival_date)
       VALUES ($1, $2, $3, $4, 'EUR', 100, '2026-10-08')`,
      [SEED_IDS.organization, LE, provider, payoutId],
    );
}, 180_000);

afterAll(async () => {
  await t?.drop();
});

describe('Finance API paging is over a total order (#854)', () => {
  it('16 journal lines sharing one date and one timestamp, five per page: every line exactly once, in order', async () => {
    const seen: { id: string; source_event_id: string; account_code: string }[] = [];
    for (let page = 1; page <= 4; page++) {
      const r = await listJournalLines(t.hq, LE, { page, limit: 5 });
      expect(r.total).toBe(16);
      seen.push(...r.items);
    }
    expect(seen).toHaveLength(16);
    expect(new Set(seen.map((l) => l.id)).size).toBe(16);
    // the same rows in one page, in the same order: a page boundary never changes the order
    const whole = await listJournalLines(t.hq, LE, { page: 1, limit: 100 });
    expect(seen.map((l) => l.id)).toEqual(whole.items.map((l) => l.id));
    const key = (l: { source_event_id: string; account_code: string }) =>
      `${l.source_event_id}|${l.account_code}`;
    expect(seen.map(key)).toEqual([...seen.map(key)].sort());
  });

  it('two providers’ payouts with the same id on the same day page deterministically: provider decides, then the row id', async () => {
    const one = async (page: number) => (await listPayouts(t.hq, LE, { page, limit: 1 })).items[0]!;
    const paged = [await one(1), await one(2), await one(3)];
    expect(paged.map((p) => [p.provider_payout_id, p.provider])).toEqual([
      ['po_other', 'adyen'],
      ['po_same', 'adyen'],
      ['po_same', 'stripe'],
    ]);
    expect(new Set(paged.map((p) => p.id)).size).toBe(3);
    const whole = await listPayouts(t.hq, LE, { page: 1, limit: 100 });
    expect(whole.items.map((p) => p.id)).toEqual(paged.map((p) => p.id));
  });
});
