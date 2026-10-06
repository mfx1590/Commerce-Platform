/**
 * The registry server actions check the operation's `x-permission` themselves, before the Admin
 * API is called: a server action is a public POST, so a crafted request that the page never offered
 * must be refused here too. One case per action and role class; the API mock proves nothing left.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import { SEED } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string | null }));
const loadPrincipal = vi.hoisted(() => vi.fn());
vi.mock('@/lib/principal', () => ({ loadPrincipal }));
const principalAnswer = async () =>
  principalOf.current === null
    ? {
        ok: false,
        status: 401,
        error: { code: 'unauthorized', message: 'session ended' },
      }
    : principalOf.current === 'meFails'
      ? { ok: false, status: 500, error: { code: 'internal', message: 'boom' } }
      : {
          ok: true,
          status: 200,
          data: (await import('./fixtures/principals')).principals[
            principalOf.current as PrincipalKey
          ],
        };

const api = vi.hoisted(() => ({
  createStore: vi.fn(),
  updateStore: vi.fn(),
  addDomain: vi.fn(),
  updateDomain: vi.fn(),
  createSalesChannel: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/stores');
const { LAST_LIVE_KEY_MESSAGE } = await import('@/lib/settings');

const STORE_ID = SEED.stores.brandA;
const DOMAIN_ID = '40000000-0000-4000-8000-000000000002';
const KEY_ID = '40000000-0000-4000-8000-000000000101';

const general = {
  name: 'Brand A',
  status: 'active' as const,
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  timezone: 'Europe/Amsterdam',
  currencies: ['USD'],
  locales: ['nl-NL'],
};

/** Every registry action the Store view calls, with valid input. */
const calls = {
  updateStoreSettings: () => actions.updateStoreSettingsAction(STORE_ID, general),
  addDomain: () => actions.addDomainAction(STORE_ID, { hostname: 'www.brand-a.example' }),
  setPrimaryDomain: () => actions.setPrimaryDomainAction(STORE_ID, DOMAIN_ID),
  createSalesChannel: () =>
    actions.createSalesChannelAction(STORE_ID, { code: 'web-eu', name: 'Web EU', type: 'web' }),
  createApiKey: () =>
    actions.createApiKeyAction(STORE_ID, { name: 'checkout', type: 'publishable' }),
  revokeApiKey: () => actions.revokeApiKeyAction(STORE_ID, KEY_ID),
} as const;

const ok = { ok: true as const, status: 200, data: { id: 'x' } };

beforeEach(() => {
  vi.clearAllMocks();
  loadPrincipal.mockImplementation(principalAnswer);
  for (const fn of Object.values(api)) fn.mockResolvedValue(ok);
});

function apiCalls(): number {
  return Object.values(api).reduce((total, fn) => total + fn.mock.calls.length, 0);
}

describe('store_staff (and every read-only role) is refused by each action before the API', () => {
  it.each(['storeStaff', 'support', 'analyst'] as const)('%s', async (role) => {
    principalOf.current = role;
    for (const [name, call] of Object.entries(calls)) {
      const result = await call();
      expect(result, name).toMatchObject({ status: 'error', refusal: { status: 403 } });
    }
    expect(apiCalls()).toBe(0);
  });

  it('the refusal names the relation and object exactly as the Admin API would', async () => {
    principalOf.current = 'storeStaff';
    expect(await calls.revokeApiKey()).toMatchObject({
      refusal: {
        status: 403,
        error: {
          code: 'forbidden',
          details: { relation: 'store_admin', object: `store:${STORE_ID}` },
        },
      },
    });
  });
});

describe('store_admin', () => {
  beforeEach(() => {
    principalOf.current = 'storeAdmin';
  });

  it('is refused the owner-on-hq operations (add domain, move primary) before the API', async () => {
    for (const call of [calls.addDomain, calls.setPrimaryDomain]) {
      expect(await call()).toMatchObject({
        status: 'error',
        refusal: {
          status: 403,
          error: { details: { relation: 'owner', object: 'organization:hq' } },
        },
      });
    }
    expect(api.addDomain).not.toHaveBeenCalled();
    expect(api.updateDomain).not.toHaveBeenCalled();
  });

  it('reaches the API for General, channels and keys', async () => {
    for (const call of [
      calls.updateStoreSettings,
      calls.createSalesChannel,
      calls.createApiKey,
      calls.revokeApiKey,
    ]) {
      expect(await call()).toMatchObject({ status: 'success' });
    }
    expect(api.revokeApiKey).toHaveBeenCalledWith(STORE_ID, KEY_ID);
  });

  it('General sends both sets with their default kept first', async () => {
    await calls.updateStoreSettings();
    expect(api.updateStore).toHaveBeenCalledWith(
      STORE_ID,
      expect.objectContaining({ currencies: ['EUR', 'USD'], locales: ['en-GB', 'nl-NL'] }),
    );
  });

  it('a malformed set is refused before the API', async () => {
    const result = await actions.updateStoreSettingsAction(STORE_ID, {
      ...general,
      currencies: ['EURO'],
    });
    expect(result).toMatchObject({ status: 'error', formError: 'Some fields are not valid.' });
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('409 last_live_key becomes the plain-words message, not the raw error', async () => {
    api.revokeApiKey.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: 'last_live_key', message: 'raw', details: { key_id: KEY_ID } },
    });
    expect(await calls.revokeApiKey()).toEqual({
      status: 'error',
      fieldErrors: {},
      formError: LAST_LIVE_KEY_MESSAGE,
    });
  });

  it('a path id that is not a uuid never reaches the API', async () => {
    expect(await actions.revokeApiKeyAction(STORE_ID, '../stores')).toMatchObject({
      status: 'error',
    });
    expect(await actions.setPrimaryDomainAction(STORE_ID, '1 OR 1')).toMatchObject({
      status: 'error',
    });
    expect(apiCalls()).toBe(0);
  });
});

