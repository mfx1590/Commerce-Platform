/**
 * Brand onboarding (#428 B) and activation (#420) against the spec's own examples (Admin API
 * 0.4.12). Prism's `/admin/me` is a store_admin: the owner-only actions are refused by the guard
 * before the API here, and the operations are exercised through the wrappers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

// 4211–4218 are taken by the other suites.
const BASE = 'http://127.0.0.1:4219';
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
const actions = await import('@/app/actions/stores');
const { toOnboardingInput, activationMessage } = await import('@/lib/onboarding');

const input = toOnboardingInput({
  legal_entity_mode: 'inline',
  legal_entity_id: '',
  legal_entity: {
    code: 'brand-c-bv',
    name: 'Brand C B.V.',
    country: 'NL',
    currency: 'EUR',
    vat_number: '',
  },
  code: 'brand-c',
  name: 'Brand C',
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  timezone: 'Europe/Amsterdam',
  currencies: ['GBP'],
  locales: ['nl-NL'],
  hostname: 'brand-c.localhost',
  settings_json: '',
});

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('onboardStore and activateStore against the spec', () => {
  it('the wizard body is valid for onboardStore (Prism answers with the store)', async () => {
    const result = await api.onboardStore(input);
    if (!result.ok) throw new Error(`onboardStore failed: ${result.status}`);
    expect(result.data.store).toMatchObject({ id: expect.any(String), code: expect.any(String) });
    expect(result.data).toHaveProperty('publishable_key');
  });

  it('the documented 201 carries the publishable key, once', async () => {
    const result = await adminRequest<'onboardStore'>({
      baseUrl: BASE,
      path: '/admin/onboarding/stores',
      method: 'POST',
      body: input,
      accessToken: 'contract-test-token',
      headers: preferring(201),
    });
    if (!result.ok) throw new Error(`expected 201, got ${result.status}`);
    expect(result.data.publishable_key).toMatchObject({ key: expect.any(String) });
  });

  it('activateStore answers 200 with the store', async () => {
    const result = await api.activateStore(SEED_STORE_ID);
    expect(result).toMatchObject({ ok: true, data: { status: expect.any(String) } });
  });

  it('the documented 409 ActivationBlocked reads as the missing list in words', async () => {
    const result = await adminRequest<'activateStore'>({
      baseUrl: BASE,
      path: `/admin/stores/${SEED_STORE_ID}/activate`,
      method: 'POST',
      accessToken: 'contract-test-token',
      headers: preferring(409),
    });
    if (result.ok) throw new Error('expected 409');
    expect(result.error.details).toMatchObject({ missing: expect.any(Array) });
    expect(activationMessage(result.error.details)).toMatch(/^Cannot activate: .* missing\.$/);
  });

  it('the documented 422 on onboardStore names the settings keys', async () => {
    const result = await adminRequest<'onboardStore'>({
      baseUrl: BASE,
      path: '/admin/onboarding/stores',
      method: 'POST',
      body: input,
      accessToken: 'contract-test-token',
      headers: preferring(422),
    });
    if (result.ok) throw new Error('expected 422');
    expect(result.error.details).toMatchObject({ settings: expect.any(Object) });
  });

  it("onboardStoreAction and activateStoreAction are refused for Prism's store_admin before the API", async () => {
    const refusal = {
      refusal: {
        status: 403,
        error: { details: { relation: 'owner', object: 'organization:hq' } },
      },
    };
    expect(
      await actions.onboardStoreAction({
        legal_entity_mode: 'existing',
        legal_entity_id: '00000000-0000-4000-8000-000000000011',
        legal_entity: { code: '', name: '', country: '', currency: '', vat_number: '' },
        code: 'brand-c',
        name: 'Brand C',
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
        timezone: 'UTC',
        currencies: [],
        locales: [],
        hostname: 'brand-c.localhost',
        settings_json: '',
      }),
    ).toMatchObject(refusal);
    expect(await actions.activateStoreAction(SEED_STORE_ID)).toMatchObject(refusal);
  });
});
