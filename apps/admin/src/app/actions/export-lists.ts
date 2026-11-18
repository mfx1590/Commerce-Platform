'use server';

import { listOrders, listProducts } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';
import { exportStoreList, type CsvExport } from '@/lib/table/export-server';
import {
  PRODUCTS_SORTABLE_COLUMNS,
  PRODUCT_FILTER_KEYS,
} from '@/app/(store)/[storeId]/catalog/products-table.config';
import {
  ORDERS_SORTABLE_COLUMNS,
  ORDER_FILTER_KEYS,
} from '@/app/(store)/[storeId]/orders/orders-table.config';

type Product = AdminComponents['Product'];
type OrderSummary = AdminComponents['OrderSummary'];
type Sort = { sort: string | null; order: 'asc' | 'desc' };

/**
 * "Export CSV" of the catalog and orders tables as they are filtered and sorted (#870 wave 1
 * item 2): the store section checked first (the same rule as the page), the list paged through up
 * to the cap, the file built on the server. Money is written in minor units with its currency, so
 * nothing is lost to rounding or a locale's decimal mark.
 */

export async function exportProductsCsvAction(
  storeId: string,
  filters: Record<string, string>,
  sort: Sort,
): Promise<ActionResult<CsvExport>> {
  return exportStoreList<Product>({
    storeId,
    sectionId: 'catalog',
    filters,
    filterKeys: PRODUCT_FILTER_KEYS,
    sort,
    sortKeys: PRODUCTS_SORTABLE_COLUMNS,
    listPage: (query) => listProducts(storeId, query),
    header: ['id', 'title', 'handle', 'status', 'variants', 'published_at', 'updated_at'],
    toRow: (product) => [
      product.id,
      product.title,
      product.handle,
      product.status,
      product.variants.length,
      product.published_at,
      product.updated_at,
    ],
  });
}

export async function exportOrdersCsvAction(
  storeId: string,
  filters: Record<string, string>,
  sort: Sort,
): Promise<ActionResult<CsvExport>> {
  return exportStoreList<OrderSummary>({
    storeId,
    sectionId: 'orders',
    filters,
    filterKeys: ORDER_FILTER_KEYS,
    sort,
    sortKeys: ORDERS_SORTABLE_COLUMNS,
    listPage: (query) => listOrders(storeId, query),
    header: [
      'id',
      'order',
      'placed_at',
      'email',
      'status',
      'payment_status',
      'fulfillment_status',
      'total_minor',
      'currency',
    ],
    toRow: (order) => [
      order.id,
      order.display_id,
      order.placed_at,
      order.email,
      order.status,
      order.payment_status,
      order.fulfillment_status,
      order.total.amount_minor,
      order.total.currency,
    ],
  });
}
