import 'server-only';

import { revalidatePath } from 'next/cache';
import { actionError, type ActionResult } from '../forms/action-result';
import { mapServerError } from '../forms/server-errors';
import { refuseUnlessPermitted, type GuardedOperation } from '../permissions/guard';
import {
  resolveSelection,
  runBulk,
  type BulkReport,
  type BulkSelection,
  type ListPage,
  type RowOutcome,
} from './bulk';

/**
 * The one way a bulk action runs on a store's table (#870 wave 1 item 2):
 * 1. refused up front, before any read, unless the principal may do `operation` on the store;
 * 2. the selection resolved here — ids, or the list re-run with ONLY the table's own filters;
 * 3. per row: the permission checked again, then the row's single call (`perRow`);
 * 4. every row reported; the listed paths revalidated.
 */
export async function runStoreBulkAction<T>({
  operation,
  storeId,
  selection,
  filterKeys,
  idOf,
  labelOf,
  listPage,
  perRow,
  revalidate,
}: {
  operation: GuardedOperation;
  storeId: string;
  selection: BulkSelection;
  /** The filters the table offers; anything else in the request is dropped. */
  filterKeys: readonly string[];
  idOf: (row: T) => string;
  /** The row's name on screen, when the list read gave the row. */
  labelOf: (row: T) => string;
  listPage: (filters: Record<string, string>) => ListPage<T>;
  perRow: (id: string) => Promise<{ outcome: RowOutcome; message: string; label?: string }>;
  revalidate: readonly string[];
}): Promise<ActionResult<BulkReport>> {
  const refused = await refuseUnlessPermitted(operation, storeId);
  if (refused !== null) return refused;

  const allowed = new Set(filterKeys);
  const filters =
    selection.mode === 'all-matching'
      ? Object.fromEntries(
          Object.entries(selection.filters).filter(
            ([key, value]) => allowed.has(key) && typeof value === 'string',
          ),
        )
      : {};
  const resolved = await resolveSelection<T>(
    selection.mode === 'all-matching' ? { ...selection, filters } : selection,
    idOf,
    listPage(filters),
  );
  if (!resolved.ok) {
    return resolved.status !== undefined && resolved.error !== undefined
      ? actionError(mapServerError({ status: resolved.status, error: resolved.error }))
      : actionError({ fieldErrors: {}, formError: resolved.message });
  }

  const report = await runBulk(resolved.rows, async ({ id, row }) => {
    const label = row === null ? id : labelOf(row);
    // Per row, before its call: the rule is per store today, but no row is acted on unchecked.
    const rowRefused = await refuseUnlessPermitted(operation, storeId);
    if (rowRefused !== null) {
      return {
        id,
        label,
        outcome: 'refused' as const,
        message: rowRefused.status === 'error' ? (rowRefused.formError ?? 'Refused.') : 'Refused.',
      };
    }
    const result = await perRow(id);
    return { id, label: result.label ?? label, outcome: result.outcome, message: result.message };
  });
  for (const path of revalidate) revalidatePath(path);
  return { status: 'success', data: report };
}
