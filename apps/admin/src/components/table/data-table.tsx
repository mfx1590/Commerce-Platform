'use client';

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiStatePanel, EmptyPanel } from '@/components/states/state-panel';
import type { AdminError } from '@/lib/api/admin-client';
import {
  ariaSort,
  describeRange,
  nextSort,
  pageCount,
  toSearchParams,
  withFilter,
  withPage,
  type TableQuery,
  type TableQueryDefaults,
} from '@/lib/table/query-state';
import {
  EMPTY_SELECTION,
  canOfferSelectAll,
  clearSelection,
  describeSelection,
  isEmptySelection,
  isPageFullySelected,
  isRowSelected,
  selectAllMatching,
  selectionCount,
  togglePage,
  toggleRow,
  type Selection,
} from '@/lib/table/selection';
import { cn } from '@/lib/utils';

export interface DataTableProps<T> {
  /** Typed against `AdminComponents['Store' | 'Product' | 'OrderSummary' | …]` at the call site. */
  columns: ColumnDef<T, unknown>[];
  rows: readonly T[];
  total: number;
  /** Parsed from `searchParams` on the server and passed down, so the first paint is already correct. */
  query: TableQuery;
  defaults?: TableQueryDefaults;
  getRowId: (row: T) => string;
  /** Names the table for screen readers; also the heading of the empty state. */
  caption: string;
  /** Column ids whose headers become sort buttons. */
  sortableColumns?: readonly string[];
  /** Renders the bulk bar's actions. Receives the live selection so it can name the count. */
  bulkActions?: (selection: Selection) => ReactNode;
  /** Filter key wired to the search box (`q` for every list in contracts-v0.1). */
  searchKey?: string;
  searchPlaceholder?: string;
  emptyState?: ReactNode;
  /** Offered when the list is empty *and* unfiltered — "create your first product". */
  emptyAction?: ReactNode;
  /** A failed request renders in place of the rows rather than taking down the route. */
  error?: { status: number; error: AdminError } | undefined;
}

