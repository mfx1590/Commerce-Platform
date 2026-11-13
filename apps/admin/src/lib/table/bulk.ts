/**
 * Bulk actions on a server-paginated table (#870 wave 1 item 2). The Admin API has no bulk
 * endpoint: a bulk action is N single calls, each reported on its own. Pure — no React, no `next/*`
 * — so the server actions and the tests share it.
 *
 * Rules:
 * - The selection is resolved ON THE SERVER. "These rows" are ids (uuids, capped); "all matching"
 *   re-runs the list with the same filters and refuses when the total moved since the user saw it,
 *   rather than acting on rows nobody looked at.
 * - Each row is checked and called on its own and gets its own outcome: done, skipped (the API
 *   said the row is already in, or cannot reach, that state — a 409), failed, or unknown.
 * - Unknown (status 0, 5xx) is never retried: no Admin API mutation takes an idempotency key.
 */

import type { Selection } from './selection';

/** The most rows one bulk action may touch. A typo-sized guard, said on screen when it applies. */
export const BULK_CAP = 500;
/** Calls in flight at once: quick enough for 500 rows, gentle on the core. */
export const BULK_CONCURRENCY = 4;
/** The page size used to re-run a list for "all matching" (the contract's cap). */
const RESOLVE_PAGE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What crosses from the browser to a server action: plain arrays, no Sets. */
export type BulkSelection =
  | { mode: 'rows'; ids: string[] }
  | {
      mode: 'all-matching';
      excluded: string[];
      /** The total the user saw when they chose "all matching". */
      total: number;
      /** The list's contract filters at that moment (q, status, …). */
      filters: Record<string, string>;
    };

export function toBulkSelection(
  selection: Selection,
  filters: Readonly<Record<string, string>>,
): BulkSelection {
  return selection.mode === 'rows'
    ? { mode: 'rows', ids: [...selection.ids] }
    : {
        mode: 'all-matching',
        excluded: [...selection.excluded],
        total: selection.total,
        filters: { ...filters },
      };
}

/** A list read, page by page, with the same filters the table used. */
export type ListPage<T> = (
  page: number,
  limit: number,
) => Promise<
  | { ok: true; data: { items: readonly T[]; total: number } }
  | { ok: false; status: number; error: { code: string; message: string } }
>;

export type Resolved<T> =
  | { ok: true; rows: { id: string; row: T | null }[] }
  | { ok: false; message: string; status?: number; error?: { code: string; message: string } };

/**
 * The rows a bulk action acts on. `rows` mode: the ids as sent (deduplicated, uuids only, ≤ cap) —
 * the row data is null; the per-row call reads what it needs. `all-matching`: the list re-run.
 */
export async function resolveSelection<T>(
  selection: BulkSelection,
  idOf: (row: T) => string,
  listPage: ListPage<T>,
): Promise<Resolved<T>> {
  if (selection.mode === 'rows') {
    const ids = [...new Set(selection.ids)];
    if (ids.length === 0) return { ok: false, message: 'Nothing is selected.' };
    if (!ids.every((id) => UUID.test(id))) {
      return {
        ok: false,
        message: 'The selection is not valid. Reload the page and select again.',
      };
    }
    if (ids.length > BULK_CAP) {
      return { ok: false, message: tooMany(ids.length) };
    }
    return { ok: true, rows: ids.map((id) => ({ id, row: null })) };
  }

  const excluded = new Set(selection.excluded);
  const first = await listPage(1, RESOLVE_PAGE);
  if (!first.ok) {
    return { ok: false, message: first.error.message, status: first.status, error: first.error };
  }
  if (first.data.total !== selection.total) {
    return {
      ok: false,
      message: `The list changed since you selected it (${selection.total} → ${first.data.total} matching). Review it and select again.`,
    };
  }
  if (first.data.total - excluded.size > BULK_CAP) {
    return { ok: false, message: tooMany(first.data.total - excluded.size) };
  }
  const rows: { id: string; row: T | null }[] = [];
  const take = (items: readonly T[]) => {
    for (const row of items) {
      const id = idOf(row);
      if (!excluded.has(id)) rows.push({ id, row });
    }
  };
  take(first.data.items);
  const pages = Math.ceil(first.data.total / RESOLVE_PAGE);
  for (let page = 2; page <= pages; page += 1) {
    const next = await listPage(page, RESOLVE_PAGE);
    if (!next.ok) {
      return { ok: false, message: next.error.message, status: next.status, error: next.error };
    }
    take(next.data.items);
  }
  // Rows can shift between pages while we read (a row changed state and left the filter): a
  // duplicate is acted on once.
  const seen = new Set<string>();
  return { ok: true, rows: rows.filter(({ id }) => !seen.has(id) && (seen.add(id), true)) };
}

