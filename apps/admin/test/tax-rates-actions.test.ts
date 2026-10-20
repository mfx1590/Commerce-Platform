/**
 * Store tax rates (#520, Admin API 0.4.23): the table is the yaml's; each action refuses
 * server-side before the API below store_admin; the forms' rules are re-checked; every refusal is
 * said in words; the activation 409 carries the uncovered market countries.
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

const api = vi.hoisted(() => ({
  createTaxRate: vi.fn(),
  updateTaxRate: vi.fn(),
  deleteTaxRate: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/tax-rates');
const { TAX_PERMISSIONS, TAX_READS, formatRate, readMissingTaxCountries, taxRateCreateSchema } =
  await import('@/lib/tax-rates');
const { activationMessage } = await import('@/lib/onboarding');

const STORE = SEED.stores.brandA;
const RATE = '75000000-0000-4000-8000-000000000001';
const CATEGORY = '20000000-0000-4000-8000-000000000201';
const row = {
  id: RATE,
  country: 'NL',
  region: null,
  name: 'VAT 21%',
  rate_bp: 2100,
  product_category_id: null,
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
};
const create = { country: 'nl', name: 'VAT 21%', rate_bp: '2100' };

const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });
const fail = (status: number, code: string, message: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.createTaxRate.mockResolvedValue(ok(row, 201));
  api.updateTaxRate.mockResolvedValue(ok(row));
  api.deleteTaxRate.mockResolvedValue(ok(null, 204));
});

const calls = {
  createTaxRate: () => actions.createTaxRateAction(STORE, create),
  updateTaxRate: () => actions.updateTaxRateAction(STORE, RATE, { name: 'VAT', rate_bp: '900' }),
  deleteTaxRate: () => actions.deleteTaxRateAction(STORE, RATE),
} as const;

describe('the tax-rate table is the x-permission admin-api.yaml carries', () => {
  const spec = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const permissionOf = (operation: string) => {
    const at = spec.indexOf(`operationId: ${operation}\n`);
    expect(at, operation).toBeGreaterThan(-1);
    return /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(spec.slice(at, at + 2500));
  };

  it('every mutation is store_admin on the store', () => {
    for (const [operation, { relation }] of Object.entries(TAX_PERMISSIONS)) {
      const permission = permissionOf(operation);
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe('store:{storeId}');
    }
  });

  it('the read is viewer on the store', () => {
    const permission = permissionOf('listTaxRates');
    expect(permission?.[1]).toBe(TAX_READS.listTaxRates.relation);
    expect(permission?.[2]).toBe(TAX_READS.listTaxRates.object);
  });
});

describe('each tax-rate action refuses, server-side, before the API', () => {
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
      expect(api.createTaxRate).not.toHaveBeenCalled();
      expect(api.updateTaxRate).not.toHaveBeenCalled();
      expect(api.deleteTaxRate).not.toHaveBeenCalled();
    },
  );

  it.each(['storeAdmin', 'owner'] as const)('%s reaches the API', async (role) => {
    principalOf.current = role;
    for (const [name, call] of Object.entries(calls)) {
      expect((await call()).status, name).toBe('success');
    }
  });

  it('non-uuid ids never reach the API', async () => {
    expect(
      (await actions.updateTaxRateAction(STORE, 'x', { name: 'a', rate_bp: '1' })).status,
    ).toBe('error');
    expect((await actions.deleteTaxRateAction(STORE, 'x')).status).toBe('error');
    expect((await actions.createTaxRateAction('x', create)).status).toBe('error');
    expect(api.updateTaxRate).not.toHaveBeenCalled();
    expect(api.deleteTaxRate).not.toHaveBeenCalled();
    expect(api.createTaxRate).not.toHaveBeenCalled();
  });
});

describe('createTaxRateAction', () => {
  it('sends the parsed body: upper-case country, integer bp, null region and category', async () => {
    await actions.createTaxRateAction(STORE, create);
    expect(api.createTaxRate).toHaveBeenCalledWith(STORE, {
      country: 'NL',
      region: null,
      name: 'VAT 21%',
      rate_bp: 2100,
      product_category_id: null,
    });
  });

  it.each([
    [{ ...create, rate_bp: '10001' }, 'rate_bp'],
    [{ ...create, rate_bp: '-1' }, 'rate_bp'],
    [{ ...create, rate_bp: '21.5' }, 'rate_bp'],
    [{ ...create, country: 'NLD' }, 'country'],
    [{ ...create, name: ' ' }, 'name'],
    [{ ...create, product_category_id: 'nope' }, 'product_category_id'],
  ])('refuses %j before the API, under %s', async (values, field) => {
    const result = await actions.createTaxRateAction(STORE, values);
    expect(result).toMatchObject({ status: 'error', fieldErrors: { [field]: expect.any(String) } });
    expect(api.createTaxRate).not.toHaveBeenCalled();
  });

  it('a category and a region reach the API', async () => {
    await actions.createTaxRateAction(STORE, {
      ...create,
      region: ' CA ',
      product_category_id: CATEGORY,
    });
    expect(api.createTaxRate).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({ region: 'CA', product_category_id: CATEGORY }),
    );
  });

  it('409 duplicate is said', async () => {
    api.createTaxRate.mockResolvedValue(
      fail(409, 'conflict', 'tax rate exists', { tax_rate_id: RATE }),
    );
    const result = await actions.createTaxRateAction(STORE, create);
    expect(result.status === 'error' && result.formError).toMatch(/already exists — edit that one/);
  });

  it('400 on a foreign category lands under the category field', async () => {
    api.createTaxRate.mockResolvedValue(
      fail(400, 'validation_error', 'not a category of this store', {
        field: 'product_category_id',
      }),
    );
    expect(await actions.createTaxRateAction(STORE, create)).toMatchObject({
      fieldErrors: { product_category_id: 'not a category of this store' },
    });
  });
});

describe('deleteTaxRateAction', () => {
  it('409 last_rate_of_market_country names the country and the way out', async () => {
    api.deleteTaxRate.mockResolvedValue(
      fail(409, 'conflict', 'last rate', { country: 'NL', reason: 'last_rate_of_market_country' }),
    );
    const result = await actions.deleteTaxRateAction(STORE, RATE);
    expect(result.status === 'error' && result.formError).toBe(
      'This is the last rate for NL on an active store: removing it would tax NL at 0%. Add another rate for NL first.',
    );
  });

  it('404 is said', async () => {
    api.deleteTaxRate.mockResolvedValue(fail(404, 'not_found', 'not found'));
    const result = await actions.deleteTaxRateAction(STORE, RATE);
    expect(result.status === 'error' && result.formError).toMatch(/not found/);
  });
});

describe('words', () => {
  it.each([
    [2100, '21%'],
    [950, '9.5%'],
    [0, '0%'],
    [10000, '100%'],
    [1234, '12.34%'],
  ])('%i bp reads %s', (bp, words) => {
    expect(formatRate(bp)).toBe(words);
  });

  it('the activation 409 lists the uncovered countries, sorted and validated', () => {
    expect(readMissingTaxCountries({ missing_tax_countries: ['DE', 'BE', 'x', 7] })).toEqual([
      'BE',
      'DE',
    ]);
    expect(readMissingTaxCountries(undefined)).toEqual([]);
    expect(
      activationMessage({
        missing: ['tax_rates', 'primary_domain'],
        missing_tax_countries: ['NL'],
      }),
    ).toBe('Cannot activate: a tax rate for NL, a primary domain missing.');
    expect(activationMessage({ missing: ['tax_rates'] })).toBe(
      'Cannot activate: a tax rate for each market country missing.',
    );
  });

  it('the schema keeps a category-less, region-less rate country-wide', () => {
    expect(taxRateCreateSchema.parse(create)).toMatchObject({
      region: null,
      product_category_id: null,
    });
  });
});
