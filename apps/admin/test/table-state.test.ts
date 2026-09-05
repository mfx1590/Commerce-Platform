import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  ariaSort,
  describeRange,
  nextSort,
  pageCount,
  parseTableQuery,
  toContractQuery,
  toSearchParams,
  withFilter,
  withPage,
  type TableQuery,
} from '@/lib/table/query-state';
import {
  EMPTY_SELECTION,
  canOfferSelectAll,
  describeSelection,
  isPageFullySelected,
  isRowSelected,
  selectAllMatching,
  selectionCount,
  togglePage,
  toggleRow,
} from '@/lib/table/selection';

const params = (search: string) => new URLSearchParams(search);
const base = (overrides: Partial<TableQuery> = {}): TableQuery => ({
  page: 1,
  limit: DEFAULT_LIMIT,
  sort: null,
  order: 'desc',
  filters: {},
  ...overrides,
});

describe('parseTableQuery', () => {
  it('defaults an empty query string', () => {
    expect(parseTableQuery(params(''))).toEqual(base());
  });

  it('reads page, limit, sort, order and the declared filters', () => {
    expect(
      parseTableQuery(params('page=3&limit=50&sort=title&order=asc&q=tee&status=draft'), [
        'q',
        'status',
      ]),
    ).toEqual(
      base({
        page: 3,
        limit: 50,
        sort: 'title',
        order: 'asc',
        filters: { q: 'tee', status: 'draft' },
      }),
    );
  });

  it('ignores query parameters that are not declared filters', () => {
    // Forwarding an undeclared parameter to the Admin API would be a 400.
    const query = parseTableQuery(params('q=tee&injected=1'), ['q']);
    expect(query.filters).toEqual({ q: 'tee' });
  });

  it('falls back on nonsense rather than sending it to the server', () => {
    expect(parseTableQuery(params('page=0&limit=-3&order=sideways'))).toEqual(base());
    expect(parseTableQuery(params('page=abc'))).toEqual(base());
  });

  it('caps limit at the contract maximum of 100', () => {
    expect(parseTableQuery(params('limit=5000')).limit).toBe(100);
  });

  it('drops empty filter values', () => {
    expect(parseTableQuery(params('q='), ['q']).filters).toEqual({});
  });
});

describe('toSearchParams', () => {
  it('omits everything at its default so the clean URL stays clean', () => {
    expect(toSearchParams(base())).toEqual('');
  });

  it('round-trips a full query', () => {
    const query = base({ page: 2, limit: 50, sort: 'title', order: 'asc', filters: { q: 'tee' } });
    expect(parseTableQuery(params(toSearchParams(query)), ['q'])).toEqual(query);
  });

  it('omits order when it matches the default', () => {
    expect(toSearchParams(base({ sort: 'title', order: 'desc' }))).toEqual('sort=title');
  });

  it('omits sort when it matches the declared default sort', () => {
    expect(toSearchParams(base({ sort: 'created_at' }), { sort: 'created_at' })).toEqual('');
  });
});

describe('sorting updates the query string', () => {
  it('cycles unsorted → desc → asc → unsorted', () => {
    let query = base();
    query = nextSort(query, 'title');
    expect(toSearchParams(query)).toEqual('sort=title');

    query = nextSort(query, 'title');
    expect(toSearchParams(query)).toEqual('sort=title&order=asc');

    query = nextSort(query, 'title');
    expect(toSearchParams(query)).toEqual('');
  });

  it('switching column starts at descending again', () => {
    const query = nextSort(base({ sort: 'title', order: 'asc' }), 'status');
    expect(query).toMatchObject({ sort: 'status', order: 'desc' });
  });

  it('returns to page 1, because page 4 of the old order is meaningless', () => {
    expect(nextSort(base({ page: 4 }), 'title').page).toBe(1);
  });

  it('reports aria-sort for the header', () => {
    expect(ariaSort(base({ sort: 'title', order: 'asc' }), 'title')).toEqual('ascending');
    expect(ariaSort(base({ sort: 'title', order: 'desc' }), 'title')).toEqual('descending');
    expect(ariaSort(base({ sort: 'title' }), 'status')).toEqual('none');
  });
});

describe('paging and filtering update the query string', () => {
  it('writes the page number and drops it again at page 1', () => {
    expect(toSearchParams(withPage(base(), 3))).toEqual('page=3');
    expect(toSearchParams(withPage(base({ page: 3 }), 1))).toEqual('');
  });

  it('never goes below page 1', () => {
    expect(withPage(base(), 0).page).toBe(1);
    expect(withPage(base(), -5).page).toBe(1);
  });

  it('resets to page 1 when the filter changes', () => {
    expect(withFilter(base({ page: 7 }), 'q', 'tee')).toMatchObject({
      page: 1,
      filters: { q: 'tee' },
    });
  });

  it('clears a filter with an empty value', () => {
    expect(withFilter(base({ filters: { q: 'tee' } }), 'q', '').filters).toEqual({});
    expect(withFilter(base({ filters: { q: 'tee' } }), 'q', null).filters).toEqual({});
  });
});

