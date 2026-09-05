import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/table/data-table';
import { Button } from '@/components/ui/button';
import { DEFAULT_LIMIT, type TableQuery } from '@/lib/table/query-state';
import { describeSelection, type Selection } from '@/lib/table/selection';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/stores',
}));

interface Row {
  id: string;
  code: string;
  status: string;
}

const columns: ColumnDef<Row, unknown>[] = [
  { id: 'code', header: 'Code', accessorKey: 'code' },
  { id: 'status', header: 'Status', accessorKey: 'status' },
];

const rows: Row[] = [
  { id: 'a', code: 'brand-a', status: 'active' },
  { id: 'b', code: 'brand-b', status: 'active' },
  { id: 'c', code: 'brand-c', status: 'draft' },
];

const query = (overrides: Partial<TableQuery> = {}): TableQuery => ({
  page: 1,
  limit: DEFAULT_LIMIT,
  sort: null,
  order: 'desc',
  filters: {},
  ...overrides,
});

function renderTable(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable<Row>
      columns={columns}
      rows={rows}
      total={137}
      query={query()}
      getRowId={(row) => row.id}
      caption="Stores"
      sortableColumns={['code']}
      {...props}
    />,
  );
}

beforeEach(() => {
  push.mockClear();
});

describe('rendering', () => {
  it('renders a labelled table with one row per item', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'Stores' });
    expect(within(table).getAllByRole('row')).toHaveLength(rows.length + 1);
    expect(within(table).getByText('brand-a')).toBeInTheDocument();
  });

  it('shows the visible range and page count', () => {
    renderTable();
    expect(screen.getByText('1–20 of 137')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 7')).toBeInTheDocument();
  });

  it('renders an empty state instead of an empty table', () => {
    renderTable({ rows: [], total: 0 });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No stores yet')).toBeInTheDocument();
  });

  it('says so when a filter is what emptied it', () => {
    renderTable({ rows: [], total: 0, query: query({ filters: { q: 'zzz' } }) });
    expect(screen.getByText('Nothing matches the current filter.')).toBeInTheDocument();
  });

  it('renders the error panel in place of the rows', () => {
    renderTable({
      error: { status: 403, error: { code: 'forbidden', message: 'requires viewer' } },
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Admin API returned 403')).toBeInTheDocument();
  });
});

describe('sorting updates the query string', () => {
  it('pushes sort=code on the first click of a sortable header', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('button', { name: /Code/ }));
    expect(push).toHaveBeenCalledWith('/stores?sort=code');
  });

  it('pushes the ascending order on the second click', async () => {
    const user = userEvent.setup();
    renderTable({ query: query({ sort: 'code', order: 'desc' }) });
    await user.click(screen.getByRole('button', { name: /Code/ }));
    expect(push).toHaveBeenCalledWith('/stores?sort=code&order=asc');
  });

  it('clears sorting on the third click, returning to the bare path', async () => {
    const user = userEvent.setup();
    renderTable({ query: query({ sort: 'code', order: 'asc' }) });
    await user.click(screen.getByRole('button', { name: /Code/ }));
    expect(push).toHaveBeenCalledWith('/stores');
  });

  it('announces the sort state on the header, not just in the icon', () => {
    renderTable({ query: query({ sort: 'code', order: 'asc' }) });
    expect(screen.getByRole('columnheader', { name: /Code/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    // A column that cannot be sorted must not claim it can.
    expect(screen.getByRole('columnheader', { name: 'Status' })).not.toHaveAttribute('aria-sort');
  });

  it('leaves non-sortable headers as plain text, not buttons', () => {
    renderTable();
    expect(screen.queryByRole('button', { name: 'Status' })).toBeNull();
  });
});

describe('pagination updates the query string', () => {
  it('pushes the next page', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(push).toHaveBeenCalledWith('/stores?page=2');
  });

  it('drops the parameter when returning to page 1', async () => {
    const user = userEvent.setup();
    renderTable({ query: query({ page: 2 }) });
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(push).toHaveBeenCalledWith('/stores');
  });

  it('disables Previous on the first page and Next on the last', () => {
    renderTable();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    renderTable({ query: query({ page: 7 }) });
    expect(screen.getAllByRole('button', { name: 'Next' }).at(-1)).toBeDisabled();
  });

  it('keeps the filter while paging', async () => {
    const user = userEvent.setup();
    renderTable({ query: query({ filters: { q: 'brand' } }) });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(push).toHaveBeenCalledWith('/stores?q=brand&page=2');
  });
});

describe('bulk selection is never silent', () => {
  const bulkActions = (selection: Selection) => <Button>{describeSelection(selection)}</Button>;

  it('the header checkbox selects only the rows on this page', async () => {
    const user = userEvent.setup();
    renderTable({ bulkActions });
    await user.click(screen.getByRole('checkbox', { name: /Select all 3 rows on this page/ }));
    expect(screen.getByRole('status')).toHaveTextContent('3 rows selected');
  });

  it('offers the cross-page escalation as a separate, explicit button', async () => {
    const user = userEvent.setup();
    renderTable({ bulkActions });
    expect(screen.queryByRole('button', { name: /Select all 137 matching/ })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: /Select all 3 rows on this page/ }));
    await user.click(screen.getByRole('button', { name: 'Select all 137 matching' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'All 137 rows matching the current filter',
    );
  });

  it('does not offer it when the page is already the whole result set', async () => {
    const user = userEvent.setup();
    renderTable({ bulkActions, total: 3 });
    await user.click(screen.getByRole('checkbox', { name: /Select all 3 rows on this page/ }));
    expect(screen.queryByRole('button', { name: /Select all/ })).toBeNull();
  });

  it('lets a row be excluded after escalating', async () => {
    const user = userEvent.setup();
    renderTable({ bulkActions });
    await user.click(screen.getByRole('checkbox', { name: /Select all 3 rows on this page/ }));
    await user.click(screen.getByRole('button', { name: 'Select all 137 matching' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select row a' }));
    expect(screen.getByRole('status')).toHaveTextContent('All 136 rows');
  });

  it('clears the selection', async () => {
    const user = userEvent.setup();
    renderTable({ bulkActions });
    await user.click(screen.getByRole('checkbox', { name: /Select all 3 rows on this page/ }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no checkboxes at all when the table has no bulk actions', () => {
    renderTable();
    expect(screen.queryByRole('checkbox', { name: /Select row/ })).toBeNull();
  });
});

describe('column visibility', () => {
  it('hides a column without touching the URL', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByText('Columns'));
    await user.click(screen.getByRole('checkbox', { name: 'status' }));

    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Code/ })).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('search', () => {
  it('pushes the search term and returns to page 1', async () => {
    const user = userEvent.setup();
    renderTable({ searchKey: 'q', query: query({ page: 4 }) });
    await user.type(screen.getByRole('searchbox', { name: /Search Stores/ }), 'brand');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(push).toHaveBeenCalledWith('/stores?q=brand');
  });
});
