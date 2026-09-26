/**
 * Store settings (#117) against the spec's own examples (Admin API 0.4.6): the eight registry
 * operations the page and its actions call, and the refusals the spec documents on them. Prism is
 * spawned here on its own port; the wrappers are pointed at it before the app modules load.
 */
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

const BASE = 'http://127.0.0.1:4216';
let prism: PrismHandle | undefined;
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test-token' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const api = await import('@/lib/api/admin');
const { adminRequest } = await import('@/lib/api/admin-client');
const { toActionResult } = await import('@/lib/forms/action-result');
const actions = await import('@/app/actions/stores');
const { forChannelOptions, forStoreSettings } = await import('@/lib/settings');
const { ActionRefusal } = await import('@/components/states/action-refusal');

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('the settings reads reach the paths the spec documents', () => {
  it('reads the store, and the General projection takes exactly its six fields', async () => {
    const store = await api.getStore(SEED_STORE_ID);
    if (!store.ok) throw new Error(`getStore failed: ${store.status}`);
    expect(forStoreSettings(store.data)).toEqual({
      name: expect.any(String),
      status: expect.stringMatching(/^(draft|active|paused|archived)$/),
      default_currency: expect.stringMatching(/^[A-Z]{3}$/),
      default_locale: expect.any(String),
      default_country: expect.stringMatching(/^[A-Z]{2}$/),
      timezone: expect.any(String),
    });
  });

  it('lists domains, sales channels and API keys with the fields the lists render', async () => {
    const [domains, channels, keys] = await Promise.all([
      api.listDomains(SEED_STORE_ID),
      api.listSalesChannels(SEED_STORE_ID),
      api.listApiKeys(SEED_STORE_ID),
    ]);
    if (!domains.ok || !channels.ok || !keys.ok) throw new Error('a registry list failed');
    expect(domains.data.items[0]).toMatchObject({
      hostname: expect.any(String),
      is_primary: expect.any(Boolean),
    });
    expect(domains.data.items[0]).toHaveProperty('verified_at');
    expect(channels.data.items[0]).toMatchObject({
      name: expect.any(String),
      code: expect.any(String),
      is_active: expect.any(Boolean),
    });
    expect(forChannelOptions(channels.data.items)[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
    });
    const key = keys.data.items[0];
    expect(key).toMatchObject({ key_prefix: expect.any(String), type: 'publishable' });
    // The list never carries the value.
    expect(key).not.toHaveProperty('key');
  });
});

describe('the settings actions against the spec', () => {
  it('saves General through updateStoreSettingsAction (200 with the store)', async () => {
    const result = await actions.updateStoreSettingsAction(SEED_STORE_ID, {
      name: 'Brand A',
      status: 'active',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
      timezone: 'Europe/Amsterdam',
    });
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.code).toEqual(expect.any(String));
  });

  it('refuses a General save that reaches for HQ fields, before the API', async () => {
    const result = await actions.updateStoreSettingsAction(SEED_STORE_ID, {
      name: 'Brand A',
      status: 'active',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
      timezone: 'Europe/Amsterdam',
      // An edited request: the Store view never sends these.
      ...({ code: 'brand-z', legal_entity_id: '00000000-0000-4000-8000-000000000012' } as object),
    });
    expect(result).toMatchObject({ status: 'error', formError: 'Some fields are not valid.' });
  });

  it('adds a domain (201) and creates a sales channel (201)', async () => {
    const domain = await actions.addDomainAction(SEED_STORE_ID, {
      hostname: 'shop.brand-a.example',
      is_primary: true,
    });
    expect(domain).toMatchObject({ status: 'success', data: { hostname: expect.any(String) } });

    const channel = await actions.createSalesChannelAction(SEED_STORE_ID, {
      code: 'web-eu',
      name: 'Web EU',
      type: 'web',
    });
    expect(channel).toMatchObject({ status: 'success', data: { code: expect.any(String) } });
  });

  it('creates a publishable key (201) and gets the plain value back exactly here', async () => {
    const result = await actions.createApiKeyAction(SEED_STORE_ID, {
      name: 'storefront',
      type: 'publishable',
      sales_channel_id: '',
    });
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.key).toEqual(expect.any(String));
    expect(result.data.key.startsWith(result.data.key_prefix.slice(0, 2))).toBe(true);
  });
});

describe("the spec's documented refusals on the registry operations", () => {
  const ask = (code: number, path: string, body: unknown) =>
    adminRequest<'addDomain'>({
      baseUrl: BASE,
      path,
      method: 'POST',
      body,
      accessToken: 'contract-test-token',
      headers: preferring(code),
    });

  it('403 on addDomain (owner on hq) becomes the relation panel', async () => {
    const result = await ask(403, `/admin/stores/${SEED_STORE_ID}/domains`, {
      hostname: 'shop.brand-a.example',
    });
    if (result.ok) throw new Error('expected a refusal');
    const mapped = toActionResult(result, ['hostname', 'is_primary']);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal?.status).toBe(403);
    render(<ActionRefusal refusal={mapped.refusal} message={mapped.formError} />);
    expect(screen.getByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
  });

  it.each([
    ['addDomain', `/admin/stores/${SEED_STORE_ID}/domains`, { hostname: 'shop.brand-a.example' }],
    [
      'createSalesChannel',
      `/admin/stores/${SEED_STORE_ID}/sales-channels`,
      { code: 'web-eu', name: 'Web EU', type: 'web' },
    ],
  ])('409 on %s comes back as the conflict the form shows', async (_op, path, body) => {
    const result = await ask(409, path, body);
    if (result.ok) throw new Error('expected 409');
    expect(result.status).toBe(409);
    expect(result.error.code).toBe('conflict');
    const mapped = toActionResult(result, ['hostname', 'code', 'name', 'type']);
    expect(mapped.status).toBe('error');
  });

  it('401 on createApiKey is the session panel, never a revealed key', async () => {
    const result = await ask(401, `/admin/stores/${SEED_STORE_ID}/api-keys`, {
      name: 'x',
      type: 'publishable',
    });
    if (result.ok) throw new Error('expected 401');
    expect(result.status).toBe(401);
    const mapped = toActionResult(result, ['name', 'type', 'sales_channel_id']);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal?.status).toBe(401);
  });
});
