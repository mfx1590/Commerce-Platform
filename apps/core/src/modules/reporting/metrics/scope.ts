// The scope rules of a metrics query, in ONE place: `queryMetrics` (routes.ts) and BI Q&A's `query_metrics` tool
// (#606, ../ask) both call this, so a question can never reach further than the same caller's query could.
//   * no visible store at all → 403;
//   * a `filters.store_ids` entry outside the caller's stores → 403 naming it (never empty rows);
//   * a finance metric without `finance` on organization:hq → 403.
// Returns the store ids the statement runs with: the filter when given (already checked), else every store in scope.
import { AppError } from '../../../lib/errors';
import { METRICS } from './catalogue';
import type { MetricQuery } from './query';

export interface MetricsCaller {
  /** the store ids the caller may view (OpenFGA / role_assignment, or every store for an HQ principal) */
  stores: readonly string[];
  /** `finance` on organization:hq — asked only when a finance metric is requested (it may be an OpenFGA call) */
  finance: () => boolean | Promise<boolean>;
}

const forbidden = (message: string, details: Record<string, unknown>) =>
  new AppError('forbidden', message, details);

export async function scopeForQuery(
  q: MetricQuery,
  caller: MetricsCaller,
): Promise<readonly string[]> {
  if (caller.stores.length === 0)
    throw forbidden('no visible store', { relation: 'viewer', object: 'store:*' });
  const inScope = new Set(caller.stores);
  for (const id of q.filters.store_ids ?? [])
    if (!inScope.has(id))
      throw forbidden(`requires viewer on store:${id}`, {
        relation: 'viewer',
        object: `store:${id}`,
      });
  const finance = q.metrics.filter((m) => METRICS[m].finance);
  if (finance.length > 0 && !(await caller.finance()))
    throw forbidden(`${finance[0]} requires finance on organization:hq`, {
      relation: 'finance',
      object: 'organization:hq',
      metric: finance[0],
    });
  return q.filters.store_ids ?? caller.stores;
}