describe('toContractQuery', () => {
  it('sends page, limit and the filters', () => {
    expect(toContractQuery(base({ page: 2, filters: { q: 'tee', status: 'draft' } }))).toEqual({
      page: 2,
      limit: 20,
      q: 'tee',
      status: 'draft',
    });
  });

  it('withholds sort and order by default — contracts-v0.1 defines neither (see #56)', () => {
    expect(toContractQuery(base({ sort: 'title', order: 'asc' }))).toEqual({ page: 1, limit: 20 });
  });

  it('forwards them once an operation is declared sortable', () => {
    expect(toContractQuery(base({ sort: 'title', order: 'asc' }), { sortable: true })).toEqual({
      page: 1,
      limit: 20,
      sort: 'title',
      order: 'asc',
    });
  });
});

describe('range and page count', () => {
  it('describes the visible slice', () => {
    expect(describeRange(1, 20, 137)).toEqual('1–20 of 137');
    expect(describeRange(7, 20, 137)).toEqual('121–137 of 137');
  });

  it('says nothing when there is nothing', () => {
    expect(describeRange(1, 20, 0)).toEqual('');
  });

  it('is honest when the page is past the end', () => {
    expect(describeRange(99, 20, 137)).toEqual('0 of 137');
  });

  it('counts pages', () => {
    expect(pageCount(137, 20)).toBe(7);
    expect(pageCount(0, 20)).toBe(0);
    expect(pageCount(20, 20)).toBe(1);
  });
});

describe('selection never silently spreads beyond the page', () => {
  const page1 = ['a', 'b', 'c'];
  const page2 = ['d', 'e', 'f'];

  it('ticking the header selects only the visible page', () => {
    const selection = togglePage(EMPTY_SELECTION, page1);
    expect(selectionCount(selection)).toBe(3);
    expect(isRowSelected(selection, 'd')).toBe(false);
  });

  it('offers the escalation only once a full page is ticked and more rows exist', () => {
    expect(canOfferSelectAll(EMPTY_SELECTION, page1, 137)).toBe(false);
    expect(canOfferSelectAll(togglePage(EMPTY_SELECTION, page1), page1, 137)).toBe(true);
    // Nothing to escalate to when the page is the whole result set.
    expect(canOfferSelectAll(togglePage(EMPTY_SELECTION, page1), page1, 3)).toBe(false);
  });

  it('escalating is a separate, explicit act', () => {
    const selection = selectAllMatching(137);
    expect(selectionCount(selection)).toBe(137);
    expect(describeSelection(selection)).toEqual('All 137 rows matching the current filter');
  });

  it('lets rows be excluded from an all-matching selection', () => {
    let selection = selectAllMatching(137);
    selection = toggleRow(selection, 'a');
    expect(selectionCount(selection)).toBe(136);
    expect(isRowSelected(selection, 'a')).toBe(false);
    expect(isRowSelected(selection, 'zzz')).toBe(true);
  });

  it('does not re-offer the escalation once it has been taken', () => {
    expect(canOfferSelectAll(selectAllMatching(137), page1, 137)).toBe(false);
  });

  it('accumulates deliberate ticks across pages', () => {
    let selection = togglePage(EMPTY_SELECTION, page1);
    selection = togglePage(selection, page2);
    expect(selectionCount(selection)).toBe(6);
    expect(isPageFullySelected(selection, page1)).toBe(true);
  });

  it('unticking a full page clears just that page', () => {
    let selection = togglePage(togglePage(EMPTY_SELECTION, page1), page2);
    selection = togglePage(selection, page2);
    expect(selectionCount(selection)).toBe(3);
    expect(isRowSelected(selection, 'd')).toBe(false);
  });

  it('toggles a single row both ways', () => {
    let selection = toggleRow(EMPTY_SELECTION, 'a');
    expect(isRowSelected(selection, 'a')).toBe(true);
    selection = toggleRow(selection, 'a');
    expect(selectionCount(selection)).toBe(0);
  });

  it('describes an empty selection without pretending', () => {
    expect(describeSelection(EMPTY_SELECTION)).toEqual('Nothing selected');
    expect(describeSelection(toggleRow(EMPTY_SELECTION, 'a'))).toEqual('1 row selected');
  });

  it('an empty page is never "fully selected"', () => {
    expect(isPageFullySelected(EMPTY_SELECTION, [])).toBe(false);
  });
});