export function DataTable<T>({
  columns,
  rows,
  total,
  query,
  defaults,
  getRowId,
  caption,
  sortableColumns = [],
  bulkActions,
  searchKey,
  searchPlaceholder,
  emptyState,
  emptyAction,
  error,
}: DataTableProps<T>) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [visibility, setVisibility] = useState<VisibilityState>({});
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);

  const table = useReactTable({
    data: rows as T[],
    columns,
    state: { columnVisibility: visibility },
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    // The server does all three; the table is a renderer, not a data engine.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    getRowId: (row) => getRowId(row),
  });

  const pageIds = useMemo(() => rows.map(getRowId), [rows, getRowId]);

  // Changing what is being matched changes what "all matching" means, so a selection made under the
  // old filter must not survive it. Paging does not reset: ticking rows across pages is deliberate.
  const filterSignature = JSON.stringify(query.filters);
  const previousSignature = useRef(filterSignature);
  useEffect(() => {
    if (previousSignature.current !== filterSignature) {
      previousSignature.current = filterSignature;
      setSelection(EMPTY_SELECTION);
    }
  }, [filterSignature]);

  const navigate = (next: TableQuery) => {
    const search = toSearchParams(next, defaults);
    startTransition(() => {
      router.push(search === '' ? pathname : `${pathname}?${search}`);
    });
  };

  const pages = pageCount(total, query.limit);
  const range = describeRange(query.page, query.limit, total);
  const selected = selectionCount(selection);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {searchKey !== undefined && (
          <form
            className="flex items-center gap-2"
            action={(formData) => {
              const value = formData.get('search');
              navigate(withFilter(query, searchKey, typeof value === 'string' ? value : null));
            }}
          >
            <label htmlFor={`${caption}-search`} className="sr-only">
              Search {caption}
            </label>
            <input
              id={`${caption}-search`}
              name="search"
              type="search"
              defaultValue={query.filters[searchKey] ?? ''}
              placeholder={searchPlaceholder ?? 'Search'}
              className="border-line bg-surface h-9 w-56 rounded-md border px-3 text-sm"
            />
            <Button type="submit" variant="secondary" size="sm">
              Search
            </Button>
          </form>
        )}

        <details className="relative ml-auto">
          <summary className="border-line bg-surface hover:bg-canvas inline-flex h-9 cursor-pointer list-none items-center rounded-md border px-3 text-sm">
            Columns
          </summary>
          <div className="border-line bg-surface absolute right-0 z-10 mt-1 w-56 rounded-md border p-2 shadow-md">
            {table.getAllLeafColumns().map((column) => (
              <label key={column.id} className="flex items-center gap-2 px-1 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={column.getToggleVisibilityHandler()}
                />
                {column.id}
              </label>
            ))}
          </div>
        </details>
      </div>

      {!isEmptySelection(selection) && (
        <div
          className="border-accent/20 bg-accent/5 flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
          role="status"
        >
          <span>{describeSelection(selection)}</span>
          {canOfferSelectAll(selection, pageIds, total) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSelection(selectAllMatching(total))}
            >
              Select all {total} matching
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setSelection(clearSelection())}>
            Clear
          </Button>
          {bulkActions !== undefined && (
            <div className="ml-auto flex items-center gap-2">{bulkActions(selection)}</div>
          )}
        </div>
      )}

      {error !== undefined ? (
        // One dispatcher, so a 401 here looks like a 401 everywhere else.
        <ApiStatePanel status={error.status} error={error.error} what={caption} />
      ) : rows.length === 0 ? (
        (emptyState ?? <EmptyTable caption={caption} query={query} action={emptyAction} />)
      ) : (
        <div className="border-line bg-surface overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" aria-busy={isPending} aria-label={caption}>
            <caption className="sr-only">{caption}</caption>
            <thead className="border-line bg-canvas border-b">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {bulkActions !== undefined && (
                    <th scope="col" className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select all ${rows.length} rows on this page`}
                        checked={isPageFullySelected(selection, pageIds)}
                        onChange={() => setSelection(togglePage(selection, pageIds))}
                      />
                    </th>
                  )}
                  {headerGroup.headers.map((header) => {
                    const sortable = sortableColumns.includes(header.column.id);
                    const label = flexRender(header.column.columnDef.header, header.getContext());
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={sortable ? ariaSort(query, header.column.id) : undefined}
                        className="px-3 py-2 text-left font-medium"
                      >
                        {sortable ? (
                          <button
                            type="button"
                            className="hover:text-accent inline-flex items-center gap-1"
                            onClick={() => navigate(nextSort(query, header.column.id))}
                          >
                            {label}
                            <span aria-hidden="true" className="text-muted">
                              {query.sort !== header.column.id
                                ? '↕'
                                : query.order === 'asc'
                                  ? '↑'
                                  : '↓'}
                            </span>
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className={cn('divide-line divide-y', isPending && 'opacity-60')}>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="hover:bg-canvas">
                  {bulkActions !== undefined && (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select row ${row.id}`}
                        checked={isRowSelected(selection, row.id)}
                        onChange={() => setSelection(toggleRow(selection, row.id))}
                      />
                    </td>
                  )}
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <p className="text-muted" aria-live="polite">
            {range}
            {selected > 0 && ` · ${selected} selected`}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={query.page <= 1 || isPending}
              onClick={() => navigate(withPage(query, query.page - 1))}
            >
              Previous
            </Button>
            <span className="text-muted">
              Page {query.page} of {Math.max(pages, 1)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={query.page >= pages || isPending}
              onClick={() => navigate(withPage(query, query.page + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Nothing here yet" and "your filter matched nothing" are different problems with different next
 * actions: the first wants a create button, the second wants the filter cleared. Conflating them
 * leaves someone staring at an empty catalog wondering whether the import failed.
 */
function EmptyTable({
  caption,
  query,
  action,
}: {
  caption: string;
  query: TableQuery;
  action: ReactNode;
}) {
  const filtered = Object.keys(query.filters).length > 0;
  return filtered ? (
    <EmptyPanel
      title={`No ${caption.toLowerCase()} match this filter`}
      description="Nothing here matched what you searched for."
      action={<ClearFiltersButton />}
    />
  ) : (
    <EmptyPanel
      title={`No ${caption.toLowerCase()} yet`}
      {...(action === undefined ? {} : { action })}
    />
  );
}

/** Clears every filter by navigating to the bare path — the URL is the state. */
function ClearFiltersButton() {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Button variant="secondary" onClick={() => router.push(pathname)}>
      Clear filters
    </Button>
  );
}
