// refund.issued → money goes back through the PSP.
//
//   refunds (reference = refund)
//     reason `cancellation` — the sale was already reversed by order.cancelled, so the refund settles the customer's
//     credit balance:
//       Dr 1200 Accounts receivable   amount_minor
//       Cr 1100 PSP clearing          amount_minor
//     reason `return` | `goodwill` | `chargeback` — revenue and VAT are reversed in the order's own proportion
//     (tax part = round-half-up(amount × order tax / order total), from the projection):
//       Dr 4090 Refunds and allowances  amount − tax part
//       Dr 2200 VAT payable             tax part
//       Cr 1100 PSP clearing            amount_minor
//     on a CANCELLED order (#919) only the shipped value not yet refunded is reversed that way; the rest of the
//     amount settles the customer's credit the cancellation created, like a cancellation refund (Dr 1200). That is
//     what the cancellation would have taken into account had the refund arrived first, so both arrival orders net
//     the same.
//
// The PSP keeps its fee on a refund (Stripe does), so the fee stays where payment.captured put it. Chargebacks: no
// dispute event exists yet; a refund with reason `chargeback` posts like a return (CONTRACT CHANGE filed for the
// dispute event, out of the Phase 4 gate).
import type { EventEnvelope } from '@platform/events';
import { ACCOUNT } from '../chart.js';
import { OrderProjectionMissingError } from '../errors.js';
import { dateOf, finalizeEntry, line, roundShare } from './balance.js';
import { shippedValueOf } from './order-cancelled.js';
import type { JournalLine, OrderProjection, PostingResult } from './types.js';

export function postRefundIssued(
  e: EventEnvelope<'refund.issued'>,
  order: OrderProjection | null,
): PostingResult {
  const p = e.payload;
  const storeId = e.store_id ?? order?.store_id;
  if (!storeId) throw new TypeError(`refund.issued ${e.event_id} has no store_id`);
  const cur = p.currency;

  let lines: (JournalLine | null)[];
  let nextOrder: OrderProjection | undefined;
  if (p.reason === 'cancellation') {
    lines = [
      line(ACCOUNT.RECEIVABLE, cur, p.amount_minor, 'debit'),
      line(ACCOUNT.PSP_CLEARING, cur, p.amount_minor, 'credit'),
    ];
  } else {
    if (!order) throw new OrderProjectionMissingError(p.order_id, e.topic);
    // #919: on a cancelled order only the shipped value not yet refunded is a sale reversal
    const onSale =
      order.status === 'cancelled'
        ? Math.min(
            p.amount_minor,
            Math.max(
              shippedValueOf(order) - order.refunded_net_minor - order.refunded_tax_minor,
              0,
            ),
          )
        : p.amount_minor;
    const taxPart =
      order.total_minor > 0 ? roundShare(onSale, order.tax_minor, order.total_minor) : 0;
    lines = [
      line(ACCOUNT.REFUNDS, cur, onSale - taxPart, 'debit'),
      line(ACCOUNT.VAT_PAYABLE, cur, taxPart, 'debit'),
      line(ACCOUNT.RECEIVABLE, cur, p.amount_minor - onSale, 'debit'),
      line(ACCOUNT.PSP_CLEARING, cur, p.amount_minor, 'credit'),
    ];
    nextOrder = {
      ...order,
      refunded_net_minor: order.refunded_net_minor + onSale - taxPart,
      refunded_tax_minor: order.refunded_tax_minor + taxPart,
    };
  }

  const entry = finalizeEntry({
    journal: 'refunds',
    entry_date: dateOf(p.issued_at),
    legal_entity_id: p.legal_entity_id,
    store_id: storeId,
    source_event_id: e.event_id,
    source_topic: e.topic,
    reference_type: 'refund',
    reference_id: p.refund_id,
    lines,
  });
  return {
    entries: [entry],
    ...(nextOrder ? { order: nextOrder } : {}),
    refund: {
      refund_id: p.refund_id,
      payment_id: p.payment_id,
      order_id: p.order_id,
      organization_id: e.organization_id,
      store_id: storeId,
      legal_entity_id: p.legal_entity_id,
      provider_refund_id: p.provider_refund_id,
      amount_minor: p.amount_minor,
      currency: cur,
      reason: p.reason,
      issued_at: p.issued_at,
      source_event_id: e.event_id,
    },
  };
}
