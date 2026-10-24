// The pure matcher: payout rows against the ledger's captures and refunds. No I/O.
//
//   charge  ↔ accounting_payment by payment_intent_id (what payment.captured carries) or charge_id
//            gross must equal amount_minor, fee must equal fee_minor
//   refund  ↔ accounting_refund by refund_id (or source_id); −gross must equal amount_minor
//   payout  — the payout's own transaction, when a report includes it: ignored for matching
//   fee / adjustment / other — reported as unmatched charges (the ledger has no counterpart yet)
//   Σ net of the charge and refund rows must equal the payout amount
//   a ledger capture / refund in the payout's WINDOW with no row in it is an unmatched ledger line; the window runs
//   from the latest ledger time an earlier payout matched (exclusive) to the latest ledger time this payout matched,
//   so every missing line is reported exactly once, by the payout that should have carried it
import type {
  BalanceTransactionRow,
  Discrepancy,
  LedgerPayment,
  LedgerRefund,
  MatchedLine,
  PayoutReport,
} from './types.js';

export interface MatchInput {
  report: PayoutReport;
  payments: LedgerPayment[];
  refunds: LedgerRefund[];
  /** The latest captured_at / issued_at an EARLIER payout of this legal entity matched (exclusive window start). */
  windowStart: LedgerWindow;
}

export interface MatchOutput {
  lines: MatchedLine[];
  discrepancies: Discrepancy[];
  /** The store of the first matched payment — informational; the payout posting itself carries store_id NULL. */
  storeId: string | null;
  /** max available_on of the rows */
  periodEnd: string | null;
  /** the latest ledger time this payout matched (the window end) */
  windowEnd: LedgerWindow;
}

/** Per type, because captures settle two days after the fact and refunds at once: one window would mix them. */
export interface LedgerWindow {
  payments: string | null;
  refunds: string | null;
}

function kindOf(row: BalanceTransactionRow): MatchedLine['kind'] {
  switch (row.reporting_category) {
    case 'charge':
      return 'charge';
    case 'refund':
      return 'refund';
    case 'payout':
      return 'payout';
    case 'fee':
    case 'stripe_fee':
      return 'fee';
    case 'adjustment':
      return 'adjustment';
    default:
      return 'other';
  }
}

