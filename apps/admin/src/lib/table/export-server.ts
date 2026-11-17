import 'server-only';

import { actionError, type ActionResult } from '../forms/action-result';
import { mapServerError } from '../forms/server-errors';
import { visibleStoreSections } from '../nav/navigation';
import { STORE_SECTIONS } from '../nav/sections';
import { loadPrincipal } from '../principal';
import { EXPORT_CAP, toCsv, type CsvCell } from './csv';

export { EXPORT_CAP };

const EXPORT_PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CsvExport {
  csv: string;
  /** Rows written. */
  exported: number;
  /** Rows the filter matched when the export began. */
  total: number;
  /** More matched than the cap: the file holds the first `EXPORT_CAP` in the list's order. */
  truncated: boolean;
}

/**
 * Null when the principal may open the store section `sectionId` — the same predicate the page's
 * `StoreSectionGuard` renders by, because an export is that page's data in another shape. A server
 * action is reachable without the page, so it checks for itself.
 */
export async function refuseUnlessSection(
  storeId: string,
  sectionId: string,
): Promise<ActionResult<never> | null> {
  if (!UUID.test(storeId)) {
    return actionError({ fieldErrors: {}, formError: 'That store is not valid.' });
  }
  const principal = await loadPrincipal();
  if (!principal.ok) {
    const failure = { status: principal.status, error: principal.error };
    const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
    return actionError(mapServerError(failure), refusal);
  }
  if (visibleStoreSections(principal.data, storeId).some((section) => section.id === sectionId)) {
    return null;
  }
  const relation =
    STORE_SECTIONS.find((section) => section.id === sectionId)?.requires[0] ?? 'viewer';
  const object = `store:${storeId}`;
  const error = {
    code: 'forbidden',
    message: `requires ${relation} on ${object}`,
    details: { relation, object },
  };
  return actionError(mapServerError({ status: 403, error }), { status: 403, error });
}

type Page<T> =
  | { ok: true; data: { items: readonly T[]; total: number } }
  | { ok: false; status: number; error: { code: string; message: string } };

/**
 * "Export CSV" of a store table's current filtered list (#870 wave 1 item 2): the section checked
 * first, only the table's own filters and sort sent back to the API, the list paged through up to
 * `EXPORT_CAP` rows, and the file built here (the token never leaves the server).
 */
export async function exportStoreList<T>({
  storeId,
  sectionId,
  filters,
  filterKeys,
  sort,
  sortKeys,
  listPage,
  header,
  toRow,
}: {
  storeId: string;
  sectionId: string;
  filters: Record<string, string>;
  filterKeys: readonly string[];
  sort: { sort: string | null; order: 'asc' | 'desc' };
  sortKeys: readonly string[];
  listPage: (query: Record<string, string | number>) => Promise<Page<T>>;
  header: readonly string[];
  toRow: (row: T) => readonly CsvCell[];
}): Promise<ActionResult<CsvExport>> {
  const refused = await refuseUnlessSection(storeId, sectionId);
  if (refused !== null) return refused;

  const allowed = new Set(filterKeys);
  const query: Record<string, string | number> = Object.fromEntries(
    Object.entries(filters).filter(([key, value]) => allowed.has(key) && typeof value === 'string'),
  );
  if (sort.sort !== null && sortKeys.includes(sort.sort)) {
    query['sort'] = sort.sort;
    query['order'] = sort.order === 'asc' ? 'asc' : 'desc';
  }

  const rows: T[] = [];
  let total = 0;
  for (let page = 1; rows.length < EXPORT_CAP; page += 1) {
    const result = await listPage({ ...query, page, limit: EXPORT_PAGE });
    if (!result.ok) {
      const failure = { status: result.status, error: result.error };
      const refusal = failure.status === 401 || failure.status === 403 ? failure : undefined;
      return actionError(mapServerError(failure), refusal);
    }
    if (page === 1) total = result.data.total;
    rows.push(...result.data.items);
    if (result.data.items.length < EXPORT_PAGE || page * EXPORT_PAGE >= total) break;
  }
  const kept = rows.slice(0, EXPORT_CAP);
  return {
    status: 'success',
    data: {
      csv: toCsv(header, kept.map(toRow)),
      exported: kept.length,
      total,
      truncated: total > kept.length,
    },
  };
}
