import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysPanel } from '@/app/(hq)/stores/[storeId]/api-keys-panel';
import { StoresTable } from '@/app/(hq)/stores/stores-table';
// From the plain config module, not the 'use client' one — a server component imports it too.
import { STORES_TABLE_DEFAULTS } from '@/app/(hq)/stores/stores-table.config';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';
import { DEFAULT_LIMIT, type TableQuery } from '@/lib/table/query-state';

type Store = AdminComponents['Store'];
type ApiKey = AdminComponents['ApiKey'];

const push = vi.hoisted(() => vi.fn());
const createApiKeyAction = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/stores',
}));
vi.mock('@/app/actions/stores', () => ({ createApiKeyAction }));

function store(id: string, code: string, name: string, status = 'active'): Store {
  return {
    id,
    legal_entity_id: '00000000-0000-4000-8000-000000000011',
    code,
    name,
    status,
    default_currency: 'EUR',
    default_locale: 'en-GB',
    default_country: 'NL',
    timezone: 'Europe/Amsterdam',
    content_space_id: null,
    search_index: null,
    psp_account_id: null,
    theme: {},
    settings: {},
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  } as Store;
}

const rows = [
  store('s1', 'brand-a', 'Brand A'),
  store('s2', 'brand-b', 'Brand B', 'draft'),
  store('s3', 'brand-c', 'Brand C', 'paused'),
];

const query = (overrides: Partial<TableQuery> = {}): TableQuery => ({
  page: 1,
  limit: DEFAULT_LIMIT,
  sort: 'created_at',
  order: 'desc',
  filters: {},
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stores list', () => {
  it('renders one row per store with the contract fields', () => {
    render(<StoresTable rows={rows} total={3} query={query()} />);
    const table = screen.getByRole('table', { name: 'Stores' });

    expect(within(table).getAllByRole('row')).toHaveLength(rows.length + 1);
    expect(within(table).getByText('brand-a')).toBeInTheDocument();
    // All three fixtures share a currency and a creation date, so these are per-row, not unique.
    expect(within(table).getAllByText('EUR')).toHaveLength(rows.length);
    expect(within(table).getAllByText('2026-09-01')).toHaveLength(rows.length);
  });

  it('links each store to its detail page', () => {
    render(<StoresTable rows={rows} total={3} query={query()} />);
    expect(screen.getByRole('link', { name: 'Brand A' })).toHaveAttribute('href', '/stores/s1');
  });

  it('shows the status as a badge, not raw text in a cell', () => {
    render(<StoresTable rows={rows} total={3} query={query()} />);
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('sorts on the columns Admin API 0.2.0 accepts, and only those', async () => {
    const user = userEvent.setup();
    render(<StoresTable rows={rows} total={3} query={query()} />);

    // code, name, status and created_at are sortable...
    await user.click(screen.getByRole('button', { name: /Code/ }));
    expect(push).toHaveBeenCalledWith('/stores?sort=code');

    // ...currency and country are not in the contract's enum, so they are plain headers.
    expect(screen.queryByRole('button', { name: 'Currency' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Country' })).toBeNull();
  });

  it('keeps the contract default sort out of the URL', async () => {
    const user = userEvent.setup();
    render(
      <StoresTable rows={rows} total={3} query={query({ sort: 'created_at', order: 'asc' })} />,
    );

    // Third click on the active column clears sorting, which is the default — so a bare path.
    await user.click(screen.getByRole('button', { name: /Created/ }));
    expect(push).toHaveBeenCalledWith('/stores');
    expect(STORES_TABLE_DEFAULTS.sort).toEqual('created_at');
  });

  it('announces the current sort on the header', () => {
    render(<StoresTable rows={rows} total={3} query={query({ sort: 'name', order: 'asc' })} />);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('renders a refusal as the panel that names the relation', () => {
    render(
      <StoresTable
        rows={[]}
        total={0}
        query={query()}
        error={{
          status: 403,
          error: {
            code: 'forbidden',
            message: 'requires viewer',
            details: { relation: 'viewer', object: 'store:*' },
          },
        }}
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/You need the viewer relation/)).toBeInTheDocument();
  });
});

const existingKey: ApiKey = {
  id: 'k1',
  name: 'storefront',
  type: 'publishable',
  key_prefix: 'pk_brand',
  sales_channel_id: null,
  revoked_at: null,
  created_at: '2026-09-01T00:00:00Z',
};

describe('API keys: the value is shown once', () => {
  it('lists existing keys by prefix only — the value is not recoverable', () => {
    render(<ApiKeysPanel storeId="s1" keys={[existingKey]} salesChannels={[]} />);

    expect(screen.getByText('pk_brand…')).toBeInTheDocument();
    expect(screen.queryByTestId('revealed-api-key')).toBeNull();
  });

  it('reveals a freshly created key once, with a copy button and a warning', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    createApiKeyAction.mockResolvedValue({
      status: 'success',
      data: { ...existingKey, id: 'k2', name: 'checkout', key: 'pk_brand-a_live_secretvalue' },
    } satisfies ActionResult<ApiKey & { key: string }>);

    render(<ApiKeysPanel storeId="s1" keys={[existingKey]} salesChannels={[]} />);
    await user.type(screen.getByLabelText(/^Name/), 'checkout');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    expect(screen.getByTestId('revealed-api-key')).toHaveTextContent('pk_brand-a_live_secretvalue');
    expect(screen.getByRole('alert')).toHaveTextContent(/shown once and cannot be retrieved again/);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('pk_brand-a_live_secretvalue');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('drops the value for good when the panel is dismissed', async () => {
    const user = userEvent.setup();
    createApiKeyAction.mockResolvedValue({
      status: 'success',
      data: { ...existingKey, id: 'k2', key: 'pk_one_time_value' },
    });

    render(<ApiKeysPanel storeId="s1" keys={[existingKey]} salesChannels={[]} />);
    await user.type(screen.getByLabelText(/^Name/), 'checkout');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByTestId('revealed-api-key')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('revealed-api-key')).toBeNull();
    // Nothing re-fetches it: there is no control that could bring it back.
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
  });

  it('shows a refusal without revealing anything', async () => {
    const user = userEvent.setup();
    createApiKeyAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'You need the store_admin relation on store:s1 to save this.',
    });

    render(<ApiKeysPanel storeId="s1" keys={[]} salesChannels={[]} />);
    await user.type(screen.getByLabelText(/^Name/), 'checkout');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    expect(screen.getByRole('alert')).toHaveTextContent('store_admin');
    expect(screen.queryByTestId('revealed-api-key')).toBeNull();
  });
});
