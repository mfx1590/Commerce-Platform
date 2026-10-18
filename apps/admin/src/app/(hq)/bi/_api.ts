/**
 * BI report wrappers (#480, window 12) over the Admin API report operations (Admin API 0.4.19, #479 / #493).
 *
 * Window 4's `src/lib/api/admin.ts` stays untouched: this uses their `adminCall` transport and their operationId
 * convention, as window 17's `(hq)/marketing/_api.ts` does. Every amount comes back as integer minor units beside
 * its currency; nothing here sums across currencies.
 */

import 'server-only';

import { adminCall } from '@/lib/api/admin';
import { buildPath, type AdminResponse, type ApiResult } from '@/lib/api/admin-client';

export interface ReportWindow {
  from: string;
  to: string;
}

export type SalesReport = AdminResponse<'getHqSalesReport'>;
export type FinanceReport = AdminResponse<'getHqFinanceReport'>;
export type StockReport = AdminResponse<'getStoreStockReport'>;

/** `getHqSalesReport` — `analyst` on organization:hq; rows per store, day and currency. */
export async function getHqSalesReport(window: ReportWindow): Promise<ApiResult<SalesReport>> {
  return adminCall<'getHqSalesReport'>({
    path: '/admin/hq/reports/sales',
    query: { from: window.from, to: window.to },
  });
}

/** `getHqFinanceReport` — `finance` on organization:hq. Call it only for principals that hold finance. */
export async function getHqFinanceReport(window: ReportWindow): Promise<ApiResult<FinanceReport>> {
  return adminCall<'getHqFinanceReport'>({
    path: '/admin/hq/reports/finance',
    query: { from: window.from, to: window.to },
  });
}

/** `getStoreStockReport` — `viewer` on the store (HQ analysts inherit it); first page only in v1. */
export async function getStoreStockReport(
  storeId: string,
  limit = 20,
): Promise<ApiResult<StockReport>> {
  return adminCall<'getStoreStockReport'>({
    path: buildPath('/admin/stores/{storeId}/reports/stock', { storeId }),
    query: { page: 1, limit },
  });
}