function tooMany(count: number): string {
  return `${count} rows are selected; one bulk action takes at most ${BULK_CAP}. Narrow the filter and run it in parts.`;
}

// ---------------------------------------------------------------------------- per-row outcomes

export type RowOutcome = 'done' | 'skipped' | 'failed' | 'unknown' | 'refused';

export interface BulkRowResult {
  id: string;
  /** What the row is called on screen (order number, product title); the id when unknown. */
  label: string;
  outcome: RowOutcome;
  message: string;
}

export interface BulkReport {
  results: BulkRowResult[];
  counts: Record<RowOutcome, number>;
}

/** An API answer as one row's outcome. A 409 is "skipped" (the row's state does not allow it). */
export function outcomeOf(
  result: { ok: true } | { ok: false; status: number; error: { message: string } },
  doneMessage: string,
): { outcome: RowOutcome; message: string } {
  if (result.ok) return { outcome: 'done', message: doneMessage };
  const { status, error } = result;
  if (status === 0 || status >= 500) {
    return {
      outcome: 'unknown',
      message: `Outcome unknown (${error.message}): check this row before running it again.`,
    };
  }
  if (status === 401 || status === 403) return { outcome: 'refused', message: error.message };
  if (status === 409) return { outcome: 'skipped', message: error.message };
  return { outcome: 'failed', message: error.message };
}

/**
 * Runs `work` for every row, at most `concurrency` at a time, results in the rows' order. A row
 * whose work throws is `failed` with the error's message; the others carry on.
 */
export async function runBulk<R extends { id: string }>(
  rows: readonly R[],
  work: (row: R) => Promise<BulkRowResult>,
  concurrency = BULK_CONCURRENCY,
): Promise<BulkReport> {
  const results: BulkRowResult[] = new Array(rows.length);
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const index = next;
      next += 1;
      const row = rows[index]!;
      try {
        results[index] = await work(row);
      } catch (cause) {
        results[index] = {
          id: row.id,
          label: row.id,
          outcome: 'failed',
          message: cause instanceof Error ? cause.message : 'Unexpected error.',
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, lane));
  return { results, counts: countOutcomes(results) };
}

export function countOutcomes(results: readonly BulkRowResult[]): Record<RowOutcome, number> {
  const counts: Record<RowOutcome, number> = {
    done: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    refused: 0,
  };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

const OUTCOME_WORDS: Record<RowOutcome, string> = {
  done: 'done',
  skipped: 'skipped',
  failed: 'failed',
  unknown: 'outcome unknown',
  refused: 'refused',
};

/** "12 done · 1 skipped · 2 failed" — zero counts left out. */
export function describeReport(counts: Record<RowOutcome, number>): string {
  const parts = (Object.keys(OUTCOME_WORDS) as RowOutcome[])
    .filter((outcome) => counts[outcome] > 0)
    .map((outcome) => `${counts[outcome]} ${OUTCOME_WORDS[outcome]}`);
  return parts.length === 0 ? 'Nothing was done.' : parts.join(' · ');
}

/** Failures first (what needs attention), then the rest in their original order. */
export function sortForReport(results: readonly BulkRowResult[]): BulkRowResult[] {
  const rank: Record<RowOutcome, number> = {
    unknown: 0,
    failed: 1,
    refused: 2,
    skipped: 3,
    done: 4,
  };
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => rank[a.result.outcome] - rank[b.result.outcome] || a.index - b.index)
    .map(({ result }) => result);
}
