// Refund seam of the returns module (issue #107). The default requester is "manual": it calls the checkout's
// PaymentProvider.refund for the payment's provider and returns no refund id — the `refund` table and the
// `refund.issued` / `refund.failed` events are window 7's (docs/domain.md), written by the requester window 7
// registers with setRefundRequester() at boot, which returns the id the return then stores.
//
// Idempotency per return: the key is `return:<return_id>`, and the returns module records the outcome on the
// return row (`refund_id`, `metadata.refund`) inside the same transaction, so a retry after a provider timeout
// finds the recorded outcome and never asks twice. Requesters must also honour the key on their side.
import { paymentProvider } from '../../lib/payment-seam';
import type { RefundRequest, RefundRequester, RefundResponse } from './types';

export const manualRefundRequester: RefundRequester = {
  async request(input: RefundRequest): Promise<RefundResponse> {
    const provider = paymentProvider(input.provider);
    if (!provider) {
      return {
        status: 'failed',
        refundId: null,
        failureReason: `provider ${input.provider} not registered`,
      };
    }
    const result = await provider.refund({
      tx: input.tx,
      organizationId: input.organizationId,
      storeId: input.storeId,
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    });
    if (result.status === 'succeeded') return { status: 'succeeded', refundId: null };
    // asynchronous settlement: the return stays `received` with a pending outcome until markReturnRefunded
    if (result.status === 'pending') return { status: 'pending', refundId: null };
    return { status: 'failed', refundId: null, failureReason: result.failureReason };
  },
};

let requester: RefundRequester = manualRefundRequester;

/** Registers window 7's requester (returns the previous one so tests can restore it). */
export function setRefundRequester(next: RefundRequester): RefundRequester {
  const previous = requester;
  requester = next;
  return previous;
}

export function currentRefundRequester(): RefundRequester {
  return requester;
}

export const refundKeyFor = (returnId: string) => `return:${returnId}`;
