// Payout reconciliation (#549) on seeded throwaway databases: the committed fixtures are what the builder builds; the
// clean month reconciles every payout to the cent and posts it, the PSP clearing account then nets to the open
// balance exactly, a re-import is a no-op; the discrepant month (its own database) reports each difference kind
// exactly once and posts nothing for the payout that carries it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventEnvelopeV1Base } from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT } from '../src/chart.js';
import { handleLedgerEvent } from '../src/consumer.js';
import { balanceByCurrency, trialBalance } from '../src/ledger.js';
import type { Logger } from '../src/log.js';
import { LE_A, LE_B } from '../src/posting/fixtures.js';
import { buildPayoutFixtures } from '../src/reconcile/fixtures/build.js';
import { FIXTURES_DIR } from '../src/reconcile/fixtures/write.js';
import { matchPayout } from '../src/reconcile/matcher.js';
import { pspClearingBalance, reconcileAll, reconcilePayout } from '../src/reconcile/reconcile.js';
import {
  createFixtureSource,
  loadFixtureDir,
  type PayoutFixtureFile,
} from '../src/reconcile/source-fixture.js';
import type { Discrepancy, PayoutReport } from '../src/reconcile/types.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const LOG: string[] = [];
const log: Logger = {
  info: (l) => LOG.push(JSON.stringify(l)),
  warn: (l) => LOG.push(JSON.stringify(l)),
  error: (l) => LOG.push(JSON.stringify(l)),
};
const counter =
  (db: () => AccountingTestDatabase) =>
  async (sql: string, params: unknown[] = []) =>
    Number(
      (await db().hq.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))
        .rows[0]!.n,
    );

async function loadSet(
  name: string,
): Promise<{ files: PayoutFixtureFile[]; events: EventEnvelopeV1Base[] }> {
  const files = await loadFixtureDir(path.join(FIXTURES_DIR, name));
  const events = JSON.parse(
    await readFile(path.join(FIXTURES_DIR, name, 'events.json'), 'utf8'),
  ) as EventEnvelopeV1Base[];
  return { files, events };
}

async function consumeAll(
  db: AccountingTestDatabase,
  events: EventEnvelopeV1Base[],
): Promise<void> {
  for (const e of events)
    await handleLedgerEvent(db.hq, {
      envelope: e,
      outboxId: e.event_id,
      schemaId: null,
      headers: {},
    });
}

/** The open PSP balance a fixture set leaves: Σ net of the captures and refunds no payout carries. */
function openBalance(file: PayoutFixtureFile, events: EventEnvelopeV1Base[]): number {
  const paid = new Set(
    file.payouts.flatMap((p) => p.balance_transactions.map((r) => r.balance_transaction_id)),
  );
  const short = (id: string) => `txn_${id.replace(/-/g, '').slice(0, 24)}`;
  let open = 0;
  for (const e of events) {
    const p = e.payload as {
      legal_entity_id: string;
      payment_id?: string;
      refund_id?: string;
      amount_minor: number;
      fee_minor?: number | null;
      provider_payment_id?: string | null;
      provider_refund_id?: string | null;
    };
    if (p.legal_entity_id !== file.legal_entity_id) continue;
    if (e.topic === 'payment.captured' && p.provider_payment_id && !paid.has(short(p.payment_id!)))
      open += p.amount_minor - (p.fee_minor ?? 0);
    if (e.topic === 'refund.issued' && p.provider_refund_id && !paid.has(short(p.refund_id!)))
      open -= p.amount_minor;
  }
  return open;
}

