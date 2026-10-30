// The fixture PayoutSource: payout reports from JSON files in the exact shape the Stripe source will produce
// (`GET /v1/payouts` + `GET /v1/balance_transactions?payout=po_…`, or the itemized payout reconciliation report), one
// file per legal entity. No Stripe keys exist (#361): the live source is waived to the launch checklist and plugs into
// the same interface.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BalanceTransactionRow, PayoutReport, PayoutSource, PayoutSummary } from './types.js';

export interface PayoutFixtureFile {
  provider: string;
  legal_entity_id: string;
  /** The PSP account the report was pulled from (never a secret: an account id). */
  account: string;
  currency: string;
  payouts: {
    payout_id: string;
    arrival_date: string;
    amount_minor: number;
    status: PayoutSummary['status'];
    balance_transactions: BalanceTransactionRow[];
  }[];
}

export function createFixtureSource(files: PayoutFixtureFile[]): PayoutSource {
  const byEntity = new Map<string, PayoutFixtureFile[]>();
  for (const f of files)
    byEntity.set(f.legal_entity_id, [...(byEntity.get(f.legal_entity_id) ?? []), f]);
  const summaries = (f: PayoutFixtureFile): PayoutReport[] =>
    f.payouts.map((p) => ({
      payout_id: p.payout_id,
      legal_entity_id: f.legal_entity_id,
      provider: f.provider,
      currency: f.currency,
      amount_minor: p.amount_minor,
      arrival_date: p.arrival_date,
      status: p.status,
      balance_transactions: p.balance_transactions,
    }));
  return {
    name: 'fixture',
    async listPayouts(legalEntityId) {
      return (byEntity.get(legalEntityId) ?? [])
        .flatMap(summaries)
        .sort(
          (a, b) =>
            // bytewise, like reconcileAll's SQL order (COLLATE "C"); informational only, reconcileAll re-sorts
            (a.arrival_date < b.arrival_date ? -1 : a.arrival_date > b.arrival_date ? 1 : 0) ||
            (a.payout_id < b.payout_id ? -1 : a.payout_id > b.payout_id ? 1 : 0),
        )
        .map(({ balance_transactions: _rows, ...summary }) => summary);
    },
    async payout(legalEntityId, payoutId) {
      const report = (byEntity.get(legalEntityId) ?? [])
        .flatMap(summaries)
        .find((p) => p.payout_id === payoutId);
      if (!report)
        throw new Error(`fixture source: no payout ${payoutId} for legal entity ${legalEntityId}`);
      return report;
    },
  };
}

/** Every `payouts*.json` of a directory (events.json beside it is the ledger input, not a report), validated. */
export async function loadFixtureDir(dir: string): Promise<PayoutFixtureFile[]> {
  const names = (await readdir(dir)).filter((n) => /^payouts.*.json$/.test(n)).sort();
  const files: PayoutFixtureFile[] = [];
  for (const name of names) {
    const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as
      PayoutFixtureFile | PayoutFixtureFile[];
    // one report per legal entity; a file may hold one or a list of them
    for (const f of Array.isArray(parsed) ? parsed : [parsed]) {
      assertFixtureFile(f, name);
      files.push(f);
    }
  }
  return files;
}

export function assertFixtureFile(f: PayoutFixtureFile, name = 'fixture'): void {
  const fail = (what: string): never => {
    throw new Error(`${name}: ${what}`);
  };
  if (
    typeof f.legal_entity_id !== 'string' ||
    typeof f.provider !== 'string' ||
    typeof f.currency !== 'string'
  )
    fail('provider, legal_entity_id and currency are required');
  if (!Array.isArray(f.payouts)) fail('payouts must be an array');
  for (const p of f.payouts) {
    if (
      typeof p.payout_id !== 'string' ||
      !Number.isSafeInteger(p.amount_minor) ||
      typeof p.arrival_date !== 'string'
    )
      fail(
        `payout ${String(p.payout_id)}: payout_id, amount_minor (integer) and arrival_date are required`,
      );
    for (const r of p.balance_transactions) {
      if (typeof r.balance_transaction_id !== 'string')
        fail(`payout ${p.payout_id}: a row has no balance_transaction_id`);
      for (const k of ['gross_minor', 'fee_minor', 'net_minor'] as const)
        if (!Number.isSafeInteger(r[k]))
          fail(`row ${r.balance_transaction_id}: ${k} must be an integer`);
      if (r.gross_minor - r.fee_minor !== r.net_minor)
        fail(`row ${r.balance_transaction_id}: net ≠ gross − fee`);
    }
  }
}
