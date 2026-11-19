/**
 * Table tooling in the browser (#870 wave 1 item 2): the page-size picker, a bulk action from ask
 * to per-row report, the filter controls for parameters the API already took, and the orders bulk
 * bar offered only to who may cancel.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColumnDef } from '@tanstack/react-table';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkAction } from '@/components/table/bulk-action';
import { DataTable, pageSizeOptions } from '@/components/table/data-table';
import { DateRangeFilter, SelectFilter, dayRange } from '@/components/table/url-filters';
import type { BulkReport } from '@/lib/table/bulk';
import { DEFAULT_LIMIT, type TableQuery } from '@/lib/table/query-state';
import type { Selection } from '@/lib/table/selection';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/s/catalog',
}));
const bulkOrders = vi.hoisted(() => ({ bulkCancelOrdersAction: vi.fn() }));
vi.mock('@/app/actions/bulk-orders', () => bulkOrders);
const exportLists = vi.hoisted(() => ({
  exportOrdersCsvAction: vi.fn(),
  exportProductsCsvAction: vi.fn(),
}));
vi.mock('@/app/actions/export-lists', () => exportLists);
const bulkCapture = vi.hoisted(() => ({
  previewBulkCaptureAction: vi.fn(),
  bulkCaptureAction: vi.fn(),
}));
vi.mock('@/app/actions/bulk-capture', () => bulkCapture);

const { OrdersTable } = await import('@/app/(store)/[storeId]/orders/orders-table');

const query = (overrides: Partial<TableQuery> = {}): TableQuery => ({
  page: 1,
  limit: DEFAULT_LIMIT,
  sort: null,
  order: 'desc',
  filters: {},
  ...overrides,
});
const ID_1 = '10000000-0000-4000-8000-000000000001';
const ID_2 = '10000000-0000-4000-8000-000000000002';
const pushed = () => new URL(router.push.mock.calls.at(-1)?.[0] as string, 'http://admin.test');

beforeEach(() => vi.clearAllMocks());

describe('page-size picker', () => {
  const columns: ColumnDef<{ id: string }, unknown>[] = [
    { id: 'id', header: 'Id', accessorKey: 'id' },
  ];

  it('writes limit and goes back to page 1', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        rows={[{ id: ID_1 }]}
        total={120}
        query={query({ page: 3 })}
        getRowId={(row) => row.id}
        caption="Things"
      />,
    );
    await user.selectOptions(screen.getByLabelText('Rows per page of Things'), '50');
    expect(pushed().searchParams.get('limit')).toBe('50');
    expect(pushed().searchParams.get('page')).toBeNull();
  });

  it('offers 20 / 50 / 100, plus a size set by hand in the URL', () => {
    expect(pageSizeOptions(20)).toEqual([20, 50, 100]);
    expect(pageSizeOptions(37)).toEqual([20, 37, 50, 100]);
  });
});

describe('BulkAction', () => {
  const rows: Selection = { mode: 'rows', ids: new Set([ID_1, ID_2]) };
  const report: BulkReport = {
    results: [
      { id: ID_1, label: 'Linen towel', outcome: 'done', message: 'Published.' },
      { id: ID_2, label: 'Tea towel', outcome: 'unknown', message: 'Outcome unknown (reset).' },
    ],
    counts: { done: 1, skipped: 0, failed: 0, unknown: 1, refused: 0 },
  };

  function setup(overrides: Partial<Parameters<typeof BulkAction>[0]> = {}) {
    const run = vi.fn().mockResolvedValue({ status: 'success', data: report });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BulkAction
        label="Publish"
        noun={{ one: 'product', many: 'products' }}
        selection={rows}
        filters={{ status: 'draft' }}
        run={run}
        onClose={onClose}
        question={(_, words) => `Publish ${words}?`}
        {...overrides}
      />,
    );
    return { run, onClose, user };
  }

  it('asks with the count, sends the ids, reports every row with what needs attention first', async () => {
    const { run, onClose, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Publish 2 products?' });
    expect(run).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, publish 2 products' }));
    expect(run).toHaveBeenCalledWith({ mode: 'rows', ids: [ID_1, ID_2] }, '');
    const results = await screen.findByRole('region', { name: 'Publish results' });
    expect(within(results).getByRole('status')).toHaveTextContent(
      'Publish: 1 done · 1 outcome unknown',
    );
    const items = within(results).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Outcome unknownTea towelOutcome unknown (reset).');
    expect(items[1]).toHaveTextContent('DoneLinen towel');
    expect(router.refresh).toHaveBeenCalled();
    await user.click(within(results).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('"all matching" sends the filters, the total and the unticked rows', async () => {
    const { run, user } = setup({
      selection: { mode: 'all-matching', total: 40, excluded: new Set([ID_2]) },
    });
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish 39 products' }));
    expect(run).toHaveBeenCalledWith(
      { mode: 'all-matching', total: 40, excluded: [ID_2], filters: { status: 'draft' } },
      '',
    );
  });

  it('a required reason holds the button until given, and is sent trimmed', async () => {
    const { run, user } = setup({
      label: 'Cancel…',
      reason: { label: 'Reason' },
      question: (_, words) => `Cancel ${words}?`,
    });
    await user.click(screen.getByRole('button', { name: 'Cancel…' }));
    const yes = screen.getByRole('button', { name: 'Yes, cancel 2 products' });
    expect(yes).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), '  out of stock ');
    await user.click(yes);
    expect(run).toHaveBeenCalledWith(expect.anything(), 'out of stock');
  });

  it('a refusal of the whole action is shown, no report', async () => {
    const { user } = setup({
      run: vi.fn().mockResolvedValue({
        status: 'error',
        fieldErrors: {},
        formError: 'The list changed since you selected it (40 → 41 matching).',
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(screen.getByRole('button', { name: 'Yes, publish 2 products' }));
    expect(await screen.findByText(/The list changed since you selected it/)).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});

describe('filters for parameters the API already takes', () => {
  it('SelectFilter writes its key and goes back to page 1', async () => {
    const user = userEvent.setup();
    render(
      <SelectFilter
        query={query({ page: 4 })}
        filterKey="category_id"
        label="Category"
        anyLabel="Any category"
        options={[{ value: ID_1, label: 'Kitchen' }]}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Category'), ID_1);
    expect(pushed().searchParams.get('category_id')).toBe(ID_1);
    expect(pushed().searchParams.get('page')).toBeNull();
  });

  it('SelectFilter keeps a value from the URL that the list no longer offers', () => {
    render(
      <SelectFilter
        query={query({ filters: { category_id: ID_2 } })}
        filterKey="category_id"
        label="Category"
        anyLabel="Any category"
        options={[{ value: ID_1, label: 'Kitchen' }]}
      />,
    );
    expect(screen.getByLabelText('Category')).toHaveValue(ID_2);
  });

  it('DateRangeFilter sends whole days as date-times, both ends inclusive', async () => {
    const user = userEvent.setup();
    render(
      <DateRangeFilter query={query()} fromKey="placed_from" toKey="placed_to" label="Placed" />,
    );
    const group = screen.getByRole('group', { name: 'Placed' });
    await user.type(within(group).getByLabelText('From'), '2026-11-01');
    await user.type(within(group).getByLabelText('To'), '2026-11-13');
    await user.click(within(group).getByRole('button', { name: 'Apply' }));
    expect(pushed().searchParams.get('placed_from')).toBe('2026-11-01T00:00:00.000Z');
    expect(pushed().searchParams.get('placed_to')).toBe('2026-11-13T23:59:59.999Z');
    expect(dayRange('', '')).toEqual({ from: null, to: null });
  });
});

describe('orders: the bulk bar only for who may cancel', () => {
  const order = {
    id: ID_1,
    display_id: 1042,
    email: 'a@example.com',
    status: 'confirmed',
    payment_status: 'authorized',
    fulfillment_status: 'not_fulfilled',
    total: { amount_minor: 1200, currency: 'EUR' },
    placed_at: '2026-11-10T10:00:00Z',
  };
  const table = (canCancel: boolean) =>
    render(
      <OrdersTable
        storeId="00000000-0000-4000-8000-000000000031"
        locale="en-GB"
        rows={[order] as never}
        total={1}
        query={query()}
        canCancel={canCancel}
      />,
    );

  it('without cancelOrder: no selection at all', () => {
    table(false);
    expect(screen.queryByRole('checkbox', { name: /^Select / })).not.toBeInTheDocument();
  });

  it('with it: ticking a row offers "Cancel…", which asks for a reason', async () => {
    const user = userEvent.setup();
    table(true);
    await user.click(screen.getByRole('checkbox', { name: `Select row ${ID_1}` }));
    await user.click(screen.getByRole('button', { name: 'Cancel…' }));
    expect(screen.getByRole('alertdialog', { name: /^Cancel 1 order\?/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Reason (sent with every order)')).toBeInTheDocument();
  });
});

describe('#870 part 1 (manager decisions): scope in words, no-undo confirmation, CSV', () => {
  const report: BulkReport = {
    results: [{ id: ID_1, label: 'Linen towel', outcome: 'failed', message: 'gone' }],
    counts: { done: 0, skipped: 0, failed: 1, unknown: 0, refused: 0 },
  };
  let clicked: string[] = [];
  beforeEach(() => {
    clicked = [];
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
  });

  it('"all matching" states the exact count and the filters it acts on, in words', async () => {
    const user = userEvent.setup();
    render(
      <BulkAction
        label="Publish"
        noun={{ one: 'product', many: 'products' }}
        selection={{ mode: 'all-matching', total: 40, excluded: new Set([ID_2]) }}
        filters={{ status: 'draft', category_id: ID_1 }}
        filterNames={{
          status: { label: 'Status' },
          category_id: { label: 'Category', value: () => 'Kitchen' },
        }}
        run={vi.fn()}
        onClose={vi.fn()}
        question={(_, words) => `Publish ${words}?`}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByLabelText('What this acts on')).toHaveTextContent(
      'Exactly 39 products: every one matching Status: draft · Category: Kitchen, except the 1 unticked.',
    );
  });

  it('unfiltered "all matching" says so; ticked rows say "the ones ticked"', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <BulkAction
        label="Publish"
        noun={{ one: 'product', many: 'products' }}
        selection={{ mode: 'all-matching', total: 7, excluded: new Set() }}
        filters={{}}
        run={vi.fn()}
        onClose={vi.fn()}
        question={(_, words) => `Publish ${words}?`}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByLabelText('What this acts on')).toHaveTextContent(
      'every one matching no filter (the whole list)',
    );
    unmount();
    render(
      <BulkAction
        label="Publish"
        noun={{ one: 'product', many: 'products' }}
        selection={{ mode: 'rows', ids: new Set([ID_1]) }}
        filters={{}}
        run={vi.fn()}
        onClose={vi.fn()}
        question={(_, words) => `Publish ${words}?`}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByLabelText('What this acts on')).toHaveTextContent(
      'Exactly 1 product: the ones ticked.',
    );
  });

  it('a destructive action needs the count typed before Yes is offered', async () => {
    const user = userEvent.setup();
    const run = vi.fn().mockResolvedValue({ status: 'success', data: report });
    render(
      <BulkAction
        label="Archive…"
        noun={{ one: 'product', many: 'products' }}
        selection={{ mode: 'rows', ids: new Set([ID_1, ID_2]) }}
        filters={{}}
        run={run}
        onClose={vi.fn()}
        destructive
        question={(_, words) => `Archive ${words}?`}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    const yes = screen.getByRole('button', { name: 'Yes, archive 2 products' });
    expect(yes).toBeDisabled();
    await user.type(screen.getByLabelText('Type 2 to confirm'), '3');
    expect(yes).toBeDisabled();
    await user.clear(screen.getByLabelText('Type 2 to confirm'));
    await user.type(screen.getByLabelText('Type 2 to confirm'), '2');
    await user.click(yes);
    expect(run).toHaveBeenCalledTimes(1);
    // The report downloads as CSV, every row.
    await user.click(await screen.findByRole('button', { name: 'Download results (CSV)' }));
    expect(clicked[0]).toMatch(/^products-archive-results-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.csv$/);
  });

  it('Export CSV states the cap, downloads, and says when the file holds only the first rows', async () => {
    const { ExportCsvButton } = await import('@/components/table/export-csv');
    const user = userEvent.setup();
    const run = vi.fn().mockResolvedValue({
      status: 'success',
      data: { csv: 'id\r\n', exported: 1000, total: 1400, truncated: true },
    });
    render(<ExportCsvButton what="orders" run={run} />);
    await user.click(screen.getByRole('button', { name: 'Export CSV (up to 1,000 rows)' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Exported the first 1000 of 1400 rows in this order (the cap is 1,000). Narrow the filter for the rest.',
    );
    expect(clicked[0]).toMatch(/^orders-.*\.csv$/);
  });

  it('a refused export is shown, nothing downloaded', async () => {
    const { ExportCsvButton } = await import('@/components/table/export-csv');
    const user = userEvent.setup();
    render(
      <ExportCsvButton
        what="orders"
        run={vi.fn().mockResolvedValue({
          status: 'error',
          fieldErrors: {},
          formError: 'You do not have access to this store.',
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Export CSV/ }));
    expect(await screen.findByText('You do not have access to this store.')).toBeInTheDocument();
    expect(clicked).toEqual([]);
  });
});

describe('#904 review: a run that never comes back, and honest copy', () => {
  it('a thrown run is "outcome unknown": nothing retried, the list reloaded, check first', async () => {
    const user = userEvent.setup();
    const run = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const onClose = vi.fn();
    render(
      <BulkAction
        label="Cancel…"
        noun={{ one: 'order', many: 'orders' }}
        selection={{ mode: 'rows', ids: new Set([ID_1]) }}
        filters={{}}
        run={run}
        onClose={onClose}
        destructive
        question={(_, words) => `Cancel ${words}?`}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel…' }));
    await user.type(screen.getByLabelText('Type 1 to confirm'), '1');
    await user.click(screen.getByRole('button', { name: 'Yes, cancel 1 order' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cancel: outcome unknown — the request did not come back.');
    expect(alert).toHaveTextContent('Reload the list and check them before running it again');
    expect(run).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Yes, / })).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a thrown export says so and downloads nothing', async () => {
    const { ExportCsvButton } = await import('@/components/table/export-csv');
    const user = userEvent.setup();
    render(<ExportCsvButton what="orders" run={vi.fn().mockRejectedValue(new Error('x'))} />);
    await user.click(screen.getByRole('button', { name: /^Export CSV/ }));
    expect(
      await screen.findByText('The export did not come back. Try again; nothing was changed.'),
    ).toBeInTheDocument();
  });

  it('the date range says its days are UTC', () => {
    render(
      <DateRangeFilter query={query()} fromKey="placed_from" toKey="placed_to" label="Placed" />,
    );
    expect(screen.getByRole('group', { name: 'Placed' })).toHaveTextContent('(whole days, UTC)');
  });

  it('bulk cancel says a captured payment is not refunded, and no longer claims cancelled ones are skipped by the API', async () => {
    const user = userEvent.setup();
    render(
      <OrdersTable
        storeId="00000000-0000-4000-8000-000000000031"
        locale="en-GB"
        rows={
          [
            {
              id: ID_1,
              display_id: 1042,
              email: 'a@example.com',
              status: 'confirmed',
              payment_status: 'captured',
              fulfillment_status: 'not_fulfilled',
              total: { amount_minor: 1200, currency: 'EUR' },
              placed_at: '2026-11-10T10:00:00Z',
            },
          ] as never
        }
        total={1}
        query={query()}
        canCancel
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: `Select row ${ID_1}` }));
    await user.click(screen.getByRole('button', { name: 'Cancel…' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('A payment already CAPTURED is NOT refunded by cancelling');
    expect(dialog).toHaveTextContent('refund needed');
    expect(dialog).not.toHaveTextContent('are skipped');
  });
});
