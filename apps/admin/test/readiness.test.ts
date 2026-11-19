/**
 * Store readiness (#830; CONTRACT CHANGE #839, local stand-in): the body is parsed, never trusted —
 * a core that answers another shape is a failure (the retry panel), not a wrong "ready" — and
 * "can sell" needs ACTIVE, a payment method and a purchasable product together.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canSell, parseReadiness, productCount, type StoreReadiness } from '@/lib/readiness';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({ getSession: async () => ({ accessToken: 'tok' }) }));
vi.mock('@/lib/api/api-mode', () => ({ apiMode: async () => ({ mode: 'core' }) }));
const client = vi.hoisted(() => ({ adminRequest: vi.fn() }));
vi.mock('@/lib/api/admin-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adminRequest: client.adminRequest,
}));

const { getStoreReadiness } = await import('@/lib/api/admin');

const STORE = '00000000-0000-4000-8000-000000000034';
const body: StoreReadiness = {
  status: 'draft',
  missing: ['payment_method'],
  missing_tax_countries: [],
  missing_shipping_countries: [],
  payment_methods: [],
  purchasable_products: 0,
  warnings: ['no_purchasable_product'],
};

beforeEach(() => client.adminRequest.mockReset());

describe('parseReadiness', () => {
  it('accepts the contract shape (the getStoreReadiness example); an unknown missing item is kept', () => {
    expect(parseReadiness(body)).toEqual(body);
    expect(parseReadiness({ ...body, missing: ['something_new'] })).toMatchObject({
      missing: ['something_new'],
    });
  });

  it.each([
    ['not an object', 'ready'],
    ['a field missing', { ...body, purchasable_products: undefined }],
    ['a negative count', { ...body, purchasable_products: -1 }],
    ['an unknown payment method', { ...body, payment_methods: ['crypto'] }],
    ['an unknown status', { ...body, status: 'live' }],
    ['a warning the contract does not declare', { ...body, warnings: ['later_warning'] }],
  ])('refuses %s', (_name, value) => {
    expect(parseReadiness(value)).toBeNull();
  });
});

describe('canSell', () => {
  const active = { ...body, status: 'active' as const, missing: [], warnings: [] };
  it('needs active, a payment method and a purchasable product', () => {
    expect(canSell({ ...active, payment_methods: ['invoice'], purchasable_products: 1 })).toBe(
      true,
    );
    expect(canSell({ ...active, payment_methods: [], purchasable_products: 1 })).toBe(false);
    expect(canSell({ ...active, payment_methods: ['card'], purchasable_products: 0 })).toBe(false);
    expect(
      canSell({ ...active, status: 'draft', payment_methods: ['card'], purchasable_products: 3 }),
    ).toBe(false);
  });
  it('counts in words', () => {
    expect(productCount(1)).toBe('1 product');
    expect(productCount(0)).toBe('0 products');
  });
});

describe('getStoreReadiness (wrapper)', () => {
  it('GETs /admin/stores/{id}/readiness and returns the parsed body', async () => {
    client.adminRequest.mockResolvedValue({ ok: true, status: 200, data: body });
    expect(await getStoreReadiness(STORE)).toEqual({ ok: true, status: 200, data: body });
    expect(client.adminRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/admin/stores/${STORE}/readiness`, accessToken: 'tok' }),
    );
  });

  it('a body of another shape is a 502 failure, never a guess', async () => {
    client.adminRequest.mockResolvedValue({ ok: true, status: 200, data: { ready: true } });
    expect(await getStoreReadiness(STORE)).toMatchObject({
      ok: false,
      status: 502,
      error: { code: 'bad_response' },
    });
  });

  it('a failure passes through', async () => {
    client.adminRequest.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'forbidden', message: 'no' },
    });
    expect(await getStoreReadiness(STORE)).toMatchObject({ ok: false, status: 403 });
  });
});
