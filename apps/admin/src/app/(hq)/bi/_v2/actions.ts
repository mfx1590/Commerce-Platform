'use server';

import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { mapServerError } from '@/lib/forms/server-errors';
import { visibleHqSections } from '@/lib/nav/navigation';
import { loadPrincipal } from '@/lib/principal';
import { refuseUnlessSection } from '@/lib/table/export-server';
import { listMetrics } from '../_api';
import { metricsCsv } from './api';
import {
  inventoryQuery,
  parseInventory,
  parseState,
  type InventoryQuery,
  type MetricQuery,
  type Raw,
} from './model';
import {
  breakdownQuery,
  categoriesQuery,
  overviewQueries,
  PRODUCT_RANKS,
  productsQuery,
  type ProductRank,
} from './queries';

/**
 * CSV of each BI v2 block (#871), through the API's own `text/csv` with label columns. A server
 * action is reachable without the page, so it checks the BI section itself, with the SAME predicate
 * as the page's guard: HQ `bi` (analyst on hq) or the store's `bi` section (viewer on the store).
 * The query is rebuilt here from the URL state the page used — never taken from the browser — so
 * the file is the same question as the block. No `route.ts`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most inventory rows one file holds (the API's page maximum). */
const INVENTORY_CSV_LIMIT = 500;

async function refuseUnlessBi(storeId: string | null): Promise<ActionResult<never> | null> {
  if (storeId !== null) return refuseUnlessSection(storeId, 'bi');
  const principal = await loadPrincipal();
  if (!principal.ok) {
    const failure = { status: principal.status, error: principal.error };
    const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
    return actionError(mapServerError(failure), refusal);
  }
  if (visibleHqSections(principal.data).some((section) => section.id === 'bi')) return null;
  const error = {
    code: 'forbidden',
    message: 'requires analyst on organization:hq',
    details: { relation: 'analyst', object: 'organization:hq' },
  };
  return actionError(mapServerError({ status: 403, error }), { status: 403, error });
}

export type BiBlock = 'overview' | 'breakdown' | 'products' | 'categories' | 'inventory';

export interface BiCsv {
  csv: string;
  exported: number;
  total: number;
  truncated: boolean;
}

export async function exportBiCsvAction(
  block: BiBlock,
  raw: Record<string, string>,
  storeId: string | null,
): Promise<ActionResult<BiCsv>> {
  if (storeId !== null && !UUID.test(storeId)) {
    return actionError({ fieldErrors: {}, formError: 'That store is not valid.' });
  }
  const refused = await refuseUnlessBi(storeId);
  if (refused !== null) return refused;

  const params: Raw = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => typeof value === 'string'),
  );
  const state = parseState(params);
  const scope = storeId ?? undefined;

  let path: '/admin/metrics/query' | '/admin/metrics/inventory' = '/admin/metrics/query';
  let body: MetricQuery | InventoryQuery | null = null;
  if (block === 'inventory') {
    path = '/admin/metrics/inventory';
    body = {
      ...inventoryQuery(state, parseInventory(params), scope),
      page: 1,
      limit: INVENTORY_CSV_LIMIT,
    };
  } else {
    const catalogue = await listMetrics();
    if (!catalogue.ok) {
      return actionError(mapServerError({ status: catalogue.status, error: catalogue.error }));
    }
    if (block === 'overview') {
      // One file: the headline metrics fit one query when the catalogue allows; else the first part.
      body = overviewQueries(catalogue.data, state, scope).queries[0] ?? null;
    } else if (block === 'breakdown') {
      body = breakdownQuery(catalogue.data, state, scope).query;
    } else if (block === 'categories') {
      body = categoriesQuery(catalogue.data, state, scope).query;
    } else {
      const rank = (PRODUCT_RANKS as readonly string[]).includes(params['rank'] as string)
        ? (params['rank'] as ProductRank)
        : 'product_net_ex_tax_minor';
      const direction = params['dir'] === 'asc' ? 'asc' : 'desc';
      body = productsQuery(catalogue.data, state, rank, direction, scope).query;
    }
  }
  if (body === null) {
    return actionError({ fieldErrors: {}, formError: 'This block has nothing to export here.' });
  }

  const answer = await metricsCsv(path, body);
  if (!answer.ok) {
    const failure = { status: answer.status, error: answer.error };
    const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
    return actionError(mapServerError(failure), refusal);
  }
  const exported = Math.max(0, answer.csv.trim().split(/\r?\n/).length - 1);
  return {
    status: 'success',
    data: { csv: answer.csv, exported, total: exported, truncated: answer.truncated },
  };
}
