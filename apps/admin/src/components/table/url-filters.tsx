'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  toSearchParams,
  withFilter,
  type TableQuery,
  type TableQueryDefaults,
} from '@/lib/table/query-state';

/**
 * Filter controls for list parameters the Admin API already takes but no screen offered
 * (#870 wave 1 item 2). Like the status pills, they live beside `DataTable` and write the same URL
 * state, so the filter, the search box, the pager and "all matching" cannot disagree. Changing a
 * filter goes back to page 1 and clears the selection (DataTable resets it on a filter change).
 */

function useApply(query: TableQuery, defaults: TableQueryDefaults | undefined) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const apply = (next: TableQuery) => {
    const search = toSearchParams(next, defaults);
    startTransition(() => {
      router.push(search === '' ? pathname : `${pathname}?${search}`);
    });
  };
  return { pending, apply };
}

/** One parameter, one value from a list (`category_id`, `group_id`, `status`, …). */
export function SelectFilter({
  query,
  defaults,
  filterKey,
  label,
  anyLabel,
  options,
}: {
  query: TableQuery;
  defaults?: TableQueryDefaults;
  filterKey: string;
  label: string;
  /** The "no filter" option: "Any category". */
  anyLabel: string;
  options: readonly { value: string; label: string }[];
}) {
  const { pending, apply } = useApply(query, defaults);
  const current = query.filters[filterKey] ?? '';
  // A value in the URL that is not offered (a deleted category) is still shown, not silently lost.
  const known = current === '' || options.some((option) => option.value === current);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <select
        value={current}
        disabled={pending}
        onChange={(event) => apply(withFilter(query, filterKey, event.currentTarget.value))}
        className="border-line bg-surface h-9 rounded-md border px-2"
      >
        <option value="">{anyLabel}</option>
        {!known && <option value={current}>{current} (not in the list)</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** `YYYY-MM-DD` from a contract date-time, or '' (what a date input shows). */
export function dateInputValue(value: string | undefined): string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

/**
 * The day range as contract date-times, both ends inclusive of their whole day in UTC: from 00:00
 * of the first day to 23:59:59.999 of the last. Empty ends are left out.
 */
export function dayRange(from: string, to: string): { from: string | null; to: string | null } {
  return {
    from: from === '' ? null : `${from}T00:00:00.000Z`,
    to: to === '' ? null : `${to}T23:59:59.999Z`,
  };
}

/** A from–to day range over two parameters (`placed_from` / `placed_to`). */
export function DateRangeFilter({
  query,
  defaults,
  fromKey,
  toKey,
  label,
}: {
  query: TableQuery;
  defaults?: TableQueryDefaults;
  fromKey: string;
  toKey: string;
  label: string;
}) {
  const { pending, apply } = useApply(query, defaults);
  const from = dateInputValue(query.filters[fromKey]);
  const to = dateInputValue(query.filters[toKey]);
  return (
    <form
      role="group"
      aria-label={label}
      className="flex flex-wrap items-end gap-2 text-sm"
      action={(form) => {
        const nextFrom = String(form.get('from') ?? '');
        const nextTo = String(form.get('to') ?? '');
        const range = dayRange(nextFrom, nextTo);
        apply(withFilter(withFilter(query, fromKey, range.from), toKey, range.to));
      }}
    >
      <span className="text-muted self-center">{label}</span>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted text-xs">From</span>
        <input
          type="date"
          name="from"
          defaultValue={from}
          max={to === '' ? undefined : to}
          className="border-line bg-surface h-9 rounded-md border px-2"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted text-xs">To</span>
        <input
          type="date"
          name="to"
          defaultValue={to}
          min={from === '' ? undefined : from}
          className="border-line bg-surface h-9 rounded-md border px-2"
        />
      </label>
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        Apply
      </Button>
      {(from !== '' || to !== '') && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => apply(withFilter(withFilter(query, fromKey, null), toKey, null))}
        >
          Clear dates
        </Button>
      )}
    </form>
  );
}
