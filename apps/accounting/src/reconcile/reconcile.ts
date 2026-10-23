// Payout reconciliation (#549): import a payout report, match it against the ledger, post the payout when it matches
// to the cent, report every difference as a JSON line. One transaction per payout; re-importing a reconciled payout is
// a no-op (UNIQUE (legal_entity_id, provider, provider_payout_id) + the status).
//
//   bank (reference = payout, source_event_id = psp_payout.id, source_topic 'psp.payout' — a local marker, not a bus
//   topic; store_id NULL: a payout is a legal-entity-level fact and spans stores)
//     Dr 1000 Bank          payout amount
//     Cr 1100 PSP clearing  payout amount
//
// After a clean reconciliation the PSP clearing account of the legal entity nets to exactly what the PSP still holds
// (captures net of fees, minus refunds, not yet paid out).
import type { Queryable, ScopedClient } from '@platform/db';
import { ACCOUNT } from '../chart.js';
import { ensureChart, insertJournalEntry } from '../ledger.js';
import { consoleLogger, type Logger } from '../log.js';
import { finalizeEntry, line } from '../posting/balance.js';
import { matchPayout, type LedgerWindow } from './matcher.js';
import type {
  LedgerPayment,
  LedgerRefund,
  MatchedLine,
  PayoutReport,
  PayoutSource,
  ReconcileResult,
} from './types.js';

export interface ReconcileDeps {
  /** Organization-scoped client over the app-role pool. */
  client: ScopedClient;
  source: PayoutSource;
  log?: Logger;
}

async function loadLedger(
  tx: Queryable,
  legalEntityId: string,
  provider: string,
): Promise<{ payments: LedgerPayment[]; refunds: LedgerRefund[] }> {
  const p = await tx.query<{
    payment_id: string;
    store_id: string;
    provider_payment_id: string | null;
    amount_minor: string;
    fee_minor: string;
    currency: string;
    captured_at: Date;
  }>(
    `SELECT payment_id, store_id, provider_payment_id, amount_minor::text, fee_minor::text, currency, captured_at
       FROM accounting_payment WHERE legal_entity_id = $1 AND provider = $2 ORDER BY captured_at`,
    [legalEntityId, provider],
  );
  const r = await tx.query<{
    refund_id: string;
    store_id: string;
    provider_refund_id: string | null;
    amount_minor: string;
    currency: string;
    issued_at: Date;
  }>(
    `SELECT r.refund_id, r.store_id, r.provider_refund_id, r.amount_minor::text, r.currency, r.issued_at
       FROM accounting_refund r JOIN accounting_payment p ON p.payment_id = r.payment_id
      WHERE r.legal_entity_id = $1 AND p.provider = $2 ORDER BY r.issued_at`,
    [legalEntityId, provider],
  );
  return {
    payments: p.rows.map((x) => ({
      payment_id: x.payment_id,
      store_id: x.store_id,
      provider_payment_id: x.provider_payment_id,
      amount_minor: Number(x.amount_minor),
      fee_minor: Number(x.fee_minor),
      currency: x.currency,
      captured_at: x.captured_at.toISOString(),
    })),
    refunds: r.rows.map((x) => ({
      refund_id: x.refund_id,
      store_id: x.store_id,
      provider_refund_id: x.provider_refund_id,
      amount_minor: Number(x.amount_minor),
      currency: x.currency,
      issued_at: x.issued_at.toISOString(),
    })),
  };
}

/** The latest ledger time any OTHER payout of the legal entity matched: the exclusive start of this payout's window. */
async function windowStartBefore(
  tx: Queryable,
  legalEntityId: string,
  provider: string,
  payoutRowId: string,
): Promise<LedgerWindow> {
  const r = await tx.query<{ payments: Date | null; refunds: Date | null }>(
    `SELECT
       (SELECT max(p.captured_at) FROM psp_payout_line l JOIN accounting_payment p ON p.payment_id = l.matched_reference_id
         WHERE l.legal_entity_id = $1 AND l.payout_id <> $2 AND l.matched_reference_type = 'payment'
           AND l.payout_id IN (SELECT id FROM psp_payout WHERE provider = $3)) AS payments,
       (SELECT max(r.issued_at) FROM psp_payout_line l JOIN accounting_refund r ON r.refund_id = l.matched_reference_id
         WHERE l.legal_entity_id = $1 AND l.payout_id <> $2 AND l.matched_reference_type = 'refund'
           AND l.payout_id IN (SELECT id FROM psp_payout WHERE provider = $3)) AS refunds`,
    [legalEntityId, payoutRowId, provider],
  );
  const row = r.rows[0];
  return {
    payments: row?.payments ? row.payments.toISOString() : null,
    refunds: row?.refunds ? row.refunds.toISOString() : null,
  };
}

