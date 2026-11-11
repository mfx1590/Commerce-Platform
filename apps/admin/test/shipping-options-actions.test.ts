/**
 * Store shipping options (#809 / #815, Admin API 0.4.28): the table is the yaml's; each action refuses
 * server-side before the API below store_admin; the price is read in the option currency's own units
 * (JPY whole yen, #810's parser); an edit sends only what changed; every refusal is said in words; the
 * activation 409 carries the countries without a sellable option.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import { SEED } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({ createShippingOption: vi.fn(), updateShippingOption: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/shipping-options');
const {
  SHIPPING_PERMISSIONS,
  SHIPPING_READS,
  parseCountries,
  readMissingShippingCountries,
  toShippingOptionPatch,
} = await import('@/lib/shipping-options');
const { activationMessage, MISSING_LABELS } = await import('@/lib/onboarding');

const STORE = SEED.stores.brandA;
const OPTION = '76000000-0000-4000-8000-000000000001';
const row = {
  id: OPTION,
  code: 'standard',
  name: 'Standard',
  carrier: 'manual',
  service: null,
  price: { amount_minor: 1980, currency: 'JPY' },
  countries: ['JP'],
  sales_channel_id: null,
  rules: {},
  is_active: true,
};
const current = {
  name: row.name,
  price: row.price,
  countries: row.countries,
  is_active: true,
};
const create = {
  code: 'standard',
  name: 'Standard',
  price: '1980',
  currency: 'jpy',
  countries: 'jp',
  is_active: true,
};
const edit = { name: 'Standard', price: '1980', countries: 'JP', is_active: true };

const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });
const fail = (status: number, code: string, message: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.createShippingOption.mockResolvedValue(ok(row, 201));
  api.updateShippingOption.mockResolvedValue(ok(row));
});

const calls = {
  createShippingOption: () => actions.createShippingOptionAction(STORE, create),
  updateShippingOption: () =>
    actions.updateShippingOptionAction(STORE, OPTION, current, { ...edit, name: 'Express' }),
} as const;

describe('the shipping-option table is the x-permission admin-api.yaml carries', () => {
  const spec = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  // The operation's own block: up to the next operationId (these descriptions are long, #815).
  const permissionOf = (operation: string) => {
    const at = spec.indexOf(`operationId: ${operation}\n`);
    expect(at, operation).toBeGreaterThan(-1);
    const next = spec.indexOf('operationId: ', at + 1);
    return /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
      spec.slice(at, next === -1 ? spec.length : next),
    );
  };

  it('every mutation is store_admin on the store', () => {
    for (const [operation, { relation }] of Object.entries(SHIPPING_PERMISSIONS)) {
      const permission = permissionOf(operation);
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe('store:{storeId}');
    }
  });

  it('the read is viewer on the store', () => {
    const permission = permissionOf('listShippingOptions');
    expect(permission?.[1]).toBe(SHIPPING_READS.listShippingOptions.relation);
    expect(permission?.[2]).toBe(SHIPPING_READS.listShippingOptions.object);
  });
});

describe('each shipping-option action refuses, server-side, before the API', () => {
  it.each(['storeStaff', 'finance', 'operations', 'analyst', 'support'] as const)(
    '%s is refused every action',
    async (role) => {
      principalOf.current = role;
      for (const [name, call] of Object.entries(calls)) {
        expect(await call(), name).toMatchObject({
          status: 'error',
          refusal: { status: 403, error: { details: { relation: 'store_admin' } } },
        });
      }
      expect(api.createShippingOption).not.toHaveBeenCalled();
      expect(api.updateShippingOption).not.toHaveBeenCalled();
    },
  );

  it.each(['storeAdmin', 'owner'] as const)('%s reaches the API', async (role) => {
    principalOf.current = role;
    for (const [name, call] of Object.entries(calls)) {
      expect((await call()).status, name).toBe('success');
    }
  });

  it('non-uuid ids never reach the API', async () => {
    expect((await actions.updateShippingOptionAction(STORE, 'x', current, edit)).status).toBe(
      'error',
    );
    expect((await actions.createShippingOptionAction('x', create)).status).toBe('error');
    expect(api.updateShippingOption).not.toHaveBeenCalled();
    expect(api.createShippingOption).not.toHaveBeenCalled();
  });
});

describe('createShippingOptionAction: money in the currency’s own units', () => {
  it('¥1,980 typed as 1980 for JPY is price_minor 1980 (zero decimals), manual carrier', async () => {
    await actions.createShippingOptionAction(STORE, create);
    expect(api.createShippingOption).toHaveBeenCalledWith(STORE, {
      code: 'standard',
      name: 'Standard',
      price_minor: 1980,
      currency: 'JPY',
      countries: ['JP'],
      is_active: true,
      carrier: 'manual',
    });
  });

  it('€19.90 typed for EUR is price_minor 1990; a comma decimal works too', async () => {
    await actions.createShippingOptionAction(STORE, { ...create, price: '19.90', currency: 'EUR' });
    await actions.createShippingOptionAction(STORE, { ...create, price: '4,95', currency: 'EUR' });
    expect(api.createShippingOption.mock.calls[0]?.[1]).toMatchObject({ price_minor: 1990 });
    expect(api.createShippingOption.mock.calls[1]?.[1]).toMatchObject({ price_minor: 495 });
  });

  it('decimals on yen are refused under the price, before the API', async () => {
    const result = await actions.createShippingOptionAction(STORE, { ...create, price: '19.5' });
    expect(result).toMatchObject({ status: 'error', fieldErrors: { price: expect.any(String) } });
    expect(api.createShippingOption).not.toHaveBeenCalled();
  });

  it('countries are upper-cased, de-duplicated and must be two letters', async () => {
    expect(parseCountries('jp, kr  JP,')).toEqual(['JP', 'KR']);
    const bad = await actions.createShippingOptionAction(STORE, { ...create, countries: 'JPN' });
    expect(bad).toMatchObject({ status: 'error', fieldErrors: { countries: expect.any(String) } });
    const none = await actions.createShippingOptionAction(STORE, { ...create, countries: ' ' });
    expect(none).toMatchObject({ status: 'error', fieldErrors: { countries: expect.any(String) } });
    expect(api.createShippingOption).not.toHaveBeenCalled();
  });

  it('a taken code is said under the code', async () => {
    api.createShippingOption.mockResolvedValue(
      fail(409, 'conflict', 'this store already has a shipping option with this code', {
        shipping_option_id: OPTION,
      }),
    );
    expect(await actions.createShippingOptionAction(STORE, create)).toMatchObject({
      status: 'error',
      fieldErrors: { code: expect.stringContaining('already has an option with this code') },
    });
  });

  it('the core’s price_minor 400 lands on the price field', async () => {
    api.createShippingOption.mockResolvedValue(
      fail(400, 'validation_failed', 'invalid shipping option', {
        price_minor: "integer ≥ 0 in the currency's minor unit",
      }),
    );
    const result = await actions.createShippingOptionAction(STORE, create);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.fieldErrors['price']).toBeDefined();
  });
});

describe('updateShippingOptionAction', () => {
  it('sends only what changed', async () => {
    await actions.updateShippingOptionAction(STORE, OPTION, current, {
      ...edit,
      price: '2200',
      countries: 'jp, kr',
    });
    expect(api.updateShippingOption).toHaveBeenCalledWith(STORE, OPTION, {
      price_minor: 2200,
      countries: ['JP', 'KR'],
    });
  });

  it('deactivating sends is_active: false alone', async () => {
    await actions.updateShippingOptionAction(STORE, OPTION, current, { ...edit, is_active: false });
    expect(api.updateShippingOption).toHaveBeenCalledWith(STORE, OPTION, { is_active: false });
  });

  it('nothing changed: no write at all', async () => {
    expect(await actions.updateShippingOptionAction(STORE, OPTION, current, edit)).toEqual({
      status: 'success',
      data: null,
    });
    expect(api.updateShippingOption).not.toHaveBeenCalled();
  });

  it('the price is read with the option’s own currency, whatever the form claims', async () => {
    const result = await actions.updateShippingOptionAction(STORE, OPTION, current, {
      ...edit,
      price: '19.80',
    });
    expect(result).toMatchObject({ status: 'error', fieldErrors: { price: expect.any(String) } });
  });

  it('a live store’s 409 says which countries it would leave without shipping', async () => {
    api.updateShippingOption.mockResolvedValue(
      fail(409, 'conflict', 'this change would leave a market country …', {
        missing_shipping_countries: ['NL', 'JP'],
      }),
    );
    const result = await actions.updateShippingOptionAction(STORE, OPTION, current, {
      ...edit,
      is_active: false,
    });
    expect(result).toMatchObject({ status: 'error', fieldErrors: {} });
    if (result.status === 'error') {
      expect(result.formError).toContain('the store is live');
      expect(result.formError).toContain('JP, NL without an active shipping option');
    }
  });

  it('pure patch: null when nothing differs', () => {
    expect(
      toShippingOptionPatch(current, {
        name: 'Standard',
        price_minor: 1980,
        countries: ['JP'],
        is_active: true,
      }),
    ).toBeNull();
  });
});

describe('the activation 409', () => {
  it('reads missing_shipping_countries safely and sorted', () => {
    expect(
      readMissingShippingCountries({ missing_shipping_countries: ['NL', 'JP', 'x', 3] }),
    ).toEqual(['JP', 'NL']);
    expect(readMissingShippingCountries(undefined)).toEqual([]);
  });

  it('names the countries in the activation message, and labels the prerequisite', () => {
    expect(
      activationMessage({
        missing: ['tax_rates', 'shipping_options'],
        missing_tax_countries: ['NL'],
        missing_shipping_countries: ['NL'],
      }),
    ).toBe('Cannot activate: a tax rate for NL, a shipping option for NL missing.');
    expect(MISSING_LABELS['shipping_options']).toContain('shipping option');
  });
});
