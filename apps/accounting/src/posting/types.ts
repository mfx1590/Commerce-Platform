// Shapes the pure posting functions produce. Money is integer minor units; a line is either a debit or a credit.
import type { AccountCode } from '../chart.js';

export type Journal = 'sales' | 'psp_fees' | 'refunds' | 'cogs' | 'tax' | 'shipping' | 'bank';
export type ReferenceType = 'order' | 'payment' | 'refund' | 'shipment';

export interface JournalLine {
  account_code: AccountCode;
  currency: string;
  debit_minor: number;
  credit_minor: number;
}

/** One balanced journal entry: the ledger_entry rows of one event in one journal, debits = credits per currency. */
export interface JournalEntry {
  journal: Journal;
  /** YYYY-MM-DD (UTC) of the fact: placed_at, captured_at, shipped_at, issued_at, cancelled_at. */
  entry_date: string;
  legal_entity_id: string;
  /** The store whose fact caused the line; NULL for a legal-entity-level line (a payout, a bank movement). */
  store_id: string | null;
  source_event_id: string;
  source_topic: string;
  reference_type: ReferenceType;
  reference_id: string;
  lines: JournalLine[];
}

/** The ledger's own projection of an order (accounting_order + accounting_order_line), built from order.placed. */
export interface OrderProjectionLine {
  order_line_item_id: string;
  quantity: number;
  /** total_minor − tax_minor of the line: net of VAT in both price modes. */
  net_minor: number;
  shipped_quantity: number;
  /** floor(net × shipped / quantity) so far. */
  released_minor: number;
}

export interface OrderProjection {
  order_id: string;
  organization_id: string;
  store_id: string;
  legal_entity_id: string;
  display_id: number;
  currency: string;
  total_minor: number;
  tax_minor: number;
  goods_net_minor: number;
  shipping_net_minor: number;
  goods_released_minor: number;
  shipping_released: boolean;
  status: 'placed' | 'cancelled';
  placed_at: string;
  cancelled_at: string | null;
  source_event_id: string;
  lines: OrderProjectionLine[];
}

export interface PaymentProjection {
  payment_id: string;
  order_id: string;
  organization_id: string;
  store_id: string;
  legal_entity_id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_minor: number;
  fee_minor: number;
  currency: string;
  captured_at: string;
  source_event_id: string;
}

export interface RefundProjection {
  refund_id: string;
  payment_id: string;
  order_id: string;
  organization_id: string;
  store_id: string;
  legal_entity_id: string;
  provider_refund_id: string | null;
  amount_minor: number;
  currency: string;
  reason: 'return' | 'cancellation' | 'goodwill' | 'chargeback';
  issued_at: string;
  source_event_id: string;
}

/** What one event posts and what it changes in the projections; the handler persists all of it in one transaction. */
export interface PostingResult {
  entries: JournalEntry[];
  order?: OrderProjection;
  payment?: PaymentProjection;
  refund?: RefundProjection;
}
