/**
 * The BI route handlers' bodies (#604, #606), shared by HQ (`/bi/live`, `/bi/export`, `/bi/ask`, `/bi/query`) and the
 * store view (`/<storeId>/bi/…`). Tokens stay on the server: the browser polls these, never the
 * Admin API. Access is the API's to decide (every statement scoped to the principal's stores, another store a
 * 403); a handler only narrows to the store of the URL.
 */
import 'server-only';

import { askMetrics, askMetricsFeedback, queryMetrics, queryMetricsCsv } from '../_api';
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

// ---- BI Q&A (#606) ------------------------------------------------------------------------------------------------

const passthrough = (r: { status: number; body: string }) =>
  new Response(r.status === 204 ? null : r.body, {
    status: r.status,
    headers:
      r.status === 204
        ? { 'cache-control': 'no-store' }
        : { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const badRequest = (message: string, field: string) =>
  json(400, { code: 'validation_error', message, details: { field } });

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await request.json()) as unknown;
    return b !== null && typeof b === 'object' && !Array.isArray(b)
      ? (b as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** POST <base>/ask {question, from?, to?}: asks the server; the store view narrows to its store. */
export async function askResponse(request: Request, storeId?: string): Promise<Response> {
  const b = await bodyOf(request);
  const question = typeof b?.question === 'string' ? b.question.trim() : '';
  if (question.length === 0 || question.length > 500)
    return badRequest('question must be 1 to 500 characters', 'question');
  const day = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  const from = day(b?.from);
  const to = day(b?.to);
  return passthrough(
    await askMetrics({
      question,
      ...(storeId ? { store_ids: [storeId] } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }),
  );
}

/** POST <base>/ask/<conversationId>/feedback {rating}: the asker's thumbs up or down. */
export async function askFeedbackResponse(
  request: Request,
  conversationId: string,
): Promise<Response> {
  const rating = (await bodyOf(request))?.rating;
  if (rating !== 'up' && rating !== 'down')
    return badRequest('rating must be up or down', 'rating');
  return passthrough(await askMetricsFeedback(conversationId, rating));
}

/** POST <base>/query {MetricQuery}: an answer's query, edited by the user, run as is (no AI) — scoped by the server. */
export async function editedQueryResponse(request: Request, storeId?: string): Promise<Response> {
  const b = await bodyOf(request);
  if (!b) return badRequest('the body must be a metrics query', 'body');
  const r = await queryMetrics(forStore(b as unknown as MetricQuery, storeId));
  return r.ok ? json(200, r.data) : json(r.status || 503, r.error);
}
