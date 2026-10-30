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
  Discrepancy,
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

/**
 * The latest ledger time an EARLIER payout of this legal entity and provider matched — earlier by (arrival_date,
 * provider_payout_id COLLATE "C"), the same bytewise order reconcileAll imports in (#645: Stripe ids are mixed-case, and
 * a JS localeCompare next to a collation-dependent SQL `<` could disagree) — the exclusive start of this payout's
 * window. Only lines the payout's CURRENT report carries count: a line a re-imported report dropped is reset to
 * `pending` with no match (saveLines), so it never widens a later window (#645). Later payouts never count: a re-import of an
 * older payout must see the same window it saw the first time (Fable review of #571).
 */
async function windowStartBefore(
  tx: Queryable,
  legalEntityId: string,
  provider: string,
  payoutRowId: string,
): Promise<LedgerWindow> {
  const r = await tx.query<{ payments: Date | null; refunds: Date | null }>(
    `WITH me AS (SELECT arrival_date, provider_payout_id FROM psp_payout WHERE id = $2),
          earlier AS (
            SELECT o.id FROM psp_payout o, me
             WHERE o.legal_entity_id = $1 AND o.provider = $3 AND o.id <> $2
               AND (o.arrival_date, o.provider_payout_id COLLATE "C") < (me.arrival_date, me.provider_payout_id COLLATE "C"))
     SELECT
       (SELECT max(p.captured_at) FROM psp_payout_line l JOIN accounting_payment p ON p.payment_id = l.matched_reference_id
         WHERE l.legal_entity_id = $1 AND l.matched_reference_type = 'payment' AND l.payout_id IN (SELECT id FROM earlier)) AS payments,
       (SELECT max(r.issued_at) FROM psp_payout_line l JOIN accounting_refund r ON r.refund_id = l.matched_reference_id
         WHERE l.legal_entity_id = $1 AND l.matched_reference_type = 'refund' AND l.payout_id IN (SELECT id FROM earlier)) AS refunds`,
    [legalEntityId, payoutRowId, provider],
  );
  const row = r.rows[0];
  return {
    payments: row?.payments ? row.payments.toISOString() : null,
    refunds: row?.refunds ? row.refunds.toISOString() : null,
  };
}

/** The report with its own and every row's currency upper-cased and trimmed (#651). */
export function normalizeCurrencies(report: PayoutReport): PayoutReport {
  const code = (c: string) => c.trim().toUpperCase();
  return {
    ...report,
    currency: code(report.currency),
    balance_transactions: report.balance_transactions.map((r) => ({
      ...r,
      currency: code(r.currency),
    })),
  };
}

async function saveLines(
  tx: Queryable,
  payoutRowId: string,
  organizationId: string,
  legalEntityId: string,
  lines: MatchedLine[],
): Promise<number> {
  // #645: the lines of this payout that its CURRENT report no longer carries (the PSP re-issued it). Lines are never
  // deleted (0203 revokes DELETE): they are reset to `pending` with no match, so they stay visible but never count
  // toward a later payout's window. Without this, a capture dropped on re-import stayed matched here and nobody
  // reported it.
  const superseded = await tx.query(
    `UPDATE psp_payout_line SET match_status = 'pending', matched_reference_type = NULL, matched_reference_id = NULL,
            difference_minor = 0
      WHERE payout_id = $1 AND NOT (provider_txn_id = ANY($2::text[])) AND match_status <> 'pending'`,
    [payoutRowId, lines.map((l) => l.row.balance_transaction_id)],
  );
  if (lines.length === 0) return superseded.rowCount ?? 0;
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
  return superseded.rowCount ?? 0;
}

