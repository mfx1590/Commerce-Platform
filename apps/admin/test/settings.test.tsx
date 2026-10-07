import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/app/(store)/[storeId]/settings/page';
import { GeneralSettingsForm } from '@/app/(store)/[storeId]/settings/general-form';
import { CreateApiKey } from '@/components/registry/api-key-create';
import { ApiKeyList, DomainList } from '@/components/registry/lists';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionResult } from '@/lib/forms/action-result';
import {
  LAST_LIVE_KEY_MESSAGE,
  REGISTRY_PERMISSIONS,
  forChannelOptions,
  forStoreSettings,
  lastLiveKeyId,
  settingsPermissions,
  statusChangeQuestion,
  withDefault,
} from '@/lib/settings';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SEED, principals, type PrincipalKey } from './fixtures/principals';

type Store = AdminComponents['Store'];
type ApiKey = AdminComponents['ApiKey'];
type SalesChannel = AdminComponents['SalesChannel'];

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/settings',
}));
const actions = vi.hoisted(() => ({
  createApiKeyAction: vi.fn(),
  addDomainAction: vi.fn(),
  createSalesChannelAction: vi.fn(),
  updateStoreSettingsAction: vi.fn(),
  setPrimaryDomainAction: vi.fn(),
  revokeApiKeyAction: vi.fn(),
}));
vi.mock('@/app/actions/stores', () => actions);
// The section guard is an async server component with its own tests (role-access, navigation);
// here it only has to let the page through.
vi.mock('@/components/shell/section-guard', () => ({
  StoreSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const api = vi.hoisted(() => ({
  getStore: vi.fn(),
  listDomains: vi.fn(),
  listSalesChannels: vi.fn(),
  listApiKeys: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const STORE_ID = SEED.stores.brandA;

const store: Store = {
  id: STORE_ID,
  legal_entity_id: '00000000-0000-4000-8000-000000000011',
  code: 'brand-a',
  name: 'Brand A',
  status: 'active',
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  timezone: 'Europe/Amsterdam',
  // Required on the Store response since contracts-v0.4.7 (#279); always contain the defaults.
  currencies: ['EUR', 'USD'],
  locales: ['en-GB', 'nl-NL'],
  content_space_id: 'brand-a',
  search_index: 'brand-a_products',
  psp_account_id: 'acct_words',
  theme: { color: { primary: '#1E40AF' } },
  settings: { support_refund_limit_minor: 5000 },
  created_at: '2026-09-04T00:00:00Z',
  updated_at: '2026-09-04T00:00:00Z',
};

const channels: SalesChannel[] = [
  { id: 'c1', code: 'web-eu', name: 'Web EU', type: 'web', is_active: true },
  { id: 'c2', code: 'pos-old', name: 'Old POS', type: 'pos', is_active: false },
];

const existingKey: ApiKey = {
  id: 'k1',
  name: 'storefront',
  type: 'publishable',
  key_prefix: 'pk_brand',
  sales_channel_id: 'c1',
  revoked_at: null,
  created_at: '2026-09-01T00:00:00Z',
};

const secondKey: ApiKey = { ...existingKey, id: 'k3', name: 'checkout' };

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  api.getStore.mockResolvedValue(ok(store));
  api.listDomains.mockResolvedValue(
    ok({
      items: [
        { id: 'd1', hostname: 'shop.brand-a.example', is_primary: true, verified_at: null },
        { id: 'd2', hostname: 'www.brand-a.example', is_primary: false, verified_at: null },
      ],
    }),
  );
  api.listSalesChannels.mockResolvedValue(ok({ items: channels }));
  api.listApiKeys.mockResolvedValue(ok({ items: [existingKey, secondKey] }));
});

async function renderAs(role: PrincipalKey) {
  principalOf.current = role;
  render(await SettingsPage({ params: Promise.resolve({ storeId: STORE_ID }) }));
}

describe('settings permissions follow each operation’s x-permission', () => {
  it.each([
    // role,        edit store, add domain, move primary, create channel, keys
    ['owner', true, true, true, true, true],
    ['storeAdmin', true, false, false, true, true],
    ['storeStaff', false, false, false, false, false],
    ['support', false, false, false, false, false],
    ['analyst', false, false, false, false, false],
  ] as const)('%s', (role, edit, domain, primary, channel, keys) => {
    expect(settingsPermissions(principals[role], STORE_ID)).toEqual({
      canEditStore: edit,
      canAddDomain: domain,
      canMovePrimary: primary,
      canCreateChannel: channel,
      canManageKeys: keys,
    });
  });

  it('every row of REGISTRY_PERMISSIONS is the x-permission admin-api.yaml carries', () => {
    const spec = readFileSync(
      // Vitest runs from apps/admin (its config's root).
      resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    for (const [operation, { relation, object }] of Object.entries(REGISTRY_PERMISSIONS)) {
      const at = spec.indexOf(`operationId: ${operation}\n`);
      expect(at, operation).toBeGreaterThan(-1);
      const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
        spec.slice(at, at + 1200),
      );
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe(
        object === 'organization' ? 'organization:hq' : 'store:{storeId}',
      );
    }
  });
});

describe('the settings page, per role', () => {
  it('store_staff reads General, Domains and Channels, with every form replaced by the relation it needs', async () => {
    await renderAs('storeStaff');

    expect(screen.queryByRole('form', { name: 'General settings' })).toBeNull();
    expect(screen.getByText('Europe/Amsterdam')).toBeInTheDocument();
    expect(screen.getByText('shop.brand-a.example')).toBeInTheDocument();
    expect(screen.getByText('Web EU')).toBeInTheDocument();
    for (const name of ['Add domain', 'New sales channel', 'New API key']) {
      expect(screen.queryByRole('form', { name })).toBeNull();
    }
    expect(screen.getByText(/Changing these needs/)).toHaveTextContent(
      `store_admin on store:${STORE_ID}`,
    );
    expect(screen.getByText(/Adding a domain or moving the primary needs/)).toHaveTextContent(
      'owner on organization:hq',
    );
    // The enabled sets are read, not edited.
    expect(screen.getByText('Enabled currencies')).toBeInTheDocument();
    expect(screen.getByText('EUR, USD')).toBeInTheDocument();
    expect(screen.getByText('en-GB, nl-NL')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make .* primary/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Revoke/ })).toBeNull();
    // API keys: not even listed, and never asked for.
    expect(screen.getByText(/You need the store_admin relation on store:/)).toBeInTheDocument();
    expect(api.listApiKeys).not.toHaveBeenCalled();
    expect(screen.queryByText('pk_brand…')).toBeNull();
  });

  it('store_admin edits General, creates channels and keys, and is told domains are owner-only', async () => {
    await renderAs('storeAdmin');

    expect(screen.getByRole('form', { name: 'General settings' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'New sales channel' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'New API key' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add domain' })).toBeNull();
    expect(screen.getByText(/Adding a domain or moving the primary needs/)).toHaveTextContent(
      'owner on organization:hq',
    );
    expect(screen.queryByRole('button', { name: /Make .* primary/ })).toBeNull();
    expect(screen.getAllByText('pk_brand…')).toHaveLength(2);
    // Two live publishable keys: either may go.
    expect(screen.getByRole('button', { name: 'Revoke storefront' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke checkout' })).toBeInTheDocument();
  });

  it('owner gets every form, and Make primary on each domain that is not primary', async () => {
    await renderAs('owner');
    for (const name of ['General settings', 'Add domain', 'New sales channel', 'New API key']) {
      expect(screen.getByRole('form', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Make www.brand-a.example primary' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Make shop.brand-a.example primary' })).toBeNull();
  });

  it('offers publishable keys only in the Store view', async () => {
    await renderAs('storeAdmin');
    const form = screen.getByRole('form', { name: 'New API key' });
    expect(within(form).queryByLabelText(/^Type/)).toBeNull();
    expect(within(form).getByText('Type: publishable')).toBeInTheDocument();
  });

  it('never ships the store record to the browser — only the six General values', async () => {
    await renderAs('storeAdmin');
    const html = document.body.innerHTML;
    // Fields of the record the page does not render must not appear anywhere in the output.
    expect(html).not.toContain('acct_words');
    expect(html).not.toContain('support_refund_limit_minor');
    expect(Object.keys(forStoreSettings(store)).sort()).toEqual([
      'currencies',
      'default_country',
      'default_currency',
      'default_locale',
      'locales',
      'name',
      'status',
      'timezone',
    ]);
  });
});

describe('projections', () => {
  it('channel options carry id and name, and only active channels', () => {
    const options = forChannelOptions(channels);
    expect(options).toEqual([{ id: 'c1', name: 'Web EU' }]);
    expect(JSON.stringify(options)).not.toContain('web-eu');
  });
});

describe('store status changes that take the storefront offline ask first', () => {
  it.each([
    ['active', 'paused', true],
    ['active', 'archived', true],
    ['draft', 'paused', true],
    ['paused', 'active', false],
    ['draft', 'active', false],
    ['active', 'active', false],
    ['paused', 'paused', false],
  ] as const)('%s → %s asks: %s', (from, to, asks) => {
    expect(statusChangeQuestion(from, to) !== null).toBe(asks);
  });

  it('Save on a move to paused asks, and only the confirmation sends', async () => {
    const user = userEvent.setup();
    actions.updateStoreSettingsAction.mockResolvedValue({ status: 'success', data: store });
    render(<GeneralSettingsForm storeId={STORE_ID} current={forStoreSettings(store)} />);

    await user.selectOptions(screen.getByLabelText(/^Status/), 'paused');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/storefront offline/);
    expect(actions.updateStoreSettingsAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(actions.updateStoreSettingsAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
    expect(actions.updateStoreSettingsAction).toHaveBeenCalledWith(
      STORE_ID,
      expect.objectContaining({ status: 'paused' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });

  it('Save without a status change sends at once', async () => {
    const user = userEvent.setup();
    actions.updateStoreSettingsAction.mockResolvedValue({ status: 'success', data: store });
    render(<GeneralSettingsForm storeId={STORE_ID} current={forStoreSettings(store)} />);

    await user.clear(screen.getByLabelText(/^Name/));
    await user.type(screen.getByLabelText(/^Name/), 'Brand A NL');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(actions.updateStoreSettingsAction).toHaveBeenCalledWith(
      STORE_ID,
      expect.objectContaining({ name: 'Brand A NL', status: 'active' }),
    );
  });
});

describe('API keys: the value is shown once', () => {
  const channelOptions = forChannelOptions(channels);

  it('lists existing keys by prefix only, with channel and state — the value is not recoverable', () => {
    render(
      <ApiKeyList
        keys={[existingKey, { ...existingKey, id: 'k0', revoked_at: '2026-09-02T00:00:00Z' }]}
        channels={channels}
      />,
    );
    expect(screen.getAllByText('pk_brand…')).toHaveLength(2);
    expect(screen.getAllByText('Web EU')).toHaveLength(2);
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText('revoked')).toBeInTheDocument();
  });

  it('reveals a freshly created key once, with a copy button and a warning', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    actions.createApiKeyAction.mockResolvedValue({
      status: 'success',
      data: { ...existingKey, id: 'k2', name: 'checkout', key: 'pk_brand-a_live_onetimevalue' },
    } satisfies ActionResult<ApiKey & { key: string }>);

    render(<CreateApiKey storeId="s1" channels={channelOptions} types={['publishable']} />);
    await user.type(screen.getByLabelText(/^Name/), 'checkout');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    expect(actions.createApiKeyAction).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ name: 'checkout', type: 'publishable' }),
    );
    // Set by onSuccess inside the form's async transition: wait for the commit (#398).
    expect(await screen.findByTestId('revealed-api-key')).toHaveTextContent(
      'pk_brand-a_live_onetimevalue',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/shown once and cannot be retrieved again/);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('pk_brand-a_live_onetimevalue');
    // Set after the clipboard promise resolves.
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    // Not in the URL.
    expect(window.location.href).not.toContain('onetimevalue');
  });

  it('drops the value for good when dismissed — it is nowhere in the document afterwards', async () => {
    const user = userEvent.setup();
    actions.createApiKeyAction.mockResolvedValue({
      status: 'success',
      data: { ...existingKey, id: 'k2', key: 'pk_one_time_value' },
    });

    const { container } = render(
      <CreateApiKey storeId="s1" channels={channelOptions} types={['publishable']} />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'checkout');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByTestId('revealed-api-key');
    expect(container.innerHTML).toContain('pk_one_time_value');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(container.innerHTML).not.toContain('pk_one_time_value');
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
  });

  it('shows a refusal without revealing anything', async () => {
    const user = userEvent.setup();
    actions.createApiKeyAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'You need the store_admin relation on store:s1 to save this.',
    });

    render(<CreateApiKey storeId="s1" channels={[]} types={['publishable']} />);
    await user.type(screen.getByLabelText(/^Name/), 'checkout');
    await user.click(screen.getByRole('button', { name: 'Create key' }));

    // The refusal is set inside the form's async transition (#398): wait for it, then check that
    // nothing was revealed.
    expect(await screen.findByRole('alert')).toHaveTextContent('store_admin');
    expect(screen.queryByTestId('revealed-api-key')).toBeNull();
  });

  it('offers both types where HQ asks for them', () => {
    render(<CreateApiKey storeId="s1" channels={[]} types={['publishable', 'secret']} />);
    expect(screen.getByLabelText(/^Type/)).toBeInTheDocument();
  });
});

describe('the enabled currency and locale sets (General)', () => {
  it('withDefault trims, de-duplicates and always keeps the default first', () => {
    expect(withDefault([' USD', 'EUR', 'USD', ''], 'EUR')).toEqual(['EUR', 'USD']);
    expect(withDefault([], 'en-GB')).toEqual(['en-GB']);
  });

  it('edits both sets and sends them with the rest of General', async () => {
    const user = userEvent.setup();
    actions.updateStoreSettingsAction.mockResolvedValue({ status: 'success', data: store });
    render(<GeneralSettingsForm storeId={STORE_ID} current={forStoreSettings(store)} />);

    const currencies = screen.getByLabelText('Enabled currencies');
    expect(currencies).toHaveValue('EUR, USD');
    expect(screen.getByText(/EUR is the default and is always enabled/)).toBeInTheDocument();
    await user.clear(currencies);
    await user.type(currencies, 'eur, usd gbp');
    const locales = screen.getByLabelText('Enabled locales');
    await user.clear(locales);
    await user.type(locales, 'en-GB, de-DE');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(actions.updateStoreSettingsAction).toHaveBeenCalledWith(
      STORE_ID,
      expect.objectContaining({ currencies: ['EUR', 'USD', 'GBP'], locales: ['en-GB', 'de-DE'] }),
    );
  });

  it('refuses a malformed or repeated code under the field, before the action', async () => {
    const user = userEvent.setup();
    render(<GeneralSettingsForm storeId={STORE_ID} current={forStoreSettings(store)} />);

    const currencies = screen.getByLabelText('Enabled currencies');
    await user.clear(currencies);
    await user.type(currencies, 'EUR, EURO');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/EURO: Use a three-letter ISO code/)).toBeInTheDocument();

    await user.clear(currencies);
    await user.type(currencies, 'EUR, USD, USD');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('List each one once')).toBeInTheDocument();
    expect(actions.updateStoreSettingsAction).not.toHaveBeenCalled();
  });
});

describe('domains: moving the primary', () => {
  it('calls setPrimaryDomainAction with the domain id, and shows a refusal beside the row', async () => {
    const user = userEvent.setup();
    actions.setPrimaryDomainAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: null,
      refusal: {
        status: 403,
        error: {
          code: 'forbidden',
          message: 'requires owner on organization:hq',
          details: { relation: 'owner', object: 'organization:hq' },
        },
      },
    });
    render(
      <DomainList
        storeId="s1"
        canMovePrimary
        domains={[
          { id: 'd1', hostname: 'shop.brand-a.example', is_primary: true, verified_at: null },
          { id: 'd2', hostname: 'www.brand-a.example', is_primary: false, verified_at: null },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Make www.brand-a.example primary' }));
    expect(actions.setPrimaryDomainAction).toHaveBeenCalledWith('s1', 'd2');
    expect(await screen.findByText(/organization:hq/)).toBeInTheDocument();
  });

  it('offers nothing without the permission (the HQ page passes none)', () => {
    render(
      <DomainList
        domains={[
          { id: 'd2', hostname: 'www.brand-a.example', is_primary: false, verified_at: null },
        ]}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('API keys: revoking asks first and never the last live key', () => {
  it('lastLiveKeyId names the only live publishable key, and nothing when there are two', () => {
    const revoked = { ...existingKey, id: 'k0', revoked_at: '2026-09-02T00:00:00Z' };
    const secret = { ...existingKey, id: 'k9', type: 'secret' as const };
    expect(lastLiveKeyId([existingKey, revoked, secret])).toBe('k1');
    expect(lastLiveKeyId([existingKey, secondKey])).toBeNull();
    expect(lastLiveKeyId([revoked])).toBeNull();
  });

  it('the last live publishable key has no Revoke, and says why', () => {
    render(
      <ApiKeyList
        storeId="s1"
        canRevoke
        channels={channels}
        keys={[existingKey, { ...existingKey, id: 'k0', revoked_at: '2026-09-02T00:00:00Z' }]}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Revoke/ })).toBeNull();
    expect(screen.getByTestId('last-live-key')).toHaveTextContent(/create another/);
  });

  it('Revoke opens the question; Cancel sends nothing; the confirmation sends', async () => {
    const user = userEvent.setup();
    actions.revokeApiKeyAction.mockResolvedValue({
      status: 'success',
      data: { ...secondKey, revoked_at: '2026-10-05T00:00:00Z' },
    });
    render(
      <ApiKeyList storeId="s1" canRevoke channels={channels} keys={[existingKey, secondKey]} />,
    );

    await user.click(screen.getByRole('button', { name: 'Revoke checkout' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Confirm revoking checkout' }),
    ).toHaveTextContent(/cannot be undone/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(actions.revokeApiKeyAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Revoke checkout' }));
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(actions.revokeApiKeyAction).toHaveBeenCalledWith('s1', 'k3');
  });

  it('the last_live_key refusal from the core is said in plain words inside the question', async () => {
    const user = userEvent.setup();
    actions.revokeApiKeyAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: LAST_LIVE_KEY_MESSAGE,
    });
    render(
      <ApiKeyList storeId="s1" canRevoke channels={channels} keys={[existingKey, secondKey]} />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke storefront' }));
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText(LAST_LIVE_KEY_MESSAGE)).toBeInTheDocument();
  });

  it('without canRevoke (store_staff never gets here; HQ passes none) there is no Revoke', () => {
    render(<ApiKeyList channels={channels} keys={[existingKey, secondKey]} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
