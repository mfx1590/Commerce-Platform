import type { Queryable } from '@platform/db';
import type { AdminComponents } from '@platform/contracts';
import type { Actor } from '../../lib/audit';

export type AdminReturn = AdminComponents['schemas']['Return'];
export type ReturnStatus = AdminReturn['status'];
export type ReturnCondition = 'resellable' | 'damaged';

export interface RequestedItem {
  order_line_item_id: string;
  quantity: number;
}

export interface ReceivedItem extends RequestedItem {
  condition: ReturnCondition;
}

export interface RequestReturnInput {
  items: readonly RequestedItem[];
  reason?: string | null | undefined;
  actor: Actor;
}

export interface ReceiveReturnInput {
  warehouseId: string;
  items: readonly ReceivedItem[];
  actor: Actor;
  /** Test seams: run inside the transaction after the given step (a throw must roll everything back). */
  hooks?: { afterEvents?: ((tx: Queryable) => Promise<void>) | undefined } | undefined;
}

// ---- refund seam (window 7 registers its requester; the default is manual) ----

export interface RefundRequest {
  tx: Queryable;
  organizationId: string;
  storeId: string;
  orderId: string;
  returnId: string;
  /** The captured payment the refund goes against. */
  paymentId: string;
  provider: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  reason: 'return';
  /** Per return: `return:<return_id>` — a retry after a timeout must not refund twice. */
  idempotencyKey: string;
  actor: Actor;
}

export interface RefundResponse {
  status: 'succeeded' | 'failed' | 'pending';
  /** `refund.id` when the requester wrote window 7's row (the default manual requester writes none). */
  refundId: string | null;
  failureReason?: string | undefined;
}

/**
 * Hands a return's refund to the payments side. The returns module never writes the `refund` table nor emits
 * `refund.issued` / `refund.failed` (window 7's, docs/domain.md): the requester does, and returns the id.
 * Must be idempotent on `idempotencyKey` (one key per return).
 */
export interface RefundRequester {
  request(input: RefundRequest): Promise<RefundResponse>;
}

// ---- rows ----

export interface ReturnRow {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string;
  status: ReturnStatus;
  reason: string | null;
  warehouse_id: string | null;
  refund_id: string | null;
  requested_at: Date;
  received_at: Date | null;
  metadata: Record<string, unknown>;
}

export interface ReturnItemRow {
  id: string;
  order_line_item_id: string;
  quantity: number;
  condition: ReturnCondition | null;
}