async function saveLines(
  tx: Queryable,
  payoutRowId: string,
  organizationId: string,
  legalEntityId: string,
  lines: MatchedLine[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.query(
    `INSERT INTO psp_payout_line (payout_id, organization_id, legal_entity_id, provider_txn_id, kind, provider_reference,
       amount_minor, fee_minor, net_minor, currency, available_on, matched_reference_type, matched_reference_id,
       match_status, difference_minor)
     SELECT $1, $2, $3, t.txn, t.kind, t.ref, t.amount, t.fee, t.net, t.cur, t.avail::date, t.mtype, t.mid::uuid, t.status, t.diff
       FROM unnest($4::text[], $5::text[], $6::text[], $7::bigint[], $8::bigint[], $9::bigint[], $10::text[], $11::text[],
                   $12::text[], $13::text[], $14::text[], $15::bigint[])
            AS t(txn, kind, ref, amount, fee, net, cur, avail, mtype, mid, status, diff)
     ON CONFLICT (payout_id, provider_txn_id) DO UPDATE SET
       matched_reference_type = EXCLUDED.matched_reference_type,
       matched_reference_id = EXCLUDED.matched_reference_id,
       match_status = EXCLUDED.match_status,
       difference_minor = EXCLUDED.difference_minor`,
    [
      payoutRowId,
      organizationId,
      legalEntityId,
      lines.map((l) => l.row.balance_transaction_id),
      lines.map((l) => l.kind),
      lines.map(
        (l) =>
          l.row.payment_intent_id ?? l.row.refund_id ?? l.row.charge_id ?? l.row.source_id ?? null,
      ),
      lines.map((l) => l.row.gross_minor),
      lines.map((l) => l.row.fee_minor),
      lines.map((l) => l.row.net_minor),
      lines.map((l) => l.row.currency),
      lines.map((l) => l.row.available_on || null),
      lines.map((l) => l.reference_type),
      lines.map((l) => l.reference_id),
      lines.map((l) => l.status),
      lines.map((l) => l.difference_minor),
    ],
  );
}

/** Imports, matches and (when clean) posts one payout. */
export async function reconcilePayout(
  deps: ReconcileDeps,
  legalEntityId: string,
  payoutId: string,
): Promise<ReconcileResult> {
  const log = deps.log ?? consoleLogger;
  const report: PayoutReport = await deps.source.payout(legalEntityId, payoutId);
  if (report.legal_entity_id !== legalEntityId)
    throw new Error(`payout ${payoutId} belongs to another legal entity`);
  const organizationId = deps.client.context.organizationId;

  const result = await deps.client.transaction(async (tx): Promise<ReconcileResult> => {
    const existing = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM psp_payout WHERE legal_entity_id = $1 AND provider = $2 AND provider_payout_id = $3 FOR UPDATE`,
      [legalEntityId, report.provider, report.payout_id],
    );
    if (existing.rows[0]?.status === 'reconciled') {
      const counts = await tx.query<{ n: string; m: string }>(
        `SELECT line_count::text AS n, matched_count::text AS m FROM psp_payout WHERE id = $1`,
        [existing.rows[0].id],
      );
      return {
        payout_id: report.payout_id,
        legal_entity_id: legalEntityId,
        status: 'reconciled',
        already_reconciled: true,
        lines: Number(counts.rows[0]!.n),
        matched: Number(counts.rows[0]!.m),
        discrepancies: [],
        posted: false,
      };
    }
    const upsert = await tx.query<{ id: string; posted_at: Date | null }>(
      `INSERT INTO psp_payout (organization_id, legal_entity_id, provider, provider_payout_id, currency, amount_minor, arrival_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'imported')
       ON CONFLICT (legal_entity_id, provider, provider_payout_id) DO UPDATE SET
         currency = EXCLUDED.currency, amount_minor = EXCLUDED.amount_minor, arrival_date = EXCLUDED.arrival_date
       RETURNING id, posted_at`,
      [
        organizationId,
        legalEntityId,
        report.provider,
        report.payout_id,
        report.currency,
        report.amount_minor,
        report.arrival_date,
      ],
    );
    const payoutRowId = upsert.rows[0]!.id;

    // one PSP account per (legal entity, provider): its payouts cover its payments, nobody else's
    const ledger = await loadLedger(tx, legalEntityId, report.provider);
    const windowStart = await windowStartBefore(tx, legalEntityId, report.provider, payoutRowId);
    const match = matchPayout({
      report,
      payments: ledger.payments,
      refunds: ledger.refunds,
      windowStart,
    });
    await saveLines(tx, payoutRowId, organizationId, legalEntityId, match.lines);
    const matched = match.lines.filter((l) => l.status === 'matched' && l.kind !== 'payout').length;
    const clean = match.discrepancies.length === 0;

    let posted = false;
    if (clean && report.amount_minor !== 0 && !upsert.rows[0]!.posted_at) {
      await ensureChart(tx, organizationId, legalEntityId);
      await insertJournalEntry(
        tx,
        organizationId,
        finalizeEntry({
          journal: 'bank',
          entry_date: report.arrival_date,
          legal_entity_id: legalEntityId,
          store_id: null,
          source_event_id: payoutRowId,
          source_topic: 'psp.payout',
          reference_type: 'payout',
          reference_id: payoutRowId,
          lines: [
            line(ACCOUNT.BANK, report.currency, report.amount_minor, 'debit'),
            line(ACCOUNT.PSP_CLEARING, report.currency, report.amount_minor, 'credit'),
          ],
        }),
      );
      posted = true;
    }
    await tx.query(
      `UPDATE psp_payout SET status = $2, line_count = $3, matched_count = $4,
         reconciled_at = CASE WHEN $2 = 'reconciled' THEN now() ELSE NULL END,
         posted_at = CASE WHEN $5 THEN now() ELSE posted_at END
       WHERE id = $1`,
      [payoutRowId, clean ? 'reconciled' : 'discrepant', match.lines.length, matched, posted],
    );
    return {
      payout_id: report.payout_id,
      legal_entity_id: legalEntityId,
      status: clean ? 'reconciled' : 'discrepant',
      already_reconciled: false,
      lines: match.lines.length,
      matched,
      discrepancies: match.discrepancies,
      posted,
    };
  });

  for (const d of result.discrepancies) log.warn({ event: 'discrepancy', ...d });
  log.info({
    event: 'payout_reconciled',
    payout_id: result.payout_id,
    legal_entity_id: result.legal_entity_id,
    status: result.status,
    already_reconciled: result.already_reconciled,
    lines: result.lines,
    matched: result.matched,
    discrepancies: result.discrepancies.length,
    posted: result.posted,
    amount_minor: report.amount_minor,
    currency: report.currency,
  });
  return result;
}

/** Every payout the source lists for the legal entity, oldest first. */
export async function reconcileAll(
  deps: ReconcileDeps,
  legalEntityId: string,
): Promise<ReconcileResult[]> {
  const out: ReconcileResult[] = [];
  for (const p of await deps.source.listPayouts(legalEntityId))
    out.push(await reconcilePayout(deps, legalEntityId, p.payout_id));
  return out;
}

/** The PSP clearing balance (debit − credit) of a legal entity per currency: what the PSP still holds for it. */
export async function pspClearingBalance(
  tx: Queryable,
  legalEntityId: string,
): Promise<Record<string, number>> {
  const r = await tx.query<{ currency: string; diff: string }>(
    `SELECT currency, (sum(debit_minor) - sum(credit_minor))::text AS diff FROM ledger_entry
      WHERE legal_entity_id = $1 AND account_code = $2 GROUP BY currency ORDER BY currency`,
    [legalEntityId, ACCOUNT.PSP_CLEARING],
  );
  return Object.fromEntries(r.rows.map((x) => [x.currency, Number(x.diff)]));
}