describe('owner', () => {
  it('reaches the API for every registry action, and moving the primary only ever sends true', async () => {
    principalOf.current = 'owner';
    for (const [name, call] of Object.entries(calls)) {
      expect(await call(), name).toMatchObject({ status: 'success' });
    }
    expect(api.updateDomain).toHaveBeenCalledWith(STORE_ID, DOMAIN_ID, { is_primary: true });
  });
});

describe('the HQ store actions carry the same check', () => {
  const storeInput = {
    legal_entity_id: '00000000-0000-4000-8000-000000000011',
    code: 'brand-z',
    name: 'Brand Z',
    status: 'draft' as const,
    default_currency: 'EUR',
    default_locale: 'en-GB',
    default_country: 'NL',
    timezone: 'Europe/Amsterdam',
  };

  it('createStoreAction refuses store_admin (owner on hq) before the API; owner reaches it', async () => {
    principalOf.current = 'storeAdmin';
    expect(await actions.createStoreAction(storeInput)).toMatchObject({
      refusal: {
        status: 403,
        error: { details: { relation: 'owner', object: 'organization:hq' } },
      },
    });
    expect(api.createStore).not.toHaveBeenCalled();
    principalOf.current = 'owner';
    expect(await actions.createStoreAction(storeInput)).toMatchObject({ status: 'success' });
  });

  it('updateStoreAction refuses store_staff before the API; store_admin reaches it', async () => {
    principalOf.current = 'storeStaff';
    expect(await actions.updateStoreAction(STORE_ID, { name: 'Brand A' })).toMatchObject({
      refusal: { status: 403, error: { details: { relation: 'store_admin' } } },
    });
    expect(api.updateStore).not.toHaveBeenCalled();
    principalOf.current = 'storeAdmin';
    expect(await actions.updateStoreAction(STORE_ID, { name: 'Brand A' })).toMatchObject({
      status: 'success',
    });
  });
});

describe('cross-store and malformed store ids', () => {
  it("store_admin of brand-a is refused every action on brand-c's id, before the API", async () => {
    principalOf.current = 'storeAdmin';
    const brandC = SEED.stores.brandC;
    for (const call of [
      () => actions.updateStoreSettingsAction(brandC, general),
      () =>
        actions.createSalesChannelAction(brandC, { code: 'web-eu', name: 'Web EU', type: 'web' }),
      () => actions.createApiKeyAction(brandC, { name: 'checkout', type: 'publishable' }),
      () => actions.revokeApiKeyAction(brandC, KEY_ID),
    ]) {
      expect(await call()).toMatchObject({
        refusal: { status: 403, error: { details: { object: `store:${brandC}` } } },
      });
    }
    expect(apiCalls()).toBe(0);
  });

  it('a store id that is not a uuid never reaches the principal check or the API', async () => {
    principalOf.current = 'owner';
    expect(await actions.revokeApiKeyAction('brand-a', KEY_ID)).toMatchObject({
      status: 'error',
      formError: 'That store is not valid.',
    });
    expect(loadPrincipal).not.toHaveBeenCalled();
    expect(apiCalls()).toBe(0);
  });
});

describe('no principal', () => {
  it('an ended session is the 401 refusal, and nothing is sent', async () => {
    principalOf.current = null;
    expect(await calls.createApiKey()).toMatchObject({
      status: 'error',
      refusal: { status: 401 },
    });
    expect(apiCalls()).toBe(0);
  });
});

describe('/admin/me failing', () => {
  it('a 500 fails closed: a message, no refusal panel, nothing sent', async () => {
    principalOf.current = 'meFails';
    const result = await calls.revokeApiKey();
    expect(result).toMatchObject({ status: 'error', formError: 'boom' });
    expect(result).not.toHaveProperty('refusal');
    expect(apiCalls()).toBe(0);
  });
});
