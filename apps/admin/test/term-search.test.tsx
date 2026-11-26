/**
 * #946: the customers and orders searches are POST-backed. The typed term (an email, a name, an order
 * number) travels in the server action's request body and NEVER reaches a router push, a rendered href,
 * or the address. Paging, sorting and page size within a search re-run the action, never `router.push`.
 * The actions refuse before the API, whitelist the filters, clamp page/limit, and answer projections.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';
import { order } from './fixtures/orders';

const TERM = 'jane.doe@example.com';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/store-1/list',
}));

const principalOf = vi.hoisted(() => ({ current: 'owner' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({ listCustomers: vi.fn(), listOrders: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);
const exportLists = vi.hoisted(() => ({
  exportOrdersCsvAction: vi.fn(),
  exportProductsCsvAction: vi.fn(),
}));
vi.mock('@/app/actions/export-lists', () => exportLists);
const bulkOrders = vi.hoisted(() => ({ bulkCancelOrdersAction: vi.fn() }));
vi.mock('@/app/actions/bulk-orders', () => bulkOrders);
// jsdom has no blob URLs; the CSV download needs one.
URL.createObjectURL = vi.fn(() => 'blob:test');
URL.revokeObjectURL = vi.fn();
vi.mock('@/app/actions/bulk-capture', () => ({
  bulkCaptureAction: vi.fn(),
  previewBulkCaptureAction: vi.fn(),
}));

const { searchCustomersAction, searchOrdersAction, MAX_SEARCH_TERM } =
  await import('@/app/actions/search-lists');
const { LIST_SEARCH_PERMISSIONS } = await import('@/lib/table/search-permissions');
const { CustomersTable } = await import('@/app/(store)/[storeId]/customers/customers-table');
const { OrdersTable } = await import('@/app/(store)/[storeId]/orders/orders-table');
const { forOrderRows } = await import('@/lib/orders/projection');
const { CUSTOMER_URL_FILTER_KEYS } =
  await import('@/app/(store)/[storeId]/customers/customers-table.config');
const { ORDER_URL_FILTER_KEYS } =
  await import('@/app/(store)/[storeId]/orders/orders-table.config');

const STORE = SEED.stores.brandA;
const request = { page: 1, limit: 20, sort: 'created_at', order: 'desc' as const, filters: {} };

function customer(n: number) {
  return {
    id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    identity_id: '30000000-0000-4000-8000-000000000b01',
    email: n === 1 ? TERM : `other${n}@example.com`,
    first_name: 'Jane',
    last_name: `Doe ${n}`,
    phone: '+31 6 0000 0000',
    customer_group_id: null,
    status: 'registered' as const,
    consent: {},
    created_at: '2026-09-04T10:00:00Z',
  };
}

beforeEach(() => {
  principalOf.current = 'owner';
  push.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listCustomers.mockResolvedValue({
    ok: true,
    status: 200,
    data: { page: 1, limit: 20, total: 1, items: [customer(1)] },
  });
  api.listOrders.mockResolvedValue({
    ok: true,
    status: 200,
    data: { page: 1, limit: 20, total: 1, items: [order()] },
  });
  exportLists.exportOrdersCsvAction.mockReset();
  exportLists.exportOrdersCsvAction.mockResolvedValue({
    status: 'success',
    data: { csv: 'id\n', filename: 'orders.csv', rows: 0, truncated: false },
  });
});

/** Every href in the document, and every URL the router was asked for. */
function everyAddress(container: HTMLElement): string[] {
  const hrefs = [...container.querySelectorAll('[href]')].map(
    (el) => el.getAttribute('href') ?? '',
  );
  const pushed = push.mock.calls.map(([url]) => String(url));
  return [...hrefs, ...pushed, window.location.href];
}
const leaks = (addresses: string[]) =>
  addresses.filter((a) => decodeURIComponent(a).includes(TERM) || /[?&]q=/.test(a));

