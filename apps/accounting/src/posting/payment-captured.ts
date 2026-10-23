// payment.captured → the PSP holds the money for us (net of its fee), the customer no longer owes it.
//
//   psp_fees (reference = payment)
//     Dr 1100 PSP clearing      amount_minor − fee_minor
//     Dr 6100 PSP fees          fee_minor                 (null fee = 0; #549 matches the real fee from the payout report)
//     Cr 1200 Accounts receivable  amount_minor
import type { EventEnvelope } from '@platform/events';
import { ACCOUNT } from '../chart.js';
import { dateOf, finalizeEntry, line } from './balance.js';
import type { PostingResult } from './types.js';

export function postPaymentCaptured(e: EventEnvelope<'payment.captured'>): PostingResult {
  const p = e.payload;
  const storeId = e.store_id;
  if (!storeId) throw new TypeError(`payment.captured ${e.event_id} has no store_id`);
  const fee = p.fee_minor ?? 0;
  const entry = finalizeEntry({
    journal: 'psp_fees',
    entry_date: dateOf(p.captured_at),
    legal_entity_id: p.legal_entity_id,
    store_id: storeId,
    source_event_id: e.event_id,
    source_topic: e.topic,
    reference_type: 'payment',
    reference_id: p.payment_id,
    lines: [
      line(ACCOUNT.PSP_CLEARING, p.currency, p.amount_minor - fee, 'debit'),
      line(ACCOUNT.PSP_FEES, p.currency, fee, 'debit'),
      line(ACCOUNT.RECEIVABLE, p.currency, p.amount_minor, 'credit'),
    ],
  });
  return {
    entries: [entry],
    payment: {
      payment_id: p.payment_id,
      order_id: p.order_id,
      organization_id: e.organization_id,
      store_id: storeId,
      legal_entity_id: p.legal_entity_id,
      provider: p.provider,
      provider_payment_id: p.provider_payment_id,
      amount_minor: p.amount_minor,
      fee_minor: fee,
      currency: p.currency,
      captured_at: p.captured_at,
      source_event_id: e.event_id,
    },
  };
}
