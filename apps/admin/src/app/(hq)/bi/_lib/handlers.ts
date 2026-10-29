/**
 * The BI route handlers' bodies (#604), shared by HQ (`/bi/live`, `/bi/export`) and the store view
 * (`/<storeId>/bi/live`, `/<storeId>/bi/export`). Tokens stay on the server: the browser polls these, never the
 * Admin API. Access is the API's to decide (every statement scoped to the principal's stores, another store a
 * 403); a handler only narrows to the store of the URL.
 */
import 'server-only';

import { queryMetrics, queryMetricsCsv } from '../_api';
import { forStore, liveQuery, periodQuery } from './metrics';
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

/** A CSV file name that says what is in it: `bi-<scope>-<from>-to-<to>.csv` (end exclusive, like the window). */
export function exportFileName(scope: string, from: string, to: string): string {
  return `bi-${scope.replace(/[^a-z0-9-]/gi, '')}-${from}-to-${to}.csv`;
}

/** The period dashboard (bookings, refunds, refund rate per store and day) as a CSV download. */
export async function exportResponse(url: URL, storeId?: string): Promise<Response> {
  const window = windowFrom({
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  const r = await queryMetricsCsv(forStore(periodQuery(window), storeId));
  if (!r.ok)
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': r.contentType, 'cache-control': 'no-store' },
    });
  return new Response(r.csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFileName(storeId ?? 'hq', window.from, window.to)}"`,
      'x-truncated': String(r.truncated),
      'cache-control': 'no-store',
    },
  });
}
