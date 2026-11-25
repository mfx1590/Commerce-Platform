/**
 * The customer detail page (#870 wave 1 item 4, PR B): addresses, the consent ledger, cross-brand
 * identity, and assigning a group by name.
 *
 * The privacy assertions are the point:
 *
 * - an address is rendered on the server and `Address` is one of the records
 *   `test/client-props-guard.test.ts` forbids a `'use client'` file from naming, so this file
 *   checks the *rendering*, and that guard checks the boundary;
 * - the identity panel answers with ids, so this file asserts the page makes **one** `getCustomer`
 *   call: resolving a sibling's name would be a second one, behind a gate this reader may not hold;
 * - `getCustomerIdentity` is never called by a principal the contract would refuse.
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addressLines, defaultLabels, sortAddresses } from '@/lib/customers/addresses';
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
vi.mock('@/app/actions/customers', () => ({
  updateCustomerAction: vi.fn(),
  eraseCustomerAction: vi.fn(),
}));

const principalOf = vi.hoisted(() => ({ current: 'support' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true as const,
    status: 200,
    data: principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({
  getCustomer: vi.fn(),
  listCustomerAddresses: vi.fn(),
  listCustomerConsents: vi.fn(),
  listCustomerGroups: vi.fn(),
  getCustomerIdentity: vi.fn(),
  listStores: vi.fn(),
  listAuditLog: vi.fn(),
  listUsers: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const CustomerDetailPage = (await import('@/app/(store)/[storeId]/customers/[customerId]/page'))
  .default;

const STORE = SEED.stores.brandA;
const OTHER_STORE = SEED.stores.brandB;
const CUSTOMER = '50000000-0000-4000-8000-000000000001';
const SIBLING = '50000000-0000-4000-8000-000000000002';
const IDENTITY = '52000000-0000-4000-8000-000000000001';
const GROUP = '51000000-0000-4000-8000-000000000001';

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number) => ({
  ok: false as const,
  status,
  error: { code: 'forbidden', message: 'Forbidden' },
});

const customer = (over: Record<string, unknown> = {}) => ({
  id: CUSTOMER,
  identity_id: IDENTITY,
  email: 'jane@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+31 6 12345678',
  status: 'registered',
  customer_group_id: GROUP,
  consent: {},
  metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const address = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  first_name: 'Jane',
  last_name: 'Doe',
  company: null,
  line1: 'Keizersgracht 1',
  line2: null,
  city: 'Amsterdam',
  region: null,
  postal_code: '1015 CJ',
  country: 'NL',
  phone: null,
  is_default_shipping: false,
  is_default_billing: false,
  ...over,
});

const render_ = () =>
  CustomerDetailPage({ params: Promise.resolve({ storeId: STORE, customerId: CUSTOMER }) });

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'support';
  api.getCustomer.mockResolvedValue(ok(customer()));
  api.listCustomerAddresses.mockResolvedValue(ok({ items: [address()] }));
  api.listCustomerConsents.mockResolvedValue(ok({ items: [] }));
  api.listCustomerGroups.mockResolvedValue(
    ok({ items: [{ id: GROUP, code: 'wholesale', name: 'Wholesale' }] }),
  );
  api.getCustomerIdentity.mockResolvedValue(
    ok({
      id: IDENTITY,
      customers: [
        { store_id: STORE, customer_id: CUSTOMER },
        { store_id: OTHER_STORE, customer_id: SIBLING },
      ],
    }),
  );
  api.listStores.mockResolvedValue(
    ok({
      page: 1,
      limit: 100,
      total: 2,
      items: [
        { id: STORE, name: 'Brand A', code: 'brand-a' },
        { id: OTHER_STORE, name: 'Brand B', code: 'brand-b' },
      ],
    }),
  );
  api.listAuditLog.mockResolvedValue(ok({ page: 1, limit: 20, total: 0, items: [] }));
  api.listUsers.mockResolvedValue(ok({ page: 1, limit: 100, total: 0, items: [] }));
});

describe('addresses', () => {
  it('renders the defaults first, omits the parts that are blank, and labels an address phone', async () => {
    api.listCustomerAddresses.mockResolvedValue(
      ok({
        items: [
          address({ id: 'plain', line1: 'Spui 2', city: 'Delft', postal_code: '2611 AA' }),
          address({
            id: 'ship',
            is_default_shipping: true,
            company: 'Doe BV',
            region: 'Noord-Holland',
            phone: '+31 20 1234567',
          }),
        ],
      }),
    );
    render(await render_());

    const list = screen.getByRole('list', { name: 'Saved addresses' });
    const items = within(list).getAllByRole('listitem');
    // Default shipping first, whatever order the API gave.
    expect(within(items[0]!).getByText('Default shipping')).toBeTruthy();
    expect(within(items[0]!).getByText('Doe BV')).toBeTruthy();
    expect(within(items[0]!).getByText('Amsterdam Noord-Holland 1015 CJ')).toBeTruthy();
    // An address phone is never shown as if it were the customer's own.
    expect(within(items[0]!).getByText(/Contact on this address: \+31 20 1234567/)).toBeTruthy();
    // No stray separators or empty lines from the null company/region/line2.
    expect(within(items[1]!).getByText('Delft 2611 AA')).toBeTruthy();
    expect(within(items[1]!).queryByText(/Contact on this address/)).toBeNull();
  });

  it('a refused read shows the refusal, not a missing panel', async () => {
    api.listCustomerAddresses.mockResolvedValue(fail(403));
    render(await render_());
    expect(screen.getByText(/Admin API returned 403/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Saved addresses' })).toBeNull();
  });

  it('says why a customer may have none, rather than implying the read failed', async () => {
    api.listCustomerAddresses.mockResolvedValue(ok({ items: [] }));
    render(await render_());
    expect(screen.getByText(/A guest checkout records the address on the order/)).toBeTruthy();
  });
});

describe('addressLines / defaultLabels / sortAddresses, at the edges', () => {
  it('an address whose every field is blank produces no lines, and the panel says so', async () => {
    const blank = address({
      id: 'blank',
      first_name: '  ',
      last_name: '',
      line1: ' ',
      city: '',
      postal_code: '   ',
      country: '',
    });
    expect(addressLines(blank)).toEqual([]);

    api.listCustomerAddresses.mockResolvedValue(ok({ items: [blank] }));
    render(await render_());
    expect(screen.getByText('Nothing recorded on this address.')).toBeTruthy();
  });

  it('names both defaults when one address is both, and neither when it is neither', () => {
    expect(defaultLabels(address({ is_default_shipping: true, is_default_billing: true }))).toEqual(
      ['Default shipping', 'Default billing'],
    );
    expect(defaultLabels(address())).toEqual([]);
  });

  it('puts shipping before billing before the rest, and is otherwise stable', () => {
    const plain = address({ id: 'p' });
    const billing = address({ id: 'b', is_default_billing: true });
    const shipping = address({ id: 's', is_default_shipping: true });
    const second = address({ id: 'p2' });
    expect(sortAddresses([plain, billing, shipping, second]).map((a) => a.id)).toEqual([
      's',
      'b',
      'p',
      'p2',
    ]);
  });
});

describe('the consent ledger, beside the current state', () => {
  it('shows each decision with where it came from and the policy version', async () => {
    api.listCustomerConsents.mockResolvedValue(
      ok({
        items: [
          {
            id: 'c2',
            purpose: 'marketing_email',
            granted: false,
            source: 'admin',
            policy_version: '2026-11',
            recorded_at: '2026-11-02T09:00:00.000Z',
          },
          {
            id: 'c1',
            purpose: 'marketing_email',
            granted: true,
            source: 'storefront',
            policy_version: '2026-10',
            recorded_at: '2026-10-18T10:00:00.000Z',
          },
        ],
      }),
    );
    // The current-state table only renders when the record carries a consent object: the two
    // panels answer different questions and neither stands in for the other.
    api.getCustomer.mockResolvedValue(
      ok(
        customer({
          consent: {
            marketing_email: { granted: true, at: '2026-10-18T10:00:00.000Z', source: 'checkout' },
          },
        }),
      ),
    );
    render(await render_());

    const history = screen.getByRole('table', { name: 'Consent history' });
    expect(within(history).getByText('withdrawn')).toBeTruthy();
    expect(within(history).getByText('granted')).toBeTruthy();
    expect(within(history).getByText('admin')).toBeTruthy();
    expect(within(history).getByText('2026-11')).toBeTruthy();
    // And it does not take the place of the current-state table the e2e pins.
    expect(screen.getByRole('table', { name: 'Consent by channel' })).toBeTruthy();
  });

  it('distinguishes "never asked" from "refused"', async () => {
    render(await render_());
    expect(screen.getByText(/never been asked has no row here/)).toBeTruthy();
  });
});

describe('cross-brand identity is HQ-only, and asked for only when it can be answered', () => {
  it('an HQ support principal sees the sibling stores — and the page reads ONE customer', async () => {
    principalOf.current = 'support';
    render(await render_());

    const list = screen.getByRole('list', { name: 'Records across brands' });
    expect(within(list).getByText('Brand B (brand-b)')).toBeTruthy();
    expect(within(list).getByText('this record')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      `/${OTHER_STORE}/customers/${SIBLING}`,
    );
    // The privacy property: a sibling's name would cost a second getCustomer, behind a gate this
    // reader may not hold on that store. The panel shows stores and ids instead.
    expect(api.getCustomer).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/names and emails of the other records are not shown/)).toBeTruthy();
  });

  it('a store-scoped principal is told it is HQ-only, and the call is never made', async () => {
    principalOf.current = 'storeAdmin';
    render(await render_());

    expect(api.getCustomerIdentity).not.toHaveBeenCalled();
    expect(api.listStores).not.toHaveBeenCalled();
    expect(screen.getByText(/HQ only:/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Records across brands' })).toBeNull();
  });

  it('a guest has no identity, so nothing is asked and nothing is implied', async () => {
    api.getCustomer.mockResolvedValue(ok(customer({ identity_id: null, status: 'guest' })));
    render(await render_());
    expect(api.getCustomerIdentity).not.toHaveBeenCalled();
    expect(screen.getByText(/guest with no account/)).toBeTruthy();
  });
});

describe('assigning a group is a choice, not a pasted uuid', () => {
  it('offers the store’s groups by name, with an explicit "No group"', async () => {
    render(await render_());
    const select = screen.getByRole('combobox', { name: /customer group/i });
    expect(within(select).getByRole('option', { name: 'Wholesale' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: 'No group' })).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe(GROUP);
  });

  it('falls back to the id box when the groups cannot be read, so a group stays changeable', async () => {
    api.listCustomerGroups.mockResolvedValue(fail(403));
    render(await render_());
    expect(screen.queryByRole('combobox', { name: /customer group/i })).toBeNull();
    expect(screen.getByLabelText(/Customer group id/)).toBeTruthy();
  });
});