export function matchPayout(input: MatchInput): MatchOutput {
  const { report } = input;
  const base = {
    reconcile: 'psp.payout' as const,
    legal_entity_id: report.legal_entity_id,
    payout_id: report.payout_id,
    currency: report.currency,
  };
  const byIntent = new Map<string, LedgerPayment>();
  for (const p of input.payments) if (p.provider_payment_id) byIntent.set(p.provider_payment_id, p);
  const byRefund = new Map<string, LedgerRefund>();
  for (const r of input.refunds) if (r.provider_refund_id) byRefund.set(r.provider_refund_id, r);

  const lines: MatchedLine[] = [];
  const discrepancies: Discrepancy[] = [];
  const covered = new Set<string>();
  let storeId: string | null = null;
  let periodEnd: string | null = null;
  const windowEnd: LedgerWindow = { payments: null, refunds: null };
  let sumNet = 0;
  const seen = (type: keyof LedgerWindow, at: string) => {
    const cur = windowEnd[type];
    if (!cur || at > cur) windowEnd[type] = at;
  };

  for (const row of report.balance_transactions) {
    const kind = kindOf(row);
    if (row.available_on && (!periodEnd || row.available_on > periodEnd))
      periodEnd = row.available_on;
    if (kind === 'payout') {
      lines.push({
        row,
        kind,
        status: 'matched',
        reference_type: null,
        reference_id: null,
        difference_minor: 0,
      });
      continue;
    }
    sumNet += row.net_minor;
    if (kind === 'charge') {
      const payment =
        (row.payment_intent_id && byIntent.get(row.payment_intent_id)) ||
        (row.charge_id && byIntent.get(row.charge_id)) ||
        (row.source_id && byIntent.get(row.source_id)) ||
        null;
      if (!payment) {
        lines.push({
          row,
          kind,
          status: 'unmatched',
          reference_type: null,
          reference_id: null,
          difference_minor: row.gross_minor,
        });
        discrepancies.push({
          ...base,
          kind: 'unmatched_charge',
          balance_transaction_id: row.balance_transaction_id,
          provider_reference: row.payment_intent_id ?? row.charge_id ?? row.source_id,
          actual_minor: row.gross_minor,
          difference_minor: row.gross_minor,
        });
        continue;
      }
      storeId ??= payment.store_id;
      seen('payments', payment.captured_at);
      covered.add(payment.provider_payment_id!);
      if (row.gross_minor !== payment.amount_minor || row.currency !== payment.currency) {
        const diff = row.gross_minor - payment.amount_minor;
        lines.push({
          row,
          kind,
          status: 'amount_mismatch',
          reference_type: 'payment',
          reference_id: payment.payment_id,
          difference_minor: diff,
        });
        discrepancies.push({
          ...base,
          kind: 'amount_difference',
          balance_transaction_id: row.balance_transaction_id,
          provider_reference: payment.provider_payment_id,
          reference_type: 'payment',
          reference_id: payment.payment_id,
          expected_minor: payment.amount_minor,
          actual_minor: row.gross_minor,
          difference_minor: diff,
        });
        continue;
      }
      if (row.fee_minor !== payment.fee_minor) {
        const diff = row.fee_minor - payment.fee_minor;
        lines.push({
          row,
          kind,
          status: 'fee_mismatch',
          reference_type: 'payment',
          reference_id: payment.payment_id,
          difference_minor: diff,
        });
        discrepancies.push({
          ...base,
          kind: 'fee_difference',
          balance_transaction_id: row.balance_transaction_id,
          provider_reference: payment.provider_payment_id,
          reference_type: 'payment',
          reference_id: payment.payment_id,
          expected_minor: payment.fee_minor,
          actual_minor: row.fee_minor,
          difference_minor: diff,
        });
        continue;
      }
      lines.push({
        row,
        kind,
        status: 'matched',
        reference_type: 'payment',
        reference_id: payment.payment_id,
        difference_minor: 0,
      });
      continue;
    }
    if (kind === 'refund') {
      const refund =
        (row.refund_id && byRefund.get(row.refund_id)) ||
        (row.source_id && byRefund.get(row.source_id)) ||
        null;
      if (!refund) {
        lines.push({
          row,
          kind,
          status: 'unmatched',
          reference_type: null,
          reference_id: null,
          difference_minor: row.gross_minor,
        });
        discrepancies.push({
          ...base,
          kind: 'unmatched_charge',
          balance_transaction_id: row.balance_transaction_id,
          provider_reference: row.refund_id ?? row.source_id,
          actual_minor: row.gross_minor,
          difference_minor: row.gross_minor,
        });
        continue;
      }
      storeId ??= refund.store_id;
      seen('refunds', refund.issued_at);
      covered.add(refund.provider_refund_id!);
      if (-row.gross_minor !== refund.amount_minor || row.currency !== refund.currency) {
        const diff = -row.gross_minor - refund.amount_minor;
        lines.push({
          row,
          kind,
          status: 'amount_mismatch',
          reference_type: 'refund',
          reference_id: refund.refund_id,
          difference_minor: diff,
        });
        discrepancies.push({
          ...base,
          kind: 'amount_difference',
          balance_transaction_id: row.balance_transaction_id,
          provider_reference: refund.provider_refund_id,
          reference_type: 'refund',
          reference_id: refund.refund_id,
          expected_minor: refund.amount_minor,
          actual_minor: -row.gross_minor,
          difference_minor: diff,
        });
        continue;
      }
      lines.push({
        row,
        kind,
        status: 'matched',
        reference_type: 'refund',
        reference_id: refund.refund_id,
        difference_minor: 0,
      });
      continue;
    }
    // fee / adjustment / other: the ledger has no counterpart; it changes the payout total, so it is reported
    lines.push({
      row,
      kind,
      status: 'unmatched',
      reference_type: null,
      reference_id: null,
      difference_minor: row.net_minor,
    });
    discrepancies.push({
      ...base,
      kind: 'unmatched_charge',
      balance_transaction_id: row.balance_transaction_id,
      provider_reference: row.source_id,
      actual_minor: row.net_minor,
      difference_minor: row.net_minor,
    });
  }

  if (sumNet !== report.amount_minor) {
    discrepancies.push({
      ...base,
      kind: 'amount_difference',
      reference_type: 'payout',
      reference_id: report.payout_id,
      expected_minor: sumNet,
      actual_minor: report.amount_minor,
      difference_minor: report.amount_minor - sumNet,
    });
  }

  // ledger lines in this payout's window that it does not carry
  const inWindow = (type: keyof LedgerWindow, at: string): boolean => {
    const end = windowEnd[type];
    const start = input.windowStart[type];
    return end !== null && at <= end && (start === null || at > start);
  };
  {
    for (const p of input.payments) {
      if (!p.provider_payment_id || !inWindow('payments', p.captured_at)) continue;
      if (covered.has(p.provider_payment_id)) continue;
      discrepancies.push({
        ...base,
        kind: 'unmatched_ledger_line',
        provider_reference: p.provider_payment_id,
        reference_type: 'payment',
        reference_id: p.payment_id,
        expected_minor: p.amount_minor,
        difference_minor: -p.amount_minor,
      });
    }
    for (const r of input.refunds) {
      if (!r.provider_refund_id || !inWindow('refunds', r.issued_at)) continue;
      if (covered.has(r.provider_refund_id)) continue;
      discrepancies.push({
        ...base,
        kind: 'unmatched_ledger_line',
        provider_reference: r.provider_refund_id,
        reference_type: 'refund',
        reference_id: r.refund_id,
        expected_minor: -r.amount_minor,
        difference_minor: r.amount_minor,
      });
    }
  }

  return { lines, discrepancies, storeId, periodEnd, windowEnd };
}
