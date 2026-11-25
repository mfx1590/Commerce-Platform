/**
 * Customers as a working list (#870 wave 1 item 4, PR A): the group picker, group names, and the
 * email that used to travel in a URL.
 *
 * The privacy assertions are the point of this file. A customer's email address must not appear in
 * a link, because a URL reaches browser history, the referrer of anything the next page loads, and
 * any log that records paths — none of which is a place personal data belongs.
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { principals, SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/store-1/customers',
}));
vi.mock('@/components/shell/section-guard', () => ({
  StoreSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/roles', () => ({ isServiceAccount: () => false }));

const principalOf = vi.hoisted(() => ({ current: 'support' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true as const,
    status: 200,
    data: principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  listCustomerGroups: vi.fn(),
  getCustomer: vi.fn(),
  listOrders: vi.fn(),
  getStore: vi.fn(),
  listAuditLog: vi.fn(),
  listUsers: vi.fn(),
  // #870 item 4 PR B: the detail page reads these too, and this file renders it for the href check.
  listCustomerAddresses: vi.fn(),
  listCustomerConsents: vi.fn(),
  getCustomerIdentity: vi.fn(),
  listStores: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const CustomersPage = (await import('@/app/(store)/[storeId]/customers/page')).default;
const CustomerDetailPage = (await import('@/app/(store)/[storeId]/customers/[customerId]/page'))
  .default;
const OrdersPage = (await import('@/app/(store)/[storeId]/orders/page')).default;

const STORE = SEED.stores.brandA;
const CUSTOMER = '50000000-0000-4000-8000-000000000001';
const WHOLESALE = '51000000-0000-4000-8000-000000000001';
const EMAIL = 'jane@example.com';

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number) => ({
  ok: false as const,
  status,
  error: { code: 'forbidden', message: 'Forbidden' },
});
const pageOf = <T,>(items: T[]) => ok({ page: 1, limit: 20, total: items.length, items });

const customer = (over: Record<string, unknown> = {}) => ({
  id: CUSTOMER,
  identity_id: null,
  email: EMAIL,
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+31 6 12345678',
  status: 'registered',
  customer_group_id: WHOLESALE,
  consent: {},
  metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const params = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ storeId: STORE }),
  searchParams: Promise.resolve(extra),
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'support';
  api.listCustomers.mockResolvedValue(pageOf([customer()]));
  api.listCustomerGroups.mockResolvedValue(
    ok({ items: [{ id: WHOLESALE, code: 'wholesale', name: 'Wholesale' }] }),
  );
  api.getCustomer.mockResolvedValue(ok(customer()));
  api.listOrders.mockResolvedValue(pageOf([]));
  api.getStore.mockResolvedValue(ok({ id: STORE, default_locale: 'en-GB', settings: {} }));
  api.listAuditLog.mockResolvedValue(pageOf([]));
  api.listCustomerAddresses.mockResolvedValue(ok({ items: [] }));
  api.listCustomerConsents.mockResolvedValue(ok({ items: [] }));
  api.listStores.mockResolvedValue(pageOf([]));
  api.listUsers.mockResolvedValue(pageOf([]));
});

describe('the customers list has a group picker at last', () => {
  it('offers the store’s groups by name and filters on the one chosen', async () => {
    render(await CustomersPage(params({ group_id: WHOLESALE })));

    const picker = screen.getByRole('combobox', { name: /group/i });
    expect(within(picker).getByRole('option', { name: 'Wholesale' })).toBeTruthy();
    expect(within(picker).getByRole('option', { name: 'Any group' })).toBeTruthy();
    expect((picker as HTMLSelectElement).value).toBe(WHOLESALE);
    // The filter is the contract's own parameter, so the server does the filtering.
    expect(api.listCustomers).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({ group_id: WHOLESALE }),
    );
  });

  it('shows the group’s NAME in the row, not eight characters of a uuid', async () => {
    render(await CustomersPage(params()));
    const table = screen.getByRole('table', { name: 'Customers' });
    expect(within(table).getByText('Wholesale')).toBeTruthy();
    expect(within(table).queryByText(`${WHOLESALE.slice(0, 8)}…`)).toBeNull();
  });

  it('keeps the id when a group cannot be named, rather than reading as "no group"', async () => {
    api.listCustomerGroups.mockResolvedValue(ok({ items: [] }));
    render(await CustomersPage(params()));
    const table = screen.getByRole('table', { name: 'Customers' });
    expect(within(table).getByText(`${WHOLESALE.slice(0, 8)}…`)).toBeTruthy();
  });

  it('a refused group read leaves the list working and says what happened', async () => {
    api.listCustomerGroups.mockResolvedValue(fail(403));
    render(await CustomersPage(params()));
    expect(screen.getByRole('table', { name: 'Customers' })).toBeTruthy();
    expect(screen.getByRole('note')).toHaveTextContent(/group list could not be read \(403\)/);
  });

  it('offers no CSV export of the list, because that would be a bulk PII extraction', async () => {
    render(await CustomersPage(params()));
    expect(screen.queryByRole('link', { name: /csv/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });
});

describe("the customer's orders link no longer carries their email", () => {
  it('links by customer id, and the email appears in no href on the page', async () => {
    render(
      await CustomerDetailPage({
        params: Promise.resolve({ storeId: STORE, customerId: CUSTOMER }),
      }),
    );

    const link = screen.getByRole('link', { name: 'Orders by this customer' });
    expect(link.getAttribute('href')).toBe(`/${STORE}/orders?customer_id=${CUSTOMER}`);

    // The whole page: no href may contain the address, encoded or not.
    for (const anchor of screen.getAllByRole('link')) {
      const href = anchor.getAttribute('href') ?? '';
      expect(href).not.toContain(EMAIL);
      expect(href).not.toContain(encodeURIComponent(EMAIL));
      expect(href).not.toContain('jane%40example');
    }
  });
});

describe('the orders list honours that link', () => {
  it('sends customer_id to the API — a key it did not parse would show every order', async () => {
    render(await OrdersPage(params({ customer_id: CUSTOMER })));
    expect(api.listOrders).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({ customer_id: CUSTOMER }),
    );
  });

  it('says the list is filtered, and offers the way out of it', async () => {
    render(await OrdersPage(params({ customer_id: CUSTOMER })));
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/Showing one customer/);
    expect(within(note).getByRole('link', { name: 'Open the customer' }).getAttribute('href')).toBe(
      `/${STORE}/customers/${CUSTOMER}`,
    );
    expect(within(note).getByRole('link', { name: 'Show all orders' }).getAttribute('href')).toBe(
      `/${STORE}/orders`,
    );
  });

  it('shows no such note when the list is not filtered to a customer', async () => {
    render(await OrdersPage(params()));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
