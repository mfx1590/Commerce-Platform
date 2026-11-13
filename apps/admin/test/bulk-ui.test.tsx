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
