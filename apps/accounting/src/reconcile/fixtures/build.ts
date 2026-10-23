// Builds the committed payout fixtures (fixtures/payouts/*) from a deterministic generated month, so the report rows
// agree with the events the ledger consumed — to the cent for the clean month, and with exactly one discrepancy of
// each kind for the discrepant one. `pnpm --filter @platform/accounting fixtures:payouts` rewrites the files;
// test/reconcile.test.ts fails when a committed file no longer equals what this builds.
import type { EventEnvelope, EventEnvelopeV1Base } from '@platform/events';
import { generateMonth, LE_A, LE_B } from '../../posting/fixtures.js';
import type { PayoutFixtureFile } from '../source-fixture.js';
import type { BalanceTransactionRow } from '../types.js';

export const FIXTURE_SEED = 2001;
export const FIXTURE_ORDERS = 60;
export const FIXTURE_ORDERS_PER_DAY = 2;
/** Weekly payouts; a transaction goes into the first payout whose arrival is after its available_on. */
const ARRIVALS = ['2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29'];
const SETTLEMENT_DAYS = 2;

export interface PayoutFixtureSet {
  name: 'clean-month' | 'discrepant-month';
  events: EventEnvelopeV1Base[];
  files: PayoutFixtureFile[];
}

const dateOf = (ts: string): string => ts.slice(0, 10);
const plusDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const short = (uuid: string): string => uuid.replace(/-/g, '').slice(0, 24);

function rowsFor(events: EventEnvelopeV1Base[], legalEntityId: string): BalanceTransactionRow[] {
  const rows: BalanceTransactionRow[] = [];
  for (const e of events) {
    if (e.topic === 'payment.captured') {
      const p = (e as EventEnvelope<'payment.captured'>).payload;
      if (p.legal_entity_id !== legalEntityId || !p.provider_payment_id) continue;
      const fee = p.fee_minor ?? 0;
      rows.push({
        balance_transaction_id: `txn_${short(p.payment_id)}`,
        reporting_category: 'charge',
        currency: p.currency,
        gross_minor: p.amount_minor,
        fee_minor: fee,
        net_minor: p.amount_minor - fee,
        available_on: plusDays(dateOf(p.captured_at), SETTLEMENT_DAYS),
        created: p.captured_at,
        source_id: `ch_${short(p.payment_id)}`,
        payment_intent_id: p.provider_payment_id,
        charge_id: `ch_${short(p.payment_id)}`,
        refund_id: null,
        description: 'Payment',
      });
    } else if (e.topic === 'refund.issued') {
      const r = (e as EventEnvelope<'refund.issued'>).payload;
      if (r.legal_entity_id !== legalEntityId || !r.provider_refund_id) continue;
      rows.push({
        balance_transaction_id: `txn_${short(r.refund_id)}`,
        reporting_category: 'refund',
        currency: r.currency,
        gross_minor: -r.amount_minor,
        fee_minor: 0,
        net_minor: -r.amount_minor,
        available_on: dateOf(r.issued_at),
        created: r.issued_at,
        source_id: r.provider_refund_id,
        payment_intent_id: null,
        charge_id: null,
        refund_id: r.provider_refund_id,
        description: 'Refund',
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.created.localeCompare(b.created) ||
      a.balance_transaction_id.localeCompare(b.balance_transaction_id),
  );
}

function fileFor(
  events: EventEnvelopeV1Base[],
  legalEntityId: string,
  code: string,
  currency: string,
): PayoutFixtureFile {
  const rows = rowsFor(events, legalEntityId);
  const payouts: PayoutFixtureFile['payouts'] = [];
  let previous = '0000-00-00';
  ARRIVALS.forEach((arrival, i) => {
    const mine = rows.filter((r) => r.available_on > previous && r.available_on < arrival);
    previous = plusDays(arrival, -1);
    payouts.push({
      payout_id: `po_fixture_${code}_${String(i + 1).padStart(2, '0')}`,
      arrival_date: arrival,
      amount_minor: mine.reduce((a, r) => a + r.net_minor, 0),
      status: 'paid',
      balance_transactions: mine,
    });
  });
  // rows with available_on on or after the last arrival stay unpaid: the open PSP balance
  return {
    provider: 'stripe',
    legal_entity_id: legalEntityId,
    account: `acct_fixture_${code}`,
    currency,
    payouts,
  };
}

const retotal = (p: PayoutFixtureFile['payouts'][number]): void => {
  p.amount_minor = p.balance_transactions.reduce((a, r) => a + r.net_minor, 0);
};

export function buildPayoutFixtures(): PayoutFixtureSet[] {
  const month = generateMonth({
    orders: FIXTURE_ORDERS,
    ordersPerDay: FIXTURE_ORDERS_PER_DAY,
    seed: FIXTURE_SEED,
    deterministicIds: true,
    nullFeeRate: 0,
  });
  const clean: PayoutFixtureFile[] = [
    fileFor(month.events, LE_A, 'le_brand_a', 'EUR'),
    fileFor(month.events, LE_B, 'le_brand_b', 'GBP'),
  ];

  // The discrepant month: the same events, and on legal entity A's four payouts exactly one difference each.
  const discrepant: PayoutFixtureFile[] = JSON.parse(JSON.stringify(clean)) as PayoutFixtureFile[];
  const a = discrepant.find((f) => f.legal_entity_id === LE_A)!;
  const charge = (i: number) =>
    a.payouts[i]!.balance_transactions.find((r) => r.reporting_category === 'charge')!;
  // 1. a charge the ledger never saw (unmatched_charge)
  a.payouts[0]!.balance_transactions.push({
    ...charge(0),
    balance_transaction_id: 'txn_fixture_unknown_charge',
    source_id: 'ch_fixture_unknown',
    charge_id: 'ch_fixture_unknown',
    payment_intent_id: 'pi_fixture_unknown',
    gross_minor: 4_200,
    fee_minor: 147,
    net_minor: 4_053,
  });
  retotal(a.payouts[0]!);
  // 2. a capture the payout left out (unmatched_ledger_line)
  const dropped = charge(1);
  a.payouts[1]!.balance_transactions = a.payouts[1]!.balance_transactions.filter(
    (r) => r !== dropped,
  );
  retotal(a.payouts[1]!);
  // 3. a fee that differs from the one payment.captured carried (fee_difference)
  const feeRow = charge(2);
  feeRow.fee_minor += 100;
  feeRow.net_minor -= 100;
  retotal(a.payouts[2]!);
  // 4. a gross that differs from the ledger amount (amount_difference)
  const grossRow = charge(3);
  grossRow.gross_minor += 50;
  grossRow.net_minor += 50;
  retotal(a.payouts[3]!);

  return [
    { name: 'clean-month', events: month.events, files: clean },
    { name: 'discrepant-month', events: month.events, files: discrepant },
  ];
}
