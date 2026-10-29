/**
 * The BI route handlers' bodies (#604), shared by HQ (`/bi/live`, `/bi/export`) and the store view
 * (`/<storeId>/bi/live`, `/<storeId>/bi/export`). Tokens stay on the server: the browser polls these, never the
 * Admin API. Access is the API's to decide (every statement scoped to the principal's stores, another store a
 * 403); a handler only narrows to the store of the URL.
 */
import 'server-only';

import { queryMetrics, queryMetricsCsv } from '../_api';
import {
  forStore,
  liveQuery,
  moneyViewsQuery,
  periodQuery,
  topProductsQuery,
  type MetricQuery,
  type Window,
} from './metrics';
import { windowFrom } from './report';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** The live tiles' poll: today's live metrics (UTC), as the MetricResult, or the API's error with its status. */
export async function liveResponse(storeId?: string): Promise<Response> {
  const r = await queryMetrics(forStore(liveQuery(), storeId));
  return r.ok ? json(200, r.data) : json(r.status || 503, r.error);
}

/**
 * The tables a dashboard can export, each the SAME query the table on the page is drawn from (so the same scope
 * and the same rows): the period table, the money views (finance metrics: the API answers 403 for a principal
 * without finance, which the page never offers the link to) and top products.
 */
export const EXPORT_TABLES = {
  period: periodQuery,
  money: moneyViewsQuery,
  products: (w: Window) => topProductsQuery(w),
} as const satisfies Record<string, (w: Window) => MetricQuery>;
export type ExportTable = keyof typeof EXPORT_TABLES;

const isExportTable = (t: string | null): t is ExportTable =>
  t !== null && Object.hasOwn(EXPORT_TABLES, t);

/** A CSV file name that says what is in it: `bi-<table>-<scope>-<from>-to-<to>.csv` (end exclusive). */
export function exportFileName(
  table: ExportTable,
  scope: string,
  from: string,
  to: string,
): string {
  return `bi-${table}-${scope.replace(/[^a-z0-9-]/gi, '')}-${from}-to-${to}.csv`;
}

/** `?table=period|money|products&from=&to=` as a CSV download (default: the period table). */
export async function exportResponse(url: URL, storeId?: string): Promise<Response> {
  const window = windowFrom({
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  const asked = url.searchParams.get('table');
  if (asked !== null && !isExportTable(asked))
    return json(400, {
      code: 'validation_error',
      message: `table must be one of ${Object.keys(EXPORT_TABLES).join(', ')}`,
      details: { field: 'table' },
    });
  const table: ExportTable = asked ?? 'period';
  const r = await queryMetricsCsv(forStore(EXPORT_TABLES[table](window), storeId));
  if (!r.ok)
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': r.contentType, 'cache-control': 'no-store' },
    });
  return new Response(r.csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFileName(table, storeId ?? 'hq', window.from, window.to)}"`,
      'x-truncated': String(r.truncated),
      'cache-control': 'no-store',
    },
  });
}
