'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { AdminError } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';
import type { TableQuery } from '@/lib/table/query-state';

/** What a POST-backed search action takes besides the store and the term (see `search-lists.ts`). */
export interface TermSearchRequest {
  page: number;
  limit: number;
  sort: string | null;
  order: 'asc' | 'desc';
  filters: Readonly<Record<string, string>>;
}

export type TermSearchRun<T> = (
  term: string,
  request: TermSearchRequest,
) => Promise<ActionResult<{ rows: T[]; total: number }>>;

/** What `DataTable` needs to search without the URL. */
export interface TermSearchControl {
  /** The active term, or null when the table shows the page's own (URL) rows. */
  term: string | null;
  submit: (term: string | null) => void;
  /** Paging, sorting and page size while a term is active: run the search again, never `router.push`. */
  navigate: (next: TableQuery) => void;
  pending: boolean;
  /** The search could not run: an invalid term, or a failure that is not a refusal. Never "no match". */
  message: string | null;
}

export interface TermSearchState<T> {
  control: TermSearchControl;
  /**
   * The query the table renders and hands to bulk actions and exports: the URL's, or, while searching,
   * the search's own page and sort with the URL's filters plus `q`. `q` lives only here, in memory, and
   * in the POST bodies built from it, never in an address.
   */
  query: TableQuery;
  rows: readonly T[] | null;
  total: number | null;
  error: { status: number; error: AdminError } | undefined;
  /** A refusal or an invalid term, as a sentence; null otherwise. */
  message: string | null;
}

/**
 * POST-backed search for a list (#946). The term is component state: a reload drops it (the page says
 * so). While a term is active, the URL's other filters still apply: changing one re-runs the search from
 * page 1. The latest request wins, so a slow answer cannot overwrite a newer one.
 */
export function useTermSearch<T>({
  query,
  run,
  searchKey = 'q',
}: {
  query: TableQuery;
  run: TermSearchRun<T>;
  searchKey?: string;
}): TermSearchState<T> {
  const [term, setTerm] = useState<string | null>(null);
  const [local, setLocal] = useState<TableQuery>(query);
  const [answer, setAnswer] = useState<Awaited<ReturnType<TermSearchRun<T>>> | null>(null);
  const [pending, startTransition] = useTransition();
  const latest = useRef(0);

  const execute = useCallback(
    (nextTerm: string, next: TableQuery) => {
      const ticket = ++latest.current;
      startTransition(async () => {
        const result = await run(nextTerm, {
          page: next.page,
          limit: next.limit,
          sort: next.sort,
          order: next.order,
          filters: next.filters,
        });
        if (ticket === latest.current) setAnswer(result);
      });
    },
    [run],
  );

  // The URL's filters changed while searching (a status, a date, a group): search again from page 1.
  const urlFilters = JSON.stringify(query.filters);
  const seen = useRef(urlFilters);
  useEffect(() => {
    if (seen.current === urlFilters) return;
    seen.current = urlFilters;
    if (term === null) return;
    const next = { ...local, page: 1, filters: query.filters };
    setLocal(next);
    execute(term, next);
  }, [urlFilters, term, local, query.filters, execute]);

  const failedMessage =
    term !== null && answer !== null && answer.status === 'error' && answer.refusal === undefined
      ? (answer.formError ?? 'The search failed.')
      : null;
  const control: TermSearchControl = {
    term,
    pending,
    message: failedMessage,
    submit: (value) => {
      const trimmed = value?.trim() ?? '';
      if (trimmed === '') {
        latest.current += 1; // an answer still in flight must not reappear
        setTerm(null);
        setAnswer(null);
        return;
      }
      const next = { ...query, page: 1 };
      setTerm(trimmed);
      setLocal(next);
      execute(trimmed, next);
    },
    navigate: (next) => {
      if (term === null) return;
      const { [searchKey]: _dropped, ...filters } = next.filters;
      const withoutTerm = { ...next, filters };
      setLocal(withoutTerm);
      execute(term, withoutTerm);
    },
  };

  if (term === null) {
    return { control, query, rows: null, total: null, error: undefined, message: null };
  }
  const effective: TableQuery = { ...local, filters: { ...local.filters, [searchKey]: term } };
  if (answer === null) {
    return { control, query: effective, rows: null, total: null, error: undefined, message: null };
  }
  if (answer.status === 'success') {
    return {
      control,
      query: effective,
      rows: answer.data.rows,
      total: answer.data.total,
      error: undefined,
      message: null,
    };
  }
  return {
    control,
    query: effective,
    rows: [],
    total: 0,
    error: answer.refusal,
    message: failedMessage,
  };
}