/** Imports, matches and (when clean) posts one payout. */
export async function reconcilePayout(
  deps: ReconcileDeps,
  legalEntityId: string,
  payoutId: string,
): Promise<ReconcileResult> {
  const log = deps.log ?? consoleLogger;
  // #651: ISO 4217 codes are upper-cased ONCE, at import, before anything is stored, matched or posted. Stripe reports
  // `eur`; a raw code would store the payout and post its bank entry as `eur` beside the ledger's `EUR` (two
  // currencies in one trial balance, and an API answer outside the contract's ^[A-Z]{3}$).
  const report: PayoutReport = normalizeCurrencies(
    await deps.source.payout(legalEntityId, payoutId),
  );
  if (report.legal_entity_id !== legalEntityId)
    throw new Error(`payout ${payoutId} belongs to another legal entity`);
  const organizationId = deps.client.context.organizationId;

  const result = await deps.client.transaction(async (tx): Promise<ReconcileResult> => {
    const existing = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM psp_payout WHERE legal_entity_id = $1 AND provider = $2 AND provider_payout_id = $3 FOR UPDATE`,
      [legalEntityId, report.provider, report.payout_id],
    );
    if (existing.rows[0]?.status === 'reconciled') {
      const stored = await tx.query<{
        n: string;
        m: string;
        amount: string;
        arrival: string;
        currency: string;
      }>(
        `SELECT line_count::text AS n, matched_count::text AS m, amount_minor::text AS amount,
                arrival_date::text AS arrival, currency FROM psp_payout WHERE id = $1`,
        [existing.rows[0].id],
      );
      const s = stored.rows[0]!;
      // #645: a reconciled (and posted) payout is never rewritten; a re-import that disagrees with it is REPORTED
      const changed: ('amount_minor' | 'arrival_date' | 'currency')[] = [];
      if (Number(s.amount) !== report.amount_minor) changed.push('amount_minor');
      if (s.arrival !== report.arrival_date) changed.push('arrival_date');
      if (s.currency.trim().toUpperCase() !== report.currency.toUpperCase())
        changed.push('currency');
      const discrepancies: Discrepancy[] = changed.length
        ? [
            {
              reconcile: 'psp.payout',
              legal_entity_id: legalEntityId,
              payout_id: report.payout_id,
              kind: 'reconciled_payout_changed',
              currency: report.currency,
              reference_type: 'payout',
              reference_id: existing.rows[0].id,
              expected_minor: Number(s.amount),
              actual_minor: report.amount_minor,
              difference_minor: report.amount_minor - Number(s.amount),
              changed,
            },
          ]
        : [];
      return {
        payout_id: report.payout_id,
        legal_entity_id: legalEntityId,
        status: changed.length ? 'discrepant' : 'reconciled',
        already_reconciled: true,
        lines: Number(s.n),
        matched: Number(s.m),
        discrepancies,
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
    const superseded = await saveLines(tx, payoutRowId, organizationId, legalEntityId, match.lines);
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
      superseded_lines: superseded,
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
    superseded_lines: result.superseded_lines ?? 0,
    amount_minor: report.amount_minor,
    currency: report.currency,
  });
  return result;
}

/**
 * Every payout the source lists for the legal entity, oldest first — sorted IN POSTGRES by (arrival_date, payout_id
 * COLLATE "C"), the one ordering windowStartBefore uses (#645), whatever order the source returned, because the window rule needs the earlier payouts matched before a later
 * one (an out-of-order first import would report false unmatched ledger lines).
 */
export async function reconcileAll(
  deps: ReconcileDeps,
  legalEntityId: string,
): Promise<ReconcileResult[]> {
  const out: ReconcileResult[] = [];
  const listed = await deps.source.listPayouts(legalEntityId);
  if (listed.length === 0) return out;
  const order = await deps.client.query<{ id: string }>(
    `SELECT t.id FROM unnest($1::text[], $2::date[]) AS t(id, arrival)
      ORDER BY t.arrival, t.id COLLATE "C"`,
    [listed.map((p) => p.payout_id), listed.map((p) => p.arrival_date)],
  );
  for (const { id } of order.rows) out.push(await reconcilePayout(deps, legalEntityId, id));
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
