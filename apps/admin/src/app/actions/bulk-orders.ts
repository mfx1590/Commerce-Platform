'use server';

import { cancelOrder, getOrder, listOrders } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { orderCancelSchema } from '@/lib/forms/schemas';
import { cancelledMessage } from '@/lib/orders/cancel-outcome';
import { outcomeOf, type BulkReport, type BulkSelection, type RowOutcome } from '@/lib/table/bulk';
import { runStoreBulkAction } from '@/lib/table/bulk-server';
import { ORDER_FILTER_KEYS } from '@/app/(store)/[storeId]/orders/orders-table.config';

type OrderSummary = AdminComponents['OrderSummary'];

/**
 * Bulk cancel on the orders table (#870 wave 1 item 2): one `cancelOrder` per row with the same
 * reason (store_admin on the store), through `runStoreBulkAction`.
 *
 * Status before vs after (#904 review): the core answers 200 for an order that is ALREADY
 * cancelled, so the status before is read first — from the row the list returned ("all
 * matching"), or with `getOrder` for a ticked id — and an order already cancelled is not cancelled
 * again: it is reported "Already cancelled" (skipped). A cancelled order's message comes from the
 * `payment_status` the API returned. A 409 (e.g. fulfilled) is skipped in the API's words; an
 * unknown outcome is never retried.
 */
export async function bulkCancelOrdersAction(
  storeId: string,
  selection: BulkSelection,
  reason: string,
): Promise<ActionResult<BulkReport>> {
  const parsed = orderCancelSchema.safeParse({ reason: reason.trim() });
  if (!parsed.success) {
    return actionError({ fieldErrors: {}, formError: 'Say why the orders are cancelled.' });
  }
  return runStoreBulkAction<OrderSummary>({
    operation: 'cancelOrder',
    storeId,
    selection,
    filterKeys: ORDER_FILTER_KEYS,
    idOf: (order) => order.id,
    labelOf: (order) => `#${order.display_id}`,
    listPage: (filters) => (page, limit) => listOrders(storeId, { ...filters, page, limit }),
    perRow: async (orderId, row) => {
      let before: { status: string; display_id: number } | null = row;
      if (before === null) {
        const read = await getOrder(storeId, orderId);
        if (!read.ok) return outcomeOf(read, '');
        before = read.data;
      }
      const label = `#${before.display_id}`;
      if (before.status === 'cancelled') {
        return { outcome: 'skipped' as RowOutcome, message: 'Already cancelled.', label };
      }
      const result = await cancelOrder(storeId, orderId, parsed.data);
      if (!result.ok) return { ...outcomeOf(result, ''), label };
      return {
        outcome: 'done' as RowOutcome,
        message: cancelledMessage(result.data.payment_status),
        label: `#${result.data.display_id}`,
      };
    },
    revalidate: [`/${storeId}/orders`],
  });
}
