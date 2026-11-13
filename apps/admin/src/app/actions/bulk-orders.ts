'use server';

import { cancelOrder, listOrders } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { orderCancelSchema } from '@/lib/forms/schemas';
import { outcomeOf, type BulkReport, type BulkSelection } from '@/lib/table/bulk';
import { runStoreBulkAction } from '@/lib/table/bulk-server';
import { ORDER_FILTER_KEYS } from '@/app/(store)/[storeId]/orders/orders-table.config';

type OrderSummary = AdminComponents['OrderSummary'];

/**
 * Bulk cancel on the orders table (#870 wave 1 item 2): one `cancelOrder` per row with the same
 * reason (store_admin on the store), through `runStoreBulkAction`. An order the API will not cancel
 * (already cancelled, fulfilled — its 409) is reported as skipped with the API's words, not as a
 * failure; an unknown outcome is never retried.
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
    perRow: async (orderId) => {
      const result = await cancelOrder(storeId, orderId, parsed.data);
      return {
        ...outcomeOf(result, 'Cancelled.'),
        ...(result.ok ? { label: `#${result.data.display_id}` } : {}),
      };
    },
    revalidate: [`/${storeId}/orders`],
  });
}
