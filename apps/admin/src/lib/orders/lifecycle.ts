import type { AdminComponents } from '../api/admin-client';

type OrderStatus = AdminComponents['Order']['status'];

/**
 * What each `Order.status` means since the core reports the lifecycle decided on #350 (contracts
 * 0.4.11, documented on the `Order` schema). The header shows the status the core sends — never
 * one derived here from payments or shipments — and this line says what it means.
 */
const MEANING: Record<OrderStatus, string> = {
  pending: 'Placed; payment not yet authorised.',
  confirmed: 'Payment authorised; fulfilment not started.',
  processing: 'Fulfilment started: a shipment has left planned.',
  completed: 'Every shipment has been delivered.',
  cancelled: 'Cancelled by staff.',
};

export function orderStatusMeaning(status: OrderStatus): string {
  return MEANING[status];
}

/** A payment the store can capture: authorised, and not yet captured, failed or cancelled. */
export function capturable(payment: AdminComponents['Payment']): boolean {
  return payment.status === 'authorized';
}
