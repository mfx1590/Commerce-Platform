/**
 * Table state lives in the URL, not in React state.
 *
 * Sorting, paging and filtering are all server-driven — the contract returns
 * `{ page, limit, total, items }` — so the URL is the only place that can hold the request the
 * server should answer. Keeping it there also makes every list view linkable, back-button correct
 * and reproducible in a bug report.
 *
 * Pure: no `next/*`, no I/O.
 */

export type SortOrder = 'asc' | 'desc';

export interface TableQuery {
  page: number;
  limit: number;
  sort: string | null;
  order: SortOrder;
  /** Contract filter parameters (`q`, `status`, `category_id`, …), already narrowed to strings. */
  filters: Readonly<Record<string, string>>;
}

export const DEFAULT_LIMIT = 20;
/** `components/parameters/Limit` caps at 100. */
const MAX_LIMIT = 100;

export interface TableQueryDefaults {
  limit?: number;
  sort?: string | null;
  order?: SortOrder;
}

/** A minimal read-only view of URLSearchParams, so tests need no DOM. */
export interface ReadableParams {
  get: (name: string) => string | null;
}

function positiveInt(raw: string | null, fallback: number, max?: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return max !== undefined && value > max ? max : value;
}

export function parseTableQuery(
  params: ReadableParams,
  filterKeys: readonly string[] = [],
  defaults: TableQueryDefaults = {},
): TableQuery {
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const value = params.get(key);
    if (value !== null && value !== '') {
      filters[key] = value;
    }
  }

  const rawOrder = params.get('order');
  const sort = params.get('sort') ?? defaults.sort ?? null;

  return {
    page: positiveInt(params.get('page'), 1),
    limit: positiveInt(params.get('limit'), defaults.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    sort,
    order: rawOrder === 'asc' || rawOrder === 'desc' ? rawOrder : (defaults.order ?? 'desc'),
    filters,
  };
}

/**
 * Back to a query string, omitting anything at its default so shared links stay short and the
 * "unfiltered" URL is genuinely `/stores` rather than `/stores?page=1&limit=20&order=desc`.
 */
export function toSearchParams(query: TableQuery, defaults: TableQueryDefaults = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query.filters)) {
    if (value !== '') params.set(key, value);
  }
  if (query.sort !== null && query.sort !== (defaults.sort ?? null)) {
    params.set('sort', query.sort);
  }
  if (query.sort !== null && query.order !== (defaults.order ?? 'desc')) {
    params.set('order', query.order);
  }
  if (query.page > 1) params.set('page', String(query.page));
  if (query.limit !== (defaults.limit ?? DEFAULT_LIMIT)) params.set('limit', String(query.limit));
  return params.toString();
}

/**
 * The parameters actually sent to the Admin API.
 *
 * `sortable` stays opt-in even though Admin API 0.2.0 added `sort`/`order` (CONTRACT CHANGE #56):
 * they were added to the four list operations the admin app renders as tables, not to every list in
 * the contract, and each one accepts its own enum of sortable fields. A screen declares that its
 * operation supports them, so a table on some other endpoint cannot send a parameter that endpoint
 * does not define.
 */
export function toContractQuery(
  query: TableQuery,
  options: { sortable?: boolean } = {},
): Record<string, string | number> {
  const contract: Record<string, string | number> = {
    page: query.page,
    limit: query.limit,
    ...query.filters,
  };
  if (options.sortable === true && query.sort !== null) {
    contract['sort'] = query.sort;
    contract['order'] = query.order;
  }
  return contract;
}

/**
 * Header click cycle: unsorted → descending → ascending → unsorted.
 *
 * Descending first because every default in this app is "newest / largest first"; making the first
 * click reverse that would be surprising.
 */
export function nextSort(query: TableQuery, columnId: string): TableQuery {
  if (query.sort !== columnId) {
    return { ...query, sort: columnId, order: 'desc', page: 1 };
  }
  if (query.order === 'desc') {
    return { ...query, order: 'asc', page: 1 };
  }
  return { ...query, sort: null, order: 'desc', page: 1 };
}

/** Any change to what is being matched resets to page 1; paging past the end shows nothing. */
export function withFilter(query: TableQuery, key: string, value: string | null): TableQuery {
  const filters = { ...query.filters };
  if (value === null || value === '') {
    delete filters[key];
  } else {
    filters[key] = value;
  }
  return { ...query, filters, page: 1 };
}

export function withPage(query: TableQuery, page: number): TableQuery {
  return { ...query, page: page < 1 ? 1 : page };
}

export function pageCount(total: number, limit: number): number {
  if (total <= 0 || limit <= 0) return 0;
  return Math.ceil(total / limit);
}

/** "1–20 of 137", or an honest empty string when there is nothing to describe. */
export function describeRange(page: number, limit: number, total: number): string {
  if (total <= 0) return '';
  const first = (page - 1) * limit + 1;
  if (first > total) return `0 of ${total}`;
  return `${first}–${Math.min(page * limit, total)} of ${total}`;
}

/** `aria-sort` for a column header, per WAI-ARIA. */
export function ariaSort(query: TableQuery, columnId: string): 'ascending' | 'descending' | 'none' {
  if (query.sort !== columnId) return 'none';
  return query.order === 'asc' ? 'ascending' : 'descending';
}
