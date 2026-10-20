/**
 * Store tax rates (#520) against the spec's own examples (Admin API 0.4.23): the four operations,
 * the refusals the spec documents, and the activation 409 that names the uncovered countries.
 * Prism's `/admin/me` is the store_admin example (store_admin on brand-a), so the actions reach
 * the mock on brand-a.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

// 4211–4220 are taken by the other suites.
const BASE = 'http://127.0.0.1:4221';
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
const actions = await import('@/app/actions/tax-rates');
const { describeTaxRateError, readMissingTaxCountries } = await import('@/lib/tax-rates');

const RATE = '75000000-0000-4000-8000-000000000001';
/** A raw call with a forced status (`Prefer: code=…`): the documented refusal bodies. */
const request = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  code: number,
  body?: unknown,
) =>
  adminRequest<'createTaxRate'>({
    baseUrl: BASE,
    path,
    method,
    accessToken: 'contract-test-token',
    headers: preferring(code),
    ...(body === undefined ? {} : { body }),
  });

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('the tax-rate operations reach the paths the spec documents', () => {
  it('lists the store’s rates', async () => {
    const result = await api.listTaxRates(SEED_STORE_ID);
    if (!result.ok) throw new Error(`listTaxRates failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      country: expect.stringMatching(/^[A-Z]{2}$/),
      rate_bp: expect.any(Number),
      name: expect.any(String),
    });
    expect(result.data.items[0]).toHaveProperty('region');
    expect(result.data.items[0]).toHaveProperty('product_category_id');
  });

  it('deletes through the action (store_admin on brand-a): 204', async () => {
    expect(await actions.deleteTaxRateAction(SEED_STORE_ID, RATE)).toMatchObject({
      status: 'success',
    });
  });

  it('creates and updates through the actions (examples on the 201/200 since 9d39673)', async () => {
    expect(
      await actions.createTaxRateAction(SEED_STORE_ID, {
        country: 'NL',
        name: 'VAT 21%',
        rate_bp: '2100',
      }),
    ).toMatchObject({ status: 'success' });
    expect(
      await actions.updateTaxRateAction(SEED_STORE_ID, RATE, { name: 'VAT', rate_bp: '2000' }),
    ).toMatchObject({ status: 'success' });
  });
});

describe('the documented refusals', () => {
  it('409 on create (the row exists) is said as a duplicate', async () => {
    const result = await request(`/admin/stores/${SEED_STORE_ID}/tax-rates`, 'POST', 409, {
      country: 'NL',
      name: 'VAT',
      rate_bp: 2100,
    });
    if (result.ok) throw new Error('expected 409');
    expect(result.status).toBe(409);
    expect(describeTaxRateError(result).formError).toMatch(/already exists/);
  });

  it('409 on delete is the last-rate conflict or a generic conflict, never a crash', async () => {
    const result = await request(`/admin/stores/${SEED_STORE_ID}/tax-rates/${RATE}`, 'DELETE', 409);
    if (result.ok) throw new Error('expected 409');
    expect(result.status).toBe(409);
    expect(describeTaxRateError(result).formError).toEqual(expect.any(String));
  });

  it('404 on update is said', async () => {
    const result = await request(`/admin/stores/${SEED_STORE_ID}/tax-rates/${RATE}`, 'PATCH', 404, {
      name: 'VAT',
    });
    if (result.ok) throw new Error('expected 404');
    expect(result.status).toBe(404);
    expect(describeTaxRateError(result).formError).toMatch(/not found/);
  });

  it('activateStore’s documented 409 names the uncovered countries', async () => {
    const result = await request(`/admin/stores/${SEED_STORE_ID}/activate`, 'POST', 409);
    if (result.ok) throw new Error('expected 409');
    expect(result.status).toBe(409);
    expect(readMissingTaxCountries(result.error.details)).toEqual(['BE', 'DE']);
  });
});