describe('the search actions (POST)', () => {
  it('customers: refused without support on the store, before the API', async () => {
    principalOf.current = 'analyst';
    const result = await searchCustomersAction(STORE, TERM, request);
    expect(result).toMatchObject({ status: 'error', refusal: { status: 403 } });
    expect(api.listCustomers).not.toHaveBeenCalled();
  });

  it('orders: refused for an account that holds nothing, before the API', async () => {
    principalOf.current = 'unassigned';
    expect(await searchOrdersAction(STORE, TERM, request)).toMatchObject({ status: 'error' });
    expect(api.listOrders).not.toHaveBeenCalled();
  });

  it('sends the term as q, whitelists the filters (a q among them is dropped), clamps the limit', async () => {
    await searchOrdersAction(STORE, TERM, {
      page: 2,
      limit: 5000,
      sort: 'placed_at',
      order: 'asc',
      filters: { status: 'confirmed', q: 'smuggled', evil: 'x' },
    });
    expect(api.listOrders).toHaveBeenCalledWith(STORE, {
      page: 2,
      limit: 100,
      sort: 'placed_at',
      order: 'asc',
      status: 'confirmed',
      q: TERM,
    });
  });

  it('answers row projections only (no phone, no identity id, no raw consent)', async () => {
    const result = await searchCustomersAction(STORE, TERM, request);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.total).toBe(1);
      expect(Object.keys(result.data.rows[0]!)).not.toEqual(
        expect.arrayContaining(['phone', 'identity_id', 'consent']),
      );
    }
  });

  it.each([
    ['empty', '   '],
    ['too long', 'x'.repeat(MAX_SEARCH_TERM + 1)],
  ])('refuses a %s term before the API', async (_name, term) => {
    expect(await searchCustomersAction(STORE, term, request)).toMatchObject({ status: 'error' });
    expect(api.listCustomers).not.toHaveBeenCalled();
  });

  it('the address never carries q: the URL filter keys exclude it', () => {
    expect(CUSTOMER_URL_FILTER_KEYS).not.toContain('q');
    expect(ORDER_URL_FILTER_KEYS).not.toContain('q');
  });

  it('LIST_SEARCH_PERMISSIONS are the x-permission admin-api.yaml carries', () => {
    const spec = readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    for (const [operation, { relation }] of Object.entries(LIST_SEARCH_PERMISSIONS)) {
      const at = spec.indexOf(`operationId: ${operation}\n`);
      expect(at, operation).toBeGreaterThan(-1);
      const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
        spec.slice(at, at + 2000),
      );
      expect(permission?.[1], operation).toBe(relation);
    }
  });
});

const urlQuery = (filters: Record<string, string> = {}) => ({
  page: 1,
  limit: 20,
  sort: 'created_at' as string | null,
  order: 'desc' as const,
  filters,
});

describe('the customers table searches without the URL', () => {
  const urlRows = [
    {
      id: '30000000-0000-4000-8000-0000000000aa',
      email: 'listed@example.com',
      first_name: 'Listed',
      last_name: 'Person',
      status: 'registered',
      customer_group_id: null,
      consent_summary: '—',
      created_at: '2026-09-01T10:00:00Z',
    },
  ] as never;

  it('a submitted term runs the action; the rows are its answer; nothing is pushed; no address holds the term', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CustomersTable storeId={STORE} rows={urlRows} total={1} query={urlQuery()} />,
    );
    expect(screen.getByText(/Search terms aren.t kept in the address/)).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(within(screen.getByRole('table', { name: 'Customers' })).getByText(TERM)),
    );
    expect(api.listCustomers).toHaveBeenCalledWith(STORE, expect.objectContaining({ q: TERM }));
    expect(screen.queryByText('listed@example.com')).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(leaks(everyAddress(container))).toEqual([]);
  });

  it('paging, page size and sorting within a search re-run the action and never push the term', async () => {
    api.listCustomers.mockResolvedValue({
      ok: true,
      status: 200,
      data: { page: 1, limit: 20, total: 45, items: [customer(1), customer(2)] },
    });
    const user = userEvent.setup();
    const { container } = render(
      <CustomersTable storeId={STORE} rows={urlRows} total={1} query={urlQuery()} />,
    );
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.listCustomers).toHaveBeenLastCalledWith(
        STORE,
        expect.objectContaining({ q: TERM, page: 2 }),
      ),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /Rows per page/ }), '50');
    await waitFor(() =>
      expect(api.listCustomers).toHaveBeenLastCalledWith(
        STORE,
        expect.objectContaining({ q: TERM, page: 1, limit: 50 }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /^Email/ }));
    await waitFor(() =>
      expect(api.listCustomers).toHaveBeenLastCalledWith(
        STORE,
        expect.objectContaining({ q: TERM, sort: 'email' }),
      ),
    );
    expect(push).not.toHaveBeenCalled();
    expect(leaks(everyAddress(container))).toEqual([]);
  });

  it('a URL filter that changes while searching re-runs the search from page 1 with it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CustomersTable storeId={STORE} rows={urlRows} total={1} query={urlQuery()} />,
    );
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.listCustomers).toHaveBeenCalledTimes(1));
    const group = '40000000-0000-4000-8000-000000000001';
    rerender(
      <CustomersTable
        storeId={STORE}
        rows={urlRows}
        total={1}
        query={urlQuery({ group_id: group })}
      />,
    );
    await waitFor(() =>
      expect(api.listCustomers).toHaveBeenLastCalledWith(
        STORE,
        expect.objectContaining({ q: TERM, group_id: group, page: 1 }),
      ),
    );
  });

  it('Clear search goes back to the listed rows without navigating', async () => {
    const user = userEvent.setup();
    render(<CustomersTable storeId={STORE} rows={urlRows} total={1} query={urlQuery()} />);
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('listed@example.com')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('a failed search says so, never "no customers match"', async () => {
    api.listCustomers.mockResolvedValue({
      ok: false,
      status: 400,
      error: { code: 'invalid_request', message: 'q is too short' },
    });
    const user = userEvent.setup();
    render(<CustomersTable storeId={STORE} rows={urlRows} total={1} query={urlQuery()} />);
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/match this filter/)).toBeNull();
  });

  it('without a search, paging still uses the URL, and never with q', async () => {
    const user = userEvent.setup();
    render(
      <CustomersTable
        storeId={STORE}
        rows={urlRows}
        total={45}
        query={{ ...urlQuery(), filters: { group_id: 'g' } }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0]![0])).toContain('page=2');
    expect(String(push.mock.calls[0]![0])).not.toMatch(/[?&]q=/);
  });
});

