/**
 * Store readiness (#830; CONTRACT CHANGE #839, local stand-in): the body is parsed, never trusted —
 * a core that answers another shape is a failure (the retry panel), not a wrong "ready" — and
 * "can sell" needs ACTIVE, a payment method and a purchasable product together.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canSell,
  missingLabels,
  parseReadiness,
  productCount,
  type StoreReadiness,
} from '@/lib/readiness';

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
    ['a warning that is not a string', { ...body, warnings: [42] }],
  ])('refuses %s', (_name, value) => {
    expect(parseReadiness(value)).toBeNull();
  });

  it('#910: a warning the contract does not declare yet is kept aside, not a 502 that hides the box', () => {
    expect(
      parseReadiness({ ...body, warnings: ['no_purchasable_product', 'later_warning'] }),
    ).toEqual({ ...body, warnings: ['no_purchasable_product'], other_warnings: ['later_warning'] });
  });

  it('#910: the wrapper answers such a body as data, not as a failure', async () => {
    client.adminRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...body, warnings: ['later_warning'] },
    });
    expect(await getStoreReadiness(STORE)).toMatchObject({
      ok: true,
      data: { warnings: [], other_warnings: ['later_warning'] },
    });
  });
});

describe('missingLabels', () => {
  it('words each item, with the countries the core named; an unknown item is kept', () => {
    expect(
      missingLabels({
        ...body,
        missing: ['tax_rates', 'shipping_options', 'payment_method', 'something_new'],
        missing_tax_countries: ['DE', 'AT'],
        missing_shipping_countries: ['FR'],
      }),
    ).toEqual([
      'a tax rate for DE, AT',
      'a shipping option for FR',
      'a payment method customers can pay with (card or pay on invoice)',
      'something_new',
    ]);
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
  it('#910: an ACTIVE store that lost a prerequisite cannot sell, whatever else it has', () => {
    const selling = { ...active, payment_methods: ['card' as const], purchasable_products: 5 };
    expect(canSell(selling)).toBe(true);
    for (const item of ['tax_rates', 'shipping_options', 'payment_method', 'something_new']) {
      expect(canSell({ ...selling, missing: [item] }), item).toBe(false);
    }
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
