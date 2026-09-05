'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/utils';
import { PRODUCTS_TABLE_DEFAULTS } from './products-table.config';
import { toSearchParams, withFilter, type TableQuery } from '@/lib/table/query-state';

/**
 * The `status` filter from `listProducts`. It lives beside the table rather than inside it because
 * the values are contract-specific, while `DataTable` stays generic; both write to the same URL
 * state, so the filter, the search box and the pager cannot disagree.
 */
const OPTIONS = [
  { value: null, label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
] as const;

export function StatusFilter({ query }: { query: TableQuery }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const current = query.filters['status'] ?? null;

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
      {OPTIONS.map((option) => {
        const active = current === option.value;
        return (
          <button
            key={option.label}
            type="button"
            aria-pressed={active}
            disabled={isPending}
            className={cn(
              'rounded-md px-3 py-1 text-sm transition',
              active ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:bg-canvas',
            )}
            onClick={() => {
              const next = withFilter(query, 'status', option.value);
              const search = toSearchParams(next, PRODUCTS_TABLE_DEFAULTS);
              startTransition(() => {
                router.push(search === '' ? pathname : `${pathname}?${search}`);
              });
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
