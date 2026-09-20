// The returns module's `RefundRequester` (core 2.5 seam, `setRefundRequester`), implemented on `createRefundIn`:
// a received return's refund becomes a `refund` row + `refund.issued` / `refund.failed` on the returns
// module's OWN transaction, and the returns module gets the refund id back to store on the return. It moves
// the order's `payment_status` itself afterwards (its `finishRefund`), so `transitionOrder: false` here —
// two writers of one field in one transaction would be a 409 on the second. Idempotent on the returns
// module's `return:<id>` key (stored as `<store_id>:return:<id>`), like every other refund.
import type { RefundRequest, RefundRequester, RefundResponse } from '../returns';
import { createRefundIn } from './refunds';

export const paymentsRefundRequester: RefundRequester = {
  async request(input: RefundRequest): Promise<RefundResponse> {
    const outcome = await createRefundIn(input.tx, {
      orderId: input.orderId,
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      reason: 'return',
      returnId: input.returnId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      requestedBy: input.actor.type === 'staff' ? input.actor.id : null,
      limitMinor: null,
      transitionOrder: false,
    });
    const { refund } = outcome;
    if (refund.status === 'failed') {
      return {
        status: 'failed',
        refundId: refund.id,
        failureReason: outcome.failureReason ?? 'refund failed',
      };
    }
    return { status: refund.status === 'pending' ? 'pending' : 'succeeded', refundId: refund.id };
  },
};
