import type { TableQueryDefaults } from '@/lib/table/query-state';

/**
 * Plain module, not the `'use client'` one — a constant exported from a client module and imported
 * by a server component becomes a client reference (see `stores-table.config.ts`).
 */

/** `listOrders` in Admin API 0.4.5 sorts by exactly these. */
export const ORDERS_SORTABLE_COLUMNS = ['placed_at', 'display_id', 'total', 'status'] as const;

/** The contract's own filter parameters — anything else would be a 400. */
export const ORDER_FILTER_KEYS = [
  'q',
  'status',
  'payment_status',
  'fulfillment_status',
  'placed_from',
  'placed_to',
] as const;

export const ORDERS_TABLE_DEFAULTS: TableQueryDefaults = { sort: 'placed_at', order: 'desc' };

/** The three status enums from `OrderSummary`, for the filters and the pills. */
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'completed',
  'cancelled',
] as const;
export const PAYMENT_STATUSES = [
  'awaiting',
  'authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
] as const;
export const FULFILLMENT_STATUSES = [
  'unfulfilled',
  'partially_fulfilled',
  'fulfilled',
  'partially_returned',
  'returned',
] as const;

export type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/**
 * Status → pill tone. Status is encoded as a pill with its name (the brief: never colour alone);
 * the tone is a second cue. `ok`/`warn`/`critical` are the semantic tokens, separate from the accent.
 */
export const STATUS_TONES: Record<string, PillTone> = {
  // order
  pending: 'neutral',
  confirmed: 'success',
  processing: 'accent',
  completed: 'success',
  cancelled: 'danger',
  // payment
  awaiting: 'neutral',
  authorized: 'warning',
  captured: 'success',
  partially_refunded: 'warning',
  refunded: 'neutral',
  failed: 'danger',
  // fulfilment + shipment
  unfulfilled: 'neutral',
  partially_fulfilled: 'warning',
  fulfilled: 'success',
  partially_returned: 'warning',
  returned: 'neutral',
  picking: 'accent',
  packed: 'accent',
  label_created: 'accent',
  shipped: 'success',
  in_transit: 'accent',
  delivered: 'success',
  // refund + return
  succeeded: 'success',
  requested: 'warning',
  approved: 'accent',
  received: 'success',
  rejected: 'danger',
};

export function toneFor(status: string): PillTone {
  return STATUS_TONES[status] ?? 'neutral';
}

/** `pending`/`processing` read better with the underscore gone. */
export function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}