describe('fixtures', () => {
  it('the committed files are exactly what the builder builds (run `pnpm fixtures:payouts` after changing it)', async () => {
    for (const set of buildPayoutFixtures()) {
      const { files, events } = await loadSet(set.name);
      expect(events, `${set.name}/events.json`).toEqual(set.events);
      expect(files, `${set.name}/payouts.json`).toEqual(set.files);
    }
  });

  it('loadFixtureDir validates the shape; the clean month has two legal entities, four payouts each, nets consistent', async () => {
    const { files } = await loadSet('clean-month');
    expect(files.map((f) => [f.legal_entity_id, f.currency, f.payouts.length])).toEqual([
      [LE_A, 'EUR', 4],
      [LE_B, 'GBP', 4],
    ]);
    for (const f of files)
      for (const p of f.payouts) {
        expect(p.balance_transactions.length).toBeGreaterThan(0);
        expect(p.balance_transactions.reduce((a, r) => a + r.net_minor, 0)).toBe(p.amount_minor);
      }
  });
});

describe('matcher (pure)', () => {
  const report = (rows: PayoutReport['balance_transactions'], amount: number): PayoutReport => ({
    payout_id: 'po_t',
    legal_entity_id: LE_A,
    provider: 'stripe',
    currency: 'EUR',
    amount_minor: amount,
    arrival_date: '2026-10-08',
    status: 'paid',
    balance_transactions: rows,
  });
  const row = (
    over: Partial<PayoutReport['balance_transactions'][number]>,
  ): PayoutReport['balance_transactions'][number] => ({
    balance_transaction_id: 'txn_1',
    reporting_category: 'charge',
    currency: 'EUR',
    gross_minor: 1_000,
    fee_minor: 54,
    net_minor: 946,
    available_on: '2026-10-07',
    created: '2026-10-05T10:00:00.000Z',
    source_id: 'ch_1',
    payment_intent_id: 'pi_1',
    charge_id: 'ch_1',
    refund_id: null,
    ...over,
  });
  const payment = {
    payment_id: '00000000-0000-4000-8000-0000000000a1',
    store_id: 's',
    provider_payment_id: 'pi_1',
    amount_minor: 1_000,
    fee_minor: 54,
    currency: 'EUR',
    captured_at: '2026-10-05T10:00:00.000Z',
  };
  const noWindow = { payments: null, refunds: null };
  const kinds = (ds: Discrepancy[]) => ds.map((d) => d.kind).sort();

  it('matches a charge by payment intent, a refund by refund id; the payout total must equal Σ net', () => {
    const refund = {
      refund_id: '00000000-0000-4000-8000-0000000000b1',
      store_id: 's',
      provider_refund_id: 're_1',
      amount_minor: 300,
      currency: 'EUR',
      issued_at: '2026-10-06T10:00:00.000Z',
    };
    const r = matchPayout({
      report: report(
        [
          row({}),
          row({
            balance_transaction_id: 'txn_2',
            reporting_category: 'refund',
            gross_minor: -300,
            fee_minor: 0,
            net_minor: -300,
            refund_id: 're_1',
            source_id: 're_1',
            payment_intent_id: null,
            charge_id: null,
          }),
        ],
        646,
      ),
      payments: [payment],
      refunds: [refund],
      windowStart: noWindow,
    });
    expect(r.discrepancies).toEqual([]);
    expect(r.lines.map((l) => [l.kind, l.status, l.reference_id])).toEqual([
      ['charge', 'matched', payment.payment_id],
      ['refund', 'matched', refund.refund_id],
    ]);
    expect(r.storeId).toBe('s');
    expect(r.windowEnd).toEqual({ payments: payment.captured_at, refunds: refund.issued_at });
    const total = matchPayout({
      report: report([row({})], 900),
      payments: [payment],
      refunds: [],
      windowStart: noWindow,
    });
    expect(kinds(total.discrepancies)).toEqual(['amount_difference']);
    expect(total.discrepancies[0]).toMatchObject({
      reference_type: 'payout',
      expected_minor: 946,
      actual_minor: 900,
      difference_minor: -46,
    });
  });

  it('each discrepancy kind, and the window rule for unmatched ledger lines', () => {
    const unknown = matchPayout({
      report: report(
        [row({ payment_intent_id: 'pi_x', charge_id: 'ch_x', source_id: 'ch_x' })],
        946,
      ),
      payments: [payment],
      refunds: [],
      windowStart: noWindow,
    });
    // the unknown charge AND, since nothing matched, no window: the ledger payment is not reported as missing
    expect(kinds(unknown.discrepancies)).toEqual(['unmatched_charge']);
    const fee = matchPayout({
      report: report([row({ fee_minor: 60, net_minor: 940 })], 940),
      payments: [payment],
      refunds: [],
      windowStart: noWindow,
    });
    expect(fee.discrepancies).toMatchObject([
      { kind: 'fee_difference', expected_minor: 54, actual_minor: 60, difference_minor: 6 },
    ]);
    const gross = matchPayout({
      report: report([row({ gross_minor: 1_010, net_minor: 956 })], 956),
      payments: [payment],
      refunds: [],
      windowStart: noWindow,
    });
    expect(gross.discrepancies).toMatchObject([
      {
        kind: 'amount_difference',
        reference_type: 'payment',
        expected_minor: 1_000,
        actual_minor: 1_010,
        difference_minor: 10,
      },
    ]);
    const earlier = {
      ...payment,
      payment_id: '00000000-0000-4000-8000-0000000000a2',
      provider_payment_id: 'pi_2',
      captured_at: '2026-10-05T09:00:00.000Z',
    };
    const missing = matchPayout({
      report: report([row({})], 946),
      payments: [payment, earlier],
      refunds: [],
      windowStart: noWindow,
    });
    expect(missing.discrepancies).toMatchObject([
      {
        kind: 'unmatched_ledger_line',
        reference_id: earlier.payment_id,
        provider_reference: 'pi_2',
      },
    ]);
    // the same with a window start after that capture: an earlier payout's business, not reported again
    const windowed = matchPayout({
      report: report([row({})], 946),
      payments: [payment, earlier],
      refunds: [],
      windowStart: { payments: '2026-10-05T09:30:00.000Z', refunds: null },
    });
    expect(windowed.discrepancies).toEqual([]);
  });

  it('the window compares instants, not strings: fractional seconds, an offset, equal instants written differently (#589)', () => {
    const at = (captured_at: string, start: string) =>
      kinds(
        matchPayout({
          report: report([row({})], 946),
          payments: [
            payment,
            {
              ...payment,
              payment_id: '00000000-0000-4000-8000-0000000000a3',
              provider_payment_id: 'pi_3',
              captured_at,
            },
          ],
          refunds: [],
          windowStart: { payments: start, refunds: null },
        }).discrepancies,
      );
    // half a second after a whole-second start is inside the window: reported
    expect(at('2026-10-05T09:00:00.500Z', '2026-10-05T09:00:00Z')).toEqual([
      'unmatched_ledger_line',
    ]);
    // 09:00Z is after 10:30+02:00 (= 08:30Z): inside, reported
    expect(at('2026-10-05T09:00:00.000Z', '2026-10-05T10:30:00+02:00')).toEqual([
      'unmatched_ledger_line',
    ]);
    // 10:00+01:00 IS the 09:00Z start (exclusive): an earlier payout's business, not reported
    expect(at('2026-10-05T10:00:00+01:00', '2026-10-05T09:00:00.000Z')).toEqual([]);
  });
});

