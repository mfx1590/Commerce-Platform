import type { AdminComponents } from '../api/admin-client';

type Order = AdminComponents['Order'];

/**
 * What cancelling did to the money, from the `payment_status` the API RETURNED for the cancelled
 * order (#904 review). Cancelling voids an authorisation; it never refunds a captured payment, so
 * those rows say "refund needed" — the bulk results CSV is the refund worklist. Pure.
 */
export function cancelledMessage(paymentStatus: Order['payment_status']): string {
  switch (paymentStatus) {
    case 'voided':
      return 'Cancelled — authorisation voided.';
    case 'captured':
    case 'partially_refunded':
      return 'Cancelled — payment captured, refund needed.';
    case 'refunded':
      return 'Cancelled — payment already refunded.';
    default:
      return `Cancelled — no payment taken (${paymentStatus}).`;
  }
}
