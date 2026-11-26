'use server';

/**
 * POST-backed list search (#946). The free-text term (an email, a name, an order number) travels in the
 * action's request BODY and is never written to the address bar, so it does not land in browser history
 * or in a `Referer`. Everything else the table shows (filters, page, page size, sort) arrives here too,
 * so a search can be paged and sorted without the term ever entering the URL.
 *
 * Each action is a public POST endpoint: it refuses first (`refuseUnlessPermitted`, the operation's
 * `x-permission`), then whitelists the filters the table offers, clamps page and limit as the page does,
 * and answers the same row projections the server page renders — never the full records.
 */

import { listCustomers, listOrders } from '@/lib/api/admin';
import { forCustomerRows, type CustomerRow } from '@/lib/customers/projection';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { mapServerError } from '@/lib/forms/server-errors';
import { forOrderRows, type OrderRow } from '@/lib/orders/projection';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  parseTableQuery,
  toContractQuery,
  type TableQuery,
  type TableQueryDefaults,
} from '@/lib/table/query-state';
import {
  CUSTOMERS_TABLE_DEFAULTS,
  CUSTOMER_URL_FILTER_KEYS,
} from '@/app/(store)/[storeId]/customers/customers-table.config';
import {
  ORDERS_TABLE_DEFAULTS,
  ORDER_URL_FILTER_KEYS,
} from '@/app/(store)/[storeId]/orders/orders-table.config';

/** What the table sends with a search: the rest of its state, never the term (that is its own argument). */
export interface SearchRequest {
  page: number;
  limit: number;
  sort: string | null;
  order: 'asc' | 'desc';
  filters: Readonly<Record<string, string>>;
}

export interface SearchPage<T> {
  rows: T[];
  total: number;
}

/** Longer than any email, name or order number; a pasted document is not a search. */
export const MAX_SEARCH_TERM = 200;

function normaliseTerm(term: unknown): string | null {
  if (typeof term !== 'string') return null;
  const trimmed = term.trim();
  return trimmed.length === 0 || trimmed.length > MAX_SEARCH_TERM ? null : trimmed;
}

/**
 * The request as a `TableQuery`, through the same parser the page uses: only `filterKeys` survive (never
 * `q`, which is the term's), page and limit are clamped, an unknown order falls back to the default.
 */
function toQuery(
  request: unknown,
  filterKeys: readonly string[],
  defaults: TableQueryDefaults,
): TableQuery {
  const params = new URLSearchParams();
  const source = (typeof request === 'object' && request !== null ? request : {}) as Record<
    string,
    unknown
  >;
  for (const key of ['page', 'limit', 'sort', 'order'] as const) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') params.set(key, String(value));
  }
  const filters = source['filters'];
  if (typeof filters === 'object' && filters !== null) {
    for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
      if (typeof value === 'string') params.set(key, value);
    }
  }
  return parseTableQuery(params, filterKeys, defaults);
}

const INVALID_TERM = actionError({
  fieldErrors: {},
  formError: `Enter between 1 and ${MAX_SEARCH_TERM} characters to search.`,
});

function failure(status: number, error: Parameters<typeof mapServerError>[0]['error']) {
  const refusal = status === 401 || status === 403 ? { status, error } : undefined;
  return actionError(mapServerError({ status, error }), refusal);
}

/** `listCustomers` with `q`: support on the store. Rows are `CustomerRow` projections. */
export async function searchCustomersAction(
  storeId: string,
  term: string,
  request: SearchRequest,
): Promise<ActionResult<SearchPage<CustomerRow>>> {
  const refused = await refuseUnlessPermitted('listCustomers', storeId);
  if (refused) return refused;
  const q = normaliseTerm(term);
  if (q === null) return INVALID_TERM;
  const query = toQuery(request, CUSTOMER_URL_FILTER_KEYS, CUSTOMERS_TABLE_DEFAULTS);
  const result = await listCustomers(storeId, { ...toContractQuery(query, { sortable: true }), q });
  if (!result.ok) return failure(result.status, result.error);
  return {
    status: 'success',
    data: { rows: forCustomerRows(result.data.items), total: result.data.total },
  };
}

/** `listOrders` with `q` (order number or email): viewer on the store. Rows are `OrderRow` projections. */
export async function searchOrdersAction(
  storeId: string,
  term: string,
  request: SearchRequest,
): Promise<ActionResult<SearchPage<OrderRow>>> {
  const refused = await refuseUnlessPermitted('listOrders', storeId);
  if (refused) return refused;
  const q = normaliseTerm(term);
  if (q === null) return INVALID_TERM;
  const query = toQuery(request, ORDER_URL_FILTER_KEYS, ORDERS_TABLE_DEFAULTS);
  const result = await listOrders(storeId, { ...toContractQuery(query, { sortable: true }), q });
  if (!result.ok) return failure(result.status, result.error);
  return {
    status: 'success',
    data: { rows: forOrderRows(result.data.items), total: result.data.total },
  };
}