describe('the clean month', () => {
  let t: AccountingTestDatabase;
  let files: PayoutFixtureFile[];
  let events: EventEnvelopeV1Base[];
  const count = counter(() => t);

  beforeAll(async () => {
    t = await createAccountingTestDatabase();
    ({ files, events } = await loadSet('clean-month'));
    await consumeAll(t, events);
  }, 180_000);

  afterAll(async () => {
    await t?.drop();
  });

  it('every payout of both legal entities reconciles with zero differences and is posted bank vs PSP clearing', async () => {
    const deps = { client: t.hq, source: createFixtureSource(files), log };
    for (const f of files) {
      const results = await reconcileAll(deps, f.legal_entity_id);
      expect(results.map((r) => [r.payout_id, r.status, r.discrepancies.length, r.posted])).toEqual(
        f.payouts.map((p) => [p.payout_id, 'reconciled', 0, true]),
      );
      expect(results.reduce((a, r) => a + r.lines, 0)).toBe(
        f.payouts.reduce((a, p) => a + p.balance_transactions.length, 0),
      );
      expect(results.every((r) => r.matched === r.lines)).toBe(true);
    }
    expect(await count("psp_payout WHERE status = 'reconciled'")).toBe(8);
    expect(await count("psp_payout_line WHERE match_status <> 'matched'")).toBe(0);
    expect(await count("ledger_entry WHERE journal = 'bank'")).toBe(16);
    expect(await count("ledger_entry WHERE journal = 'bank' AND store_id IS NULL")).toBe(16);
    expect(await count("ledger_entry WHERE journal <> 'bank' AND store_id IS NULL")).toBe(0);
    const bank = await t.hq.query<{ legal_entity_id: string; currency: string; total: string }>(
      `SELECT legal_entity_id, currency, sum(debit_minor)::text AS total FROM ledger_entry
        WHERE journal = 'bank' AND account_code = $1 GROUP BY 1, 2 ORDER BY 1`,
      [ACCOUNT.BANK],
    );
    expect(bank.rows.map((r) => [r.legal_entity_id, r.currency, Number(r.total)])).toEqual(
      files.map((f) => [
        f.legal_entity_id,
        f.currency,
        f.payouts.reduce((a, p) => a + p.amount_minor, 0),
      ]),
    );
    expect(LOG.some((l) => l.includes('"event":"discrepancy"'))).toBe(false);
  });

  it('the PSP clearing account of each legal entity nets to the open (unpaid-out) balance exactly; books still balance', async () => {
    for (const f of files) {
      const clearing = await t.hq.transaction((tx) => pspClearingBalance(tx, f.legal_entity_id));
      const open = openBalance(f, events);
      expect(open).toBeGreaterThan(0); // the last days of the month are not paid out yet
      expect(clearing).toEqual({ [f.currency]: open });
      const balance = await t.hq.transaction((tx) => balanceByCurrency(tx, f.legal_entity_id));
      expect(balance[f.currency]).toBe(0);
      const tb = await t.hq.transaction((tx) => trialBalance(tx, f.legal_entity_id));
      expect(tb.find((r) => r.account_code === ACCOUNT.BANK)!.balance_minor).toBe(
        f.payouts.reduce((a, p) => a + p.amount_minor, 0),
      );
    }
  });

  it('re-importing the same payouts is a no-op: nothing written, nothing posted twice', async () => {
    const entries = await count('ledger_entry');
    const lines = await count('psp_payout_line');
    const deps = { client: t.hq, source: createFixtureSource(files), log };
    for (const f of files) {
      const again = await reconcileAll(deps, f.legal_entity_id);
      expect(
        again.every((r) => r.status === 'reconciled' && r.already_reconciled && !r.posted),
      ).toBe(true);
    }
    expect(await count('ledger_entry')).toBe(entries);
    expect(await count('psp_payout_line')).toBe(lines);
    expect(await count('psp_payout')).toBe(8);
  });
});