describe('the orders table: the term reaches export and bulk only by POST', () => {
  it('bulk Cancel on "all matching" during a search acts on the SEARCHED set: the term is in the POST', async () => {
    api.listOrders.mockResolvedValue({
      ok: true,
      status: 200,
      data: { page: 1, limit: 20, total: 30, items: [order()] },
    });
    bulkOrders.bulkCancelOrdersAction.mockReset();
    bulkOrders.bulkCancelOrdersAction.mockResolvedValue({
      status: 'success',
      data: { results: [], counts: { done: 0, refused: 0, skipped: 0, failed: 0, unknown: 0 } },
    });
    const user = userEvent.setup();
    const { container } = render(
      <OrdersTable
        storeId={STORE}
        locale="en-GB"
        canCancel
        rows={forOrderRows([order({ email: 'listed@example.com' })])}
        total={1}
        query={{ ...urlQuery({ status: 'confirmed' }), sort: 'placed_at' }}
      />,
    );
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    // The searched rows first: the row checkboxes are disabled while the search is pending, and an answer
    // clears any selection made before it (#970 review), so ticking has to wait for the searched rows.
    expect(await screen.findByText('jane@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Select all 1 rows on this page/ }));
    await user.click(screen.getByRole('button', { name: 'Select all 30 matching' }));
    await user.click(screen.getByRole('button', { name: 'Cancel…' }));
    await user.type(screen.getByPlaceholderText('e.g. out of stock'), 'duplicate');
    await user.type(screen.getByRole('textbox', { name: 'Type 30 to confirm' }), '30');
    await user.click(screen.getByRole('button', { name: /^Yes, cancel/ }));
    await waitFor(() => expect(bulkOrders.bulkCancelOrdersAction).toHaveBeenCalled());
    const [store, selection] = bulkOrders.bulkCancelOrdersAction.mock.calls[0]!;
    expect(store).toBe(STORE);
    expect(selection).toMatchObject({
      mode: 'all-matching',
      filters: { status: 'confirmed', q: TERM },
    });
    // #970 review: closing the results runs the search again (router.refresh reloads only the URL rows).
    const before = api.listOrders.mock.calls.length;
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(api.listOrders.mock.calls.length).toBe(before + 1));
    expect(api.listOrders).toHaveBeenLastCalledWith(STORE, expect.objectContaining({ q: TERM }));
    expect(push).not.toHaveBeenCalled();
    expect(leaks(everyAddress(container))).toEqual([]);
  });

  it('rows cannot be ticked while a search is pending; the answer drops an earlier selection (#970 review)', async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.listOrders.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const user = userEvent.setup();
    render(
      <OrdersTable
        storeId={STORE}
        locale="en-GB"
        canCancel
        rows={forOrderRows([order({ email: 'listed@example.com' })])}
        total={1}
        query={{ ...urlQuery(), sort: 'placed_at' }}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: /Select all 1 rows on this page/ }));
    expect(screen.getByText('1 row selected')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    // Pending: nothing can be ticked. (The form action is a transition, so the term and the selection
    // reset commit together with the answer.)
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: /Select all 1 rows on this page/ }),
      ).toBeDisabled(),
    );
    answer({ ok: true, status: 200, data: { page: 1, limit: 20, total: 1, items: [order()] } });
    expect(await screen.findByText('jane@example.com')).toBeInTheDocument();
    expect(screen.queryByText('1 row selected')).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: /Select all 1 rows on this page/ }),
      ).toBeEnabled(),
    );
  });

  it('Export CSV during a search sends the term in the action body; the URL never holds it', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <OrdersTable
        storeId={STORE}
        locale="en-GB"
        rows={forOrderRows([order({ email: 'listed@example.com' })])}
        total={1}
        query={{ ...urlQuery({ status: 'confirmed' }), sort: 'placed_at' }}
      />,
    );
    await user.type(screen.getByRole('searchbox'), TERM);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(api.listOrders).toHaveBeenCalledWith(
        STORE,
        expect.objectContaining({ q: TERM, status: 'confirmed' }),
      ),
    );
    expect(await screen.findByText('jane@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() =>
      expect(exportLists.exportOrdersCsvAction).toHaveBeenCalledWith(
        STORE,
        { status: 'confirmed', q: TERM },
        expect.anything(),
      ),
    );
    expect(push).not.toHaveBeenCalled();
    expect(leaks(everyAddress(container))).toEqual([]);
  });
});
