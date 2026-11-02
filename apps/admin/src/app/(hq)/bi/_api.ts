/**
 * BI report wrappers (#480, window 12) over the Admin API report operations (Admin API 0.4.19, #479 / #493).
 *
 * Window 4's `src/lib/api/admin.ts` stays untouched: this uses their `adminCall` transport and their operationId
 * convention, as window 17's `(hq)/marketing/_api.ts` does. Every amount comes back as integer minor units beside
 * its currency; nothing here sums across currencies.
 */

import 'server-only';

import type { operations } from '@platform/contracts/admin';
import { adminCall } from '@/lib/api/admin';
import { buildPath, type AdminResponse, type ApiResult } from '@/lib/api/admin-client';

/** An operation's JSON request body, from the generated contract. */
type AdminRequestBody<K extends keyof operations> = NonNullable<
  operations[K]['requestBody']
>['content']['application/json'];
import { getSession } from '@/lib/auth/current-session';
import { env } from '@/lib/env';
import type { MetricQuery } from './_lib/metrics';

// ---------------------------------------------------------------------------- metrics API (#603, Admin API 0.4.25)

/** `listMetrics` — the catalogue this principal may query: its stores, and finance metrics only with finance. */
export async function listMetrics(): Promise<ApiResult<AdminResponse<'listMetrics'>>> {
  return adminCall<'listMetrics'>({ path: '/admin/metrics' });
}

/**
 * `queryMetrics` — `viewer` on `store:*`. The server scopes every statement to the principal's stores; a
 * `filters.store_ids` entry outside them is a 403, and a finance metric without `finance` on organization:hq is
 * a 403 too. So a page asks for finance metrics only for principals that hold finance.
 */
export async function queryMetrics(
  body: MetricQuery,
): Promise<ApiResult<AdminResponse<'queryMetrics'>>> {
  return adminCall<'queryMetrics'>({ path: '/admin/metrics/query', method: 'POST', body });
}

export type MetricsCsv =
  | { ok: true; csv: string; truncated: boolean }
  | { ok: false; status: number; body: string; contentType: string };

/**
 * `queryMetrics` with `Accept: text/csv` (RFC 4180; the server guards formula injection and sets `X-Truncated`).
 * The JSON transport parses bodies, so this one reads text. An error stays the contract's JSON error, passed
 * through as it came.
 */
/**
 * `askMetrics` (#606, Admin API 0.4.27): BI Q&A. The server decides everything (scope, the per-store switch, the AI
 * budget); this forwards the caller's question with their token, and the browser's Accept-Language: the admin's
 * locale, the answer's language when the question's own cannot be told (bi-qa-answer@2; the core keeps only a
 * valid first tag, else `en`). The route handler passes it in from its own request: `next/headers` here would
 * throw outside a request scope (the contract tests call this wrapper directly).
 */
export async function askMetrics(
  body: AdminRequestBody<'askMetrics'>,
  acceptLanguage?: string | null,
): Promise<ApiResult<AdminResponse<'askMetrics'>>> {
  return adminCall<'askMetrics'>({
    path: '/admin/metrics/ask',
    method: 'POST',
    body,
    ...(acceptLanguage ? { headers: { 'accept-language': acceptLanguage } } : {}),
  });
}

/** `askMetricsFeedback` (Admin API 0.4.27): thumbs up/down, the asker only (204; 404 for anyone else). */
export async function askMetricsFeedback(
  conversationId: string,
  rating: 'up' | 'down',
): Promise<ApiResult<AdminResponse<'askMetricsFeedback'>>> {
  return adminCall<'askMetricsFeedback'>({
    path: buildPath('/admin/metrics/ask/{conversationId}/feedback', { conversationId }),
    method: 'POST',
    body: { rating },
  });
}

export async function queryMetricsCsv(body: MetricQuery): Promise<MetricsCsv> {
  const session = await getSession();
  const headers: Record<string, string> = {
    accept: 'text/csv',
    'content-type': 'application/json',
  };
  if (session?.accessToken) headers['authorization'] = `Bearer ${session.accessToken}`;
  let res: Response;
  try {
    res = await fetch(`${env.adminApiUrl}/admin/metrics/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      status: 503,
      body: JSON.stringify({ code: 'unavailable', message: 'The Admin API did not answer' }),
      contentType: 'application/json',
    };
  }
  const text = await res.text();
  if (!res.ok)
    return {
      ok: false,
      status: res.status,
      body: text,
      contentType: res.headers.get('content-type') ?? 'application/json',
    };
  return { ok: true, csv: text, truncated: res.headers.get('x-truncated') === 'true' };
}

// ---------------------------------------------------------------------------- report operations (#479)

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
