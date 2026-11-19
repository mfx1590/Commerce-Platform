import 'server-only';

import { adminCall } from '@/lib/api/admin';
import type { AdminResponse, ApiResult } from '@/lib/api/admin-client';
import { getSession } from '@/lib/auth/current-session';
import { env } from '@/lib/env';
import type { InventoryQuery, MetricQuery, MoversQuery } from './model';

/**
 * BI v2 wave 1 reads (#871, Admin API 0.4.30) over window 4's `adminCall`. `listMetrics` and
 * `queryMetrics` are the existing ones in `../_api.ts`. Read-only; the token stays on the server.
 */

export async function listMetricMovers(
  body: MoversQuery,
): Promise<ApiResult<AdminResponse<'listMetricMovers'>>> {
  return adminCall<'listMetricMovers'>({ path: '/admin/metrics/movers', method: 'POST', body });
}

export async function getInventoryHealth(
  body: InventoryQuery,
): Promise<ApiResult<AdminResponse<'getInventoryHealth'>>> {
  return adminCall<'getInventoryHealth'>({
    path: '/admin/metrics/inventory',
    method: 'POST',
    body,
  });
}

export type CsvAnswer =
  | { ok: true; csv: string; truncated: boolean }
  | { ok: false; status: number; error: { code: string; message: string } };

/**
 * The API's own CSV of a query (`Accept: text/csv`), with the label columns (`?labels=true`): the
 * same scope, rows and formula-injection guard as the JSON answer. `X-Truncated` is passed on.
 */
export async function metricsCsv(
  path: '/admin/metrics/query' | '/admin/metrics/inventory',
  body: MetricQuery | InventoryQuery,
): Promise<CsvAnswer> {
  const session = await getSession();
  const headers: Record<string, string> = {
    accept: 'text/csv',
    'content-type': 'application/json',
  };
  if (session?.accessToken) headers['authorization'] = `Bearer ${session.accessToken}`;
  let res: Response;
  try {
    res = await fetch(`${env.adminApiUrl}${path}?labels=true`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: 'network_error', message: 'The Admin API did not answer.' },
    };
  }
  const text = await res.text();
  if (!res.ok) {
    let error = { code: 'error', message: `The Admin API answered ${res.status}.` };
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      if (typeof parsed.message === 'string') {
        error = { code: parsed.code ?? 'error', message: parsed.message };
      }
    } catch {
      // not JSON: keep the status line
    }
    return { ok: false, status: res.status, error };
  }
  return { ok: true, csv: text, truncated: res.headers.get('x-truncated') === 'true' };
}