describe('the discrepant month (its own database: the same events, one difference per payout of legal entity A)', () => {
  let d: AccountingTestDatabase;
  let files: PayoutFixtureFile[];
  const count = counter(() => d);

  beforeAll(async () => {
    d = await createAccountingTestDatabase();
    const set = await loadSet('discrepant-month');
    files = set.files;
    await consumeAll(d, set.events);
  }, 180_000);

  afterAll(async () => {
    await d?.drop();
  });

  it('reports each difference kind exactly once (legal entity A), posts nothing for those payouts; B reconciles', async () => {
    const before = await count('ledger_entry');
    const deps = { client: d.hq, source: createFixtureSource(files), log };
    const a = await reconcileAll(deps, LE_A);
    expect(a.map((r) => r.status)).toEqual([
      'discrepant',
      'discrepant',
      'discrepant',
      'discrepant',
    ]);
    const all = a.flatMap((r) => r.discrepancies);
    expect(a.map((r) => r.discrepancies.map((x) => x.kind))).toEqual([
      ['unmatched_charge'],
      ['unmatched_ledger_line'],
      ['fee_difference'],
      ['amount_difference'],
    ]);
    expect(all.find((x) => x.kind === 'unmatched_charge')).toMatchObject({
      provider_reference: 'pi_fixture_unknown',
      actual_minor: 4_200,
    });
    expect(all.find((x) => x.kind === 'fee_difference')).toMatchObject({ difference_minor: 100 });
    expect(all.find((x) => x.kind === 'amount_difference')).toMatchObject({
      difference_minor: 50,
      reference_type: 'payment',
    });
    expect(all.find((x) => x.kind === 'unmatched_ledger_line')!.reference_type).toBe('payment');
    expect(a.every((r) => !r.posted)).toBe(true);
    expect(await count('ledger_entry')).toBe(before);
    expect(await count("psp_payout WHERE status = 'discrepant'")).toBe(4);
    expect(
      await count(
        "psp_payout_line WHERE match_status = 'unmatched' AND provider_reference = 'pi_fixture_unknown'",
      ),
    ).toBe(1);
    expect(LOG.filter((l) => l.includes('"event":"discrepancy"')).length).toBe(4);
    for (const l of LOG) expect(l).not.toMatch(/email|@|line_items|title/);

    // legal entity B's report is untouched: it reconciles and posts
    const b = await reconcileAll(deps, LE_B);
    expect(b.every((r) => r.status === 'reconciled' && r.posted)).toBe(true);
    expect(await count("ledger_entry WHERE journal = 'bank'")).toBe(b.length * 2);
  });

  it('a SECOND full pass finds the same four kinds on the same payouts, posts nothing, payout 2 stays discrepant (later payouts never widen an earlier window)', async () => {
    // Fable review of #571: the window start took the max over every OTHER payout, later ones included, so a
    // re-import of payout 2 after 3 and 4 existed saw an empty window, came out clean and POSTED the bank entry for
    // a payout that omits a capture. Only payouts strictly earlier (arrival_date, payout id) may start the window.
    const before = await count('ledger_entry');
    const deps = { client: d.hq, source: createFixtureSource(files), log };
    const again = await reconcileAll(deps, LE_A);
    expect(again.map((r) => r.discrepancies.map((x) => x.kind))).toEqual([
      ['unmatched_charge'],
      ['unmatched_ledger_line'],
      ['fee_difference'],
      ['amount_difference'],
    ]);
    expect(again.map((r) => [r.status, r.posted, r.already_reconciled])).toEqual(
      again.map(() => ['discrepant', false, false]),
    );
    expect(await count('ledger_entry')).toBe(before);
    const p2 = await d.hq.query<{ status: string; posted_at: Date | null }>(
      'SELECT status, posted_at FROM psp_payout WHERE legal_entity_id = $1 AND provider_payout_id = $2',
      [LE_A, files[0]!.payouts[1]!.payout_id],
    );
    expect(p2.rows[0]).toEqual({ status: 'discrepant', posted_at: null });
  });

  it('a discrepant payout imported again is re-matched, not skipped; still nothing posted', async () => {
    const deps = { client: d.hq, source: createFixtureSource(files), log };
    const again = await reconcilePayout(deps, LE_A, files[0]!.payouts[0]!.payout_id);
    expect(again).toMatchObject({ status: 'discrepant', already_reconciled: false, posted: false });
    expect(again.discrepancies.map((x) => x.kind)).toEqual(['unmatched_charge']);
    expect(await count('psp_payout WHERE legal_entity_id = $1', [LE_A])).toBe(4);
  });
});
