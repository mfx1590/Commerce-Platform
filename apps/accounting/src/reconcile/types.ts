// PSP payout reconciliation (#549): the shapes a payout report has once a source normalised it, and what the matcher
// says about it. Money is integer minor units everywhere; the fixture files use the same integers (Stripe's API does;
// Stripe's CSV export uses decimals, which a CSV source converts).

/** One row of Stripe's itemized payout reconciliation report / `GET /v1/balance_transactions?payout=po_…`. */
export interface BalanceTransactionRow {
  /** Stripe `txn_…` */
  balance_transaction_id: string;
  /** charge | refund | payout | fee | adjustment | … (Stripe's reporting_category, lower-case) */
  reporting_category: string;
  currency: string;
  /** Stripe `amount` / `gross`: positive for a charge, negative for a refund. */
  gross_minor: number;
  /** Stripe `fee`: positive on a charge, 0 on a refund (Stripe keeps its fee). */
  fee_minor: number;
  /** gross − fee */
  net_minor: number;
  /** YYYY-MM-DD */
  available_on: string;
  created: string;
  /** The charge (`ch_…`) or refund (`re_…`) the transaction settles (Stripe `source`). */
  source_id: string | null;
  /** From the itemized report: the PaymentIntent of a charge — what payment.captured carries as provider_payment_id. */
  payment_intent_id: string | null;
  charge_id: string | null;
  refund_id: string | null;
  description?: string | null;
}

export interface PayoutSummary {
  /** Stripe `po_…` */
  payout_id: string;
  legal_entity_id: string;
  provider: string;
  currency: string;
  /** What reached the bank. */
  amount_minor: number;
  /** YYYY-MM-DD */
  arrival_date: string;
  status: 'paid' | 'pending' | 'in_transit' | 'failed' | 'canceled';
}

export interface PayoutReport extends PayoutSummary {
  balance_transactions: BalanceTransactionRow[];
}

/** Where payout reports come from: fixture files now, the Stripe API later (same interface). */
export interface PayoutSource {
  readonly name: string;
  listPayouts(legalEntityId: string): Promise<PayoutSummary[]>;
  payout(legalEntityId: string, payoutId: string): Promise<PayoutReport>;
}

export type DiscrepancyKind =
  /** a charge or refund row of the report with no ledger counterpart */
  | 'unmatched_charge'
  /** a capture or refund in the ledger (available by the payout's period) that no payout row covers */
  | 'unmatched_ledger_line'
  /** matched, but the PSP fee differs from the fee payment.captured carried */
  | 'fee_difference'
  /** matched, but the gross differs from the ledger amount — or the payout total differs from Σ net */
  | 'amount_difference';

/** One JSON line of the discrepancy report: ids and amounts only. */
export interface Discrepancy {
  reconcile: 'psp.payout';
  legal_entity_id: string;
  payout_id: string;
  kind: DiscrepancyKind;
  currency: string;
  balance_transaction_id?: string;
  provider_reference?: string | null;
  reference_type?: 'payment' | 'refund' | 'payout';
  reference_id?: string;
  expected_minor?: number;
  actual_minor?: number;
  difference_minor: number;
}

export type MatchStatus = 'matched' | 'unmatched' | 'amount_mismatch' | 'fee_mismatch';

export interface MatchedLine {
  row: BalanceTransactionRow;
  kind: 'charge' | 'refund' | 'fee' | 'adjustment' | 'payout' | 'other';
  status: MatchStatus;
  reference_type: 'payment' | 'refund' | null;
  reference_id: string | null;
  /** PSP amount − ledger amount (gross for a mismatch, fee for a fee mismatch), 0 when matched. */
  difference_minor: number;
}

/** What the matcher needs from the ledger: the legal entity's captures and refunds by provider id. */
export interface LedgerPayment {
  payment_id: string;
  store_id: string;
  provider_payment_id: string | null;
  amount_minor: number;
  fee_minor: number;
  currency: string;
  captured_at: string;
}

export interface LedgerRefund {
  refund_id: string;
  store_id: string;
  provider_refund_id: string | null;
  amount_minor: number;
  currency: string;
  issued_at: string;
}

export interface ReconcileResult {
  payout_id: string;
  legal_entity_id: string;
  status: 'reconciled' | 'discrepant';
  /** true when the payout had been reconciled before: nothing was written. */
  already_reconciled: boolean;
  lines: number;
  matched: number;
  discrepancies: Discrepancy[];
  /** The bank entry was written in this call. */
  posted: boolean;
}
