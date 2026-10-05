/**
 * Store settings (#117) against the spec's own examples (Admin API 0.4.8): the ten registry
 * operations the page and its actions call, and the refusals the spec documents on them. Prism is
 * spawned here on its own port; the wrappers are pointed at it before the app modules load.
 *
 * The actions' own permission check reads `/admin/me` from Prism too, whose example is a
 * store_admin on brand-a: so owner-only actions are refused here before the API, and their
 * operations are exercised through the wrappers.
 */
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

// 4211–4216 are taken by the other suites (4216 = window 17's marketing suite).
const BASE = 'http://127.0.0.1:4217';
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
  it('reads the store, and the General projection takes its six fields and the two sets', async () => {
    const store = await api.getStore(SEED_STORE_ID);
    if (!store.ok) throw new Error(`getStore failed: ${store.status}`);
    expect(forStoreSettings(store.data)).toEqual({
      name: expect.any(String),
      status: expect.stringMatching(/^(draft|active|paused|archived)$/),
      default_currency: expect.stringMatching(/^[A-Z]{3}$/),
      default_locale: expect.any(String),
      default_country: expect.stringMatching(/^[A-Z]{2}$/),
      timezone: expect.any(String),
      currencies: expect.arrayContaining([store.data.default_currency]),
      locales: expect.arrayContaining([store.data.default_locale]),
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
      currencies: ['EUR', 'USD'],
      locales: ['en-GB', 'nl-NL'],
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
      currencies: ['EUR'],
      locales: ['en-GB'],
      // An edited request: the Store view never sends these.
      ...({ code: 'brand-z', legal_entity_id: '00000000-0000-4000-8000-000000000012' } as object),
    });
    expect(result).toMatchObject({ status: 'error', formError: 'Some fields are not valid.' });
  });

  it('adds a domain (201) and creates a sales channel (201)', async () => {
    const domain = await api.addDomain(SEED_STORE_ID, {
      hostname: 'shop.brand-a.example',
      is_primary: true,
    });
    expect(domain).toMatchObject({ ok: true, data: { hostname: expect.any(String) } });

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

describe('moving the primary domain and revoking a key (#279, Admin API 0.4.7)', () => {
  const DOMAIN_ID = '40000000-0000-4000-8000-000000000001';
  const KEY_ID = '40000000-0000-4000-8000-000000000101';

  it('updateDomain answers 200 with the domain, now primary', async () => {
    const result = await api.updateDomain(SEED_STORE_ID, DOMAIN_ID, { is_primary: true });
    expect(result).toMatchObject({ ok: true, data: { is_primary: true } });
  });

  it("setPrimaryDomainAction is refused for Prism's store_admin before the API (owner on hq)", async () => {
    const result = await actions.setPrimaryDomainAction(SEED_STORE_ID, DOMAIN_ID);
    expect(result).toMatchObject({
      status: 'error',
      refusal: {
        status: 403,
        error: { details: { relation: 'owner', object: 'organization:hq' } },
      },
    });
  });

  it('revokeApiKeyAction passes the check for a store_admin and gets the revoked key back', async () => {
    const result = await actions.revokeApiKeyAction(SEED_STORE_ID, KEY_ID);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.revoked_at).toEqual(expect.any(String));
  });

  it('409 last_live_key on revokeApiKey is the documented error the action maps', async () => {
    const result = await adminRequest<'revokeApiKey'>({
      baseUrl: BASE,
      path: `/admin/stores/${SEED_STORE_ID}/api-keys/${KEY_ID}/revoke`,
      method: 'POST',
      accessToken: 'contract-test-token',
      headers: preferring(409),
    });
    if (result.ok) throw new Error('expected 409');
    expect(result.status).toBe(409);
    expect(result.error.code).toBe('last_live_key');
  });

  it('409 on updateDomain (clearing the only primary) comes back as a conflict', async () => {
    const result = await adminRequest<'updateDomain'>({
      baseUrl: BASE,
      path: `/admin/stores/${SEED_STORE_ID}/domains/${DOMAIN_ID}`,
      method: 'PATCH',
      body: { is_primary: false },
      accessToken: 'contract-test-token',
      headers: preferring(409),
    });
    if (result.ok) throw new Error('expected 409');
    expect(result.status).toBe(409);
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
