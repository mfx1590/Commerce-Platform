import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerForm } from '@/app/(store)/[storeId]/customers/[customerId]/customer-form';
import { EraseControl } from '@/app/(store)/[storeId]/customers/[customerId]/erase-control';
import { CustomersTable } from '@/app/(store)/[storeId]/customers/customers-table';
import { displayName } from '@/app/(store)/[storeId]/customers/customers-table.config';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import type { AdminComponents } from '@/lib/api/admin-client';
import { channelLabel, consentRows, consentSummary } from '@/lib/customers/consent';
import { forCustomerRows } from '@/lib/customers/projection';
import type { ActionResult } from '@/lib/forms/action-result';
import { DEFAULT_LIMIT, type TableQuery } from '@/lib/table/query-state';
import { SEED, type PrincipalKey } from './fixtures/principals';

type Customer = AdminComponents['Customer'];

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/store-1/customers',
}));
const actions = vi.hoisted(() => ({
  updateCustomerAction: vi.fn(),
  eraseCustomerAction: vi.fn(),
}));
vi.mock('@/app/actions/customers', () => actions);
// The section guard reads the principal through the cached loader; the fixture decides the role.
const principalOf = vi.hoisted(() => ({ current: 'support' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: '30000000-0000-4000-8000-0000000000cust',
    identity_id: '30000000-0000-4000-8000-000000000b01',
    email: 'jane@example.com',
    first_name: 'Jane',
    last_name: 'Doe',
    phone: null,
    customer_group_id: null,
    status: 'registered',
    consent: { marketing_email: { granted: true, at: '2026-09-04T10:00:00Z', source: 'checkout' } },
    created_at: '2026-09-04T10:00:00Z',
    ...overrides,
  };
}

const query = (): TableQuery => ({
  page: 1,
  limit: DEFAULT_LIMIT,
  sort: 'created_at',
  order: 'desc',
  filters: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'support';
});

describe('consent: read defensively from the free-form object', () => {
  it('reads the documented shape: channel → { granted, at, source }', () => {
    const rows = consentRows({
      sms: { granted: false, at: '2026-09-05T00:00:00Z', source: 'account' },
      marketing_email: { granted: true, at: '2026-09-04T10:00:00Z', source: 'checkout' },
    });
    expect(rows.map((row) => row.channel)).toEqual(['marketing_email', 'sms']);
    expect(rows[0]).toEqual({
      channel: 'marketing_email',
      granted: true,
      at: '2026-09-04T10:00:00Z',
      source: 'checkout',
      raw: null,
    });
    expect(consentSummary({ sms: { granted: false }, marketing_email: { granted: true } })).toBe(
      '1 of 2 channels',
    );
    expect(channelLabel('marketing_email')).toBe('marketing email');
  });

  it('never throws on a shape it does not know, and keeps the value visible', () => {
    expect(consentRows(null)).toEqual([]);
    expect(consentRows('yes')).toEqual([]);
    expect(consentRows([1, 2])).toEqual([]);
    const rows = consentRows({ push: true, letter: 'maybe', odd: { since: 2020 } });
    expect(rows.find((row) => row.channel === 'push')).toMatchObject({ granted: true, raw: null });
    expect(rows.find((row) => row.channel === 'letter')).toMatchObject({
      granted: null,
      raw: '"maybe"',
    });
    expect(rows.find((row) => row.channel === 'odd')).toMatchObject({
      granted: null,
      raw: '{"since":2020}',
    });
    expect(consentSummary({})).toBe('—');
    expect(consentSummary({ push: true })).toBe('1 of 1 channel');
  });
});

describe('customers table', () => {
  it('renders the PII as text, the status as a named pill, and links each row to its detail', () => {
    render(
      <CustomersTable
        storeId="store-1"
        rows={forCustomerRows([
          customer(),
          customer({
            id: 'customer-guest-words',
            email: 'g@example.com',
            first_name: null,
            last_name: null,
            status: 'guest',
            consent: {},
          }),
        ])}
        total={2}
        query={query()}
      />,
    );
    const table = screen.getByRole('table', { name: 'Customers' });
    expect(within(table).getByRole('link', { name: 'jane@example.com' })).toHaveAttribute(
      'href',
      '/store-1/customers/30000000-0000-4000-8000-0000000000cust',
    );
    expect(within(table).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(table).getByText('registered')).toBeInTheDocument();
    expect(within(table).getByText('guest')).toBeInTheDocument();
    expect(within(table).getByText('1 of 1 channel')).toBeInTheDocument();
    // A guest without a name falls back to the local part of the email, never "null null".
    expect(within(table).getByText('g')).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/null/);
    expect(displayName({ first_name: null, last_name: 'Doe', email: 'x@example.com' })).toBe('Doe');
  });
});

