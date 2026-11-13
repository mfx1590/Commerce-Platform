'use server';

import { archiveProduct, listProducts, publishProduct } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';
import { outcomeOf, type BulkReport, type BulkSelection } from '@/lib/table/bulk';
import { runStoreBulkAction } from '@/lib/table/bulk-server';
import { PRODUCT_FILTER_KEYS } from '@/app/(store)/[storeId]/catalog/products-table.config';

type Product = AdminComponents['Product'];

/**
 * Bulk publish and archive on the catalog table (#870 wave 1 item 2): one `publishProduct` /
 * `archiveProduct` per row (the API has no bulk operation), through `runStoreBulkAction` — refused
 * up front and per row, the selection resolved here with the table's own filters, every row
 * reported.
 */
const products = {
  filterKeys: PRODUCT_FILTER_KEYS,
  idOf: (product: Product) => product.id,
  labelOf: (product: Product) => product.title,
};

export async function bulkPublishProductsAction(
  storeId: string,
  selection: BulkSelection,
): Promise<ActionResult<BulkReport>> {
  return runStoreBulkAction<Product>({
    ...products,
    operation: 'publishProduct',
    storeId,
    selection,
    listPage: (filters) => (page, limit) => listProducts(storeId, { ...filters, page, limit }),
    perRow: async (productId) => {
      const result = await publishProduct(storeId, productId);
      return {
        ...outcomeOf(result, 'Published.'),
        ...(result.ok ? { label: result.data.title } : {}),
      };
    },
    revalidate: [`/${storeId}/catalog`],
  });
}

export async function bulkArchiveProductsAction(
  storeId: string,
  selection: BulkSelection,
): Promise<ActionResult<BulkReport>> {
  return runStoreBulkAction<Product>({
    ...products,
    operation: 'archiveProduct',
    storeId,
    selection,
    listPage: (filters) => (page, limit) => listProducts(storeId, { ...filters, page, limit }),
    perRow: async (productId) => outcomeOf(await archiveProduct(storeId, productId), 'Archived.'),
    revalidate: [`/${storeId}/catalog`],
  });
}
