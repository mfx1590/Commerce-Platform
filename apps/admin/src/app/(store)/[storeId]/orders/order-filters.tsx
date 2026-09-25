'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/utils';
import { toSearchParams, withFilter, type TableQuery } from '@/lib/table/query-state';
import {
  FULFILLMENT_STATUSES,
  ORDERS_TABLE_DEFAULTS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  statusLabel,
} from './orders-table.config';

/**
 * The three status filters from `listOrders`, each a row of pressable pills writing to the same
 * URL state as the table's search and pager (see `status-filter.tsx` in the catalog for why the
 * filter lives beside the table rather than inside the generic `DataTable`).
 */
const GROUPS = [
  { key: 'status', label: 'Status', values: ORDER_STATUSES },
  { key: 'payment_status', label: 'Payment', values: PAYMENT_STATUSES },
  { key: 'fulfillment_status', label: 'Fulfilment', values: FULFILLMENT_STATUSES },
] as const;

export function OrderFilters({ query }: { query: TableQuery }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const apply = (key: string, value: string | null) => {
    const next = withFilter(query, key, value);
    const search = toSearchParams(next, ORDERS_TABLE_DEFAULTS);
    startTransition(() => {
      router.push(search === '' ? pathname : `${pathname}?${search}`);
    });
  };

  return (
    <div className="space-y-2">
      {GROUPS.map((group) => {
        const current = query.filters[group.key] ?? null;
        return (
          <div
            key={group.key}
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label={`Filter by ${group.label.toLowerCase()}`}
          >
            <span className="text-muted w-20 text-xs tracking-wide uppercase">{group.label}</span>
            {[null, ...group.values].map((value) => {
              const active = current === value;
              return (
                <button
                  key={value ?? 'all'}
                  type="button"
                  aria-pressed={active}
                  disabled={isPending}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-sm transition',
                    active
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-muted hover:bg-surface-2',
                  )}
                  onClick={() => apply(group.key, value)}
                >
                  {value === null ? 'All' : statusLabel(value)}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