describe('the customers section is support-gated', () => {
  const guarded = (role: PrincipalKey) => {
    principalOf.current = role;
    return StoreSectionGuard({
      storeId: SEED.stores.brandA,
      id: 'customers',
      children: <p>the customer list</p>,
    });
  };

  it('analyst: a direct URL renders the 403 panel naming support, not the data', async () => {
    render(await guarded('analyst'));
    expect(screen.getByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
    expect(screen.getByText(/You need the support relation on store:/)).toBeInTheDocument();
    expect(screen.queryByText('the customer list')).toBeNull();
  });

  it.each(['support', 'storeAdmin', 'owner'] as PrincipalKey[])(
    '%s sees the list',
    async (role) => {
      render(await guarded(role));
      expect(screen.getByText('the customer list')).toBeInTheDocument();
    },
  );

  it.each(['storeStaff', 'finance', 'operations'] as PrincipalKey[])(
    '%s does not',
    async (role) => {
      render(await guarded(role));
      expect(screen.queryByText('the customer list')).toBeNull();
    },
  );
});

describe('customer form', () => {
  it('sends only the fields it shows, and clears the group with an empty id', async () => {
    const user = userEvent.setup();
    actions.updateCustomerAction.mockResolvedValue({
      status: 'success',
      data: null,
    } satisfies ActionResult<null>);
    render(
      <CustomerForm
        storeId="store-1"
        customerId="customer-words"
        defaultValues={{
          first_name: 'Jane',
          last_name: 'Doe',
          phone: '',
          customer_group_id: '',
          status: 'registered',
        }}
        statusEditable
      />,
    );
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '+31 20 000 0000');
    await user.selectOptions(screen.getByLabelText('Status'), 'disabled');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(actions.updateCustomerAction).toHaveBeenCalledWith('store-1', 'customer-words', {
        first_name: 'Jane',
        last_name: 'Doe',
        phone: '+31 20 000 0000',
        customer_group_id: '',
        status: 'disabled',
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('refuses a group id that is not a uuid before anything is sent', async () => {
    const user = userEvent.setup();
    render(
      <CustomerForm
        storeId="store-1"
        customerId="customer-words"
        defaultValues={{
          first_name: '',
          last_name: '',
          phone: '',
          customer_group_id: '',
          status: 'registered',
        }}
        statusEditable={false}
      />,
    );
    expect(screen.queryByLabelText('Status')).toBeNull();
    await user.type(screen.getByLabelText(/Customer group id/), 'not-a-uuid');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a group id (uuid)')).toBeInTheDocument();
    expect(actions.updateCustomerAction).not.toHaveBeenCalled();
  });

  it('a 403 renders the relation panel', async () => {
    const user = userEvent.setup();
    actions.updateCustomerAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: null,
      refusal: {
        status: 403,
        error: {
          code: 'forbidden',
          message: 'requires support on store:brand-a',
          details: { relation: 'support', object: 'store:brand-a' },
        },
      },
    } satisfies ActionResult<never>);
    render(
      <CustomerForm
        storeId="store-1"
        customerId="customer-words"
        defaultValues={{
          first_name: 'J',
          last_name: '',
          phone: '',
          customer_group_id: '',
          status: 'registered',
        }}
        statusEditable
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
  });
});

describe('erase control', () => {
  it('asks for a typed confirmation and reports the bodiless 202 as scheduled', async () => {
    const user = userEvent.setup();
    actions.eraseCustomerAction.mockResolvedValue({
      status: 'success',
      data: null,
    } satisfies ActionResult<null>);
    render(<EraseControl storeId="store-1" customerId="customer-words" />);
    await user.click(screen.getByRole('button', { name: 'Erase this customer' }));
    const confirm = screen.getByRole('button', { name: 'Yes, erase' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Confirmation'), 'erase');
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByLabelText('Confirmation'));
    await user.type(screen.getByLabelText('Confirmation'), 'ERASE');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() =>
      expect(actions.eraseCustomerAction).toHaveBeenCalledWith('store-1', 'customer-words'),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/Erasure scheduled/);
    expect(refresh).toHaveBeenCalled();
  });

  it('a refusal renders the panel and keeps the form', async () => {
    const user = userEvent.setup();
    actions.eraseCustomerAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: null,
      refusal: {
        status: 403,
        error: {
          code: 'forbidden',
          message: 'requires store_admin on store:brand-a',
          details: { relation: 'store_admin', object: 'store:brand-a' },
        },
      },
    } satisfies ActionResult<never>);
    render(<EraseControl storeId="store-1" customerId="customer-words" />);
    await user.click(screen.getByRole('button', { name: 'Erase this customer' }));
    await user.type(screen.getByLabelText('Confirmation'), 'ERASE');
    await user.click(screen.getByRole('button', { name: 'Yes, erase' }));
    expect(await screen.findByText(/You need the store_admin relation/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, erase' })).toBeInTheDocument();
  });
});
