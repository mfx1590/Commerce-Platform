/**
 * Brand onboarding (#428 B) and the activation 409 (#420): the pure helpers, and the actions
 * against mocked API answers shaped like the core's (apps/core/src/modules/registry/onboarding.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import { SEED } from './fixtures/principals';
import {
  activationMessage,
  conflictSteps,
  parseSettings,
  stepOfField,
  stepProblems,
  toOnboardingInput,
  type OnboardingValues,
} from '@/lib/onboarding';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const principalOf = vi.hoisted(() => ({ current: 'owner' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const api = vi.hoisted(() => ({
  onboardStore: vi.fn(),
  activateStore: vi.fn(),
  updateStore: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/stores');

const STORE = SEED.stores.brandA;
const values: OnboardingValues = {
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
  currencies: ['GBP', 'EUR'],
  locales: ['nl-NL'],
  hostname: 'Brand-C.localhost',
  settings_json: '{"payment":{"invoice_allowed":false}}',
};

const blocked = (details: Record<string, unknown>) => ({
  ok: false as const,
  status: 409,
  error: { code: 'conflict', message: 'store cannot be activated', details },
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'owner';
});

describe('which step owns a field', () => {
  it.each([
    ['legal_entity', 'legal_entity'],
    ['legal_entity.code', 'legal_entity'],
    ['legal_entity_id', 'legal_entity'],
    ['hostname', 'domain'],
    ['domain.hostname', 'domain'],
    ['settings', 'store'],
    ['currencies', 'store'],
    ['code', 'store'],
  ] as const)('%s → %s', (field, step) => {
    expect(stepOfField(field)).toBe(step);
  });

  it('a 409 points at the steps that own what differs, in wizard order', () => {
    expect(conflictSteps({ field: 'code', differs: ['hostname', 'legal_entity', 'name'] })).toEqual(
      ['legal_entity', 'store', 'domain'],
    );
    expect(conflictSteps({ field: 'domain.hostname' })).toEqual(['domain']);
    expect(conflictSteps(undefined)).toEqual([]);
  });
});

describe('the activation 409 in words (#420)', () => {
  it('names exactly the missing prerequisites', () => {
    expect(activationMessage({ missing: ['primary_domain', 'publishable_key'] })).toBe(
      'Cannot activate: a primary domain, a live publishable key missing.',
    );
  });
  it('an archived store says so', () => {
    expect(activationMessage({ status: 'archived' })).toMatch(/archived/);
  });
});

describe('the request body', () => {
  it('inline legal entity, the defaults first, the hostname lowered, settings parsed', () => {
    expect(toOnboardingInput(values)).toEqual({
      legal_entity: {
        code: 'brand-c-bv',
        name: 'Brand C B.V.',
        country: 'NL',
        currency: 'EUR',
        vat_number: null,
      },
      code: 'brand-c',
      name: 'Brand C',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
      timezone: 'Europe/Amsterdam',
      currencies: ['EUR', 'GBP'],
      locales: ['en-GB', 'nl-NL'],
      domain: { hostname: 'brand-c.localhost' },
      settings: { payment: { invoice_allowed: false } },
    });
  });

  it('an existing legal entity sends the id and nothing inline (exactly one of the two)', () => {
    const body = toOnboardingInput({
      ...values,
      legal_entity_mode: 'existing',
      legal_entity_id: '00000000-0000-4000-8000-000000000011',
    });
    expect(body.legal_entity_id).toBe('00000000-0000-4000-8000-000000000011');
    expect(body).not.toHaveProperty('legal_entity');
  });

  it('settings: empty is none; anything but a JSON object is refused before the request', () => {
    expect(parseSettings('')).toEqual({});
    expect(parseSettings('[1]')).toBeNull();
    expect(parseSettings('{oops')).toBeNull();
    expect(stepProblems({ ...values, settings_json: '[1]' }, 'store')).toHaveProperty(
      'settings_json',
    );
  });

  it('each step checks its own fields', () => {
    expect(
      stepProblems(
        { ...values, legal_entity: { ...values.legal_entity, country: 'nl' } },
        'legal_entity',
      ),
    ).toHaveProperty('legal_entity.country');
    expect(stepProblems({ ...values, code: 'Brand C' }, 'store')).toHaveProperty('code');
    expect(stepProblems({ ...values, hostname: 'https://x.com/a' }, 'domain')).toHaveProperty(
      'hostname',
    );
    expect(stepProblems(values, 'store')).toEqual({});
  });
});

describe('onboardStoreAction', () => {
  it.each(['storeAdmin', 'finance'] as const)(
    '%s is refused before the API (owner on hq)',
    async (role) => {
      principalOf.current = role;
      expect(await actions.onboardStoreAction(values)).toMatchObject({
        status: 'error',
        refusal: {
          status: 403,
          error: { details: { relation: 'owner', object: 'organization:hq' } },
        },
      });
      expect(api.onboardStore).not.toHaveBeenCalled();
    },
  );

  it('the 201 returns the key exactly once', async () => {
    api.onboardStore.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        store: { id: STORE, code: 'brand-c' },
        publishable_key: { key: 'plain-words-one-time-value', key_prefix: 'plainwords' },
      },
    });
    expect(await actions.onboardStoreAction(values)).toEqual({
      status: 'success',
      data: {
        repeat: false,
        storeId: STORE,
        storeCode: 'brand-c',
        key: 'plain-words-one-time-value',
        keyPrefix: 'plainwords',
      },
    });
  });

  it('the 200 is the identical repeat: no key', async () => {
    api.onboardStore.mockResolvedValue({
      ok: true,
      status: 200,
      data: { store: { id: STORE, code: 'brand-c' }, publishable_key: null },
    });
    expect(await actions.onboardStoreAction(values)).toMatchObject({
      status: 'success',
      data: { repeat: true, key: null },
    });
  });

  it('a 409 comes back with its details for the wizard to map', async () => {
    api.onboardStore.mockResolvedValue({
      ok: false,
      status: 409,
      error: {
        code: 'conflict',
        message: 'store "brand-c" already exists with a different definition',
        details: { field: 'code', differs: ['hostname'] },
      },
    });
    expect(await actions.onboardStoreAction(values)).toMatchObject({
      status: 'error',
      details: { differs: ['hostname'] },
    });
  });
});

describe('activation (#420)', () => {
  it('activateStoreAction: 409 → the missing list and the words, never a crash', async () => {
    api.activateStore.mockResolvedValue(
      blocked({ missing: ['primary_domain', 'publishable_key'] }),
    );
    expect(await actions.activateStoreAction(STORE)).toEqual({
      status: 'error',
      fieldErrors: { status: 'Cannot activate: a primary domain, a live publishable key missing.' },
      formError: 'Cannot activate: a primary domain, a live publishable key missing.',
      missing: ['primary_domain', 'publishable_key'],
    });
  });

  it("store_admin's settings form: updateStore's 409 is the same list", async () => {
    principalOf.current = 'storeAdmin';
    api.updateStore.mockResolvedValue(blocked({ missing: ['primary_domain'] }));
    expect(
      await actions.updateStoreSettingsAction(STORE, {
        name: 'Brand A',
        status: 'active',
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
        timezone: 'Europe/Amsterdam',
        currencies: ['EUR'],
        locales: ['en-GB'],
      }),
    ).toMatchObject({ status: 'error', missing: ['primary_domain'], formError: /primary domain/ });
  });

  it('HQ (owner): status → active saves the other fields first, then calls activateStore', async () => {
    api.updateStore.mockResolvedValue({ ok: true, status: 200, data: { id: STORE } });
    api.activateStore.mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: STORE, status: 'active' },
    });
    expect(
      await actions.updateStoreAction(STORE, { name: 'Brand A', status: 'active' }),
    ).toMatchObject({
      status: 'success',
      data: { status: 'active' },
    });
    expect(api.updateStore).toHaveBeenCalledWith(STORE, { name: 'Brand A' });
    expect(api.activateStore).toHaveBeenCalledWith(STORE);
  });
});
