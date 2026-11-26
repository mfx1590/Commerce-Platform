/**
 * #903: the six customer, pricing and promotion server actions refuse a principal without the
 * operation's `x-permission` BEFORE the Admin API is called — erasure first (irreversible, privacy).
 * Each table is pinned to `admin-api.yaml`. Mutation-checked: deleting any one action's guard
 * fails that action's "refused before the API" case here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/** A principal key, or a failed `/admin/me` answer (the session ended). */
const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string | { status: number } }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => {
    const current = principalOf.current;
    if (typeof current !== 'string') {
      return {
        ok: false,
        status: current.status,
        error: { code: 'unauthorized', message: 'session ended' },
      };
    }
    return {
      ok: true,
      status: 200,
      data: (await import('./fixtures/principals')).principals[current as PrincipalKey],
    };
  },
}));

const api = vi.hoisted(() => ({
  updateCustomer: vi.fn(),
  eraseCustomer: vi.fn(),
  exportCustomer: vi.fn(),
  createPriceList: vi.fn(),
  upsertPrices: vi.fn(),
  createPromotion: vi.fn(),
  updatePromotion: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const { eraseCustomerAction, requestCustomerExportAction, updateCustomerAction } =
  await import('@/app/actions/customers');
const { createPriceListAction, upsertPricesAction } = await import('@/app/actions/pricing');
const { createPromotionAction, updatePromotionAction } = await import('@/app/actions/promotions');
const { CUSTOMER_PERMISSIONS } = await import('@/lib/customers/permissions');
const { PRICING_PERMISSIONS } = await import('@/lib/pricing/permissions');
const { PROMOTION_PERMISSIONS } = await import('@/lib/promotions/permissions');
const { EMPTY_PROMOTION } = await import('@/lib/promotions/form');

const STORE = SEED.stores.brandA;
const CUSTOMER = '30000000-0000-4000-8000-00000000cafe';
const LIST = '50000000-0000-4000-8000-000000000002';
const PROMOTION = '60000000-0000-4000-8000-000000000001';
const VARIANT = '30000000-0000-4000-8000-00000000face';

const promotionValues = {
  ...EMPTY_PROMOTION,
  code: 'WELCOME10',
  name: 'Welcome',
  value_bp: 1000,
};

interface Case {
  operation: string;
  call: () => Promise<{ status: string }>;
  allowed: PrincipalKey;
  /** Holds the store but not this operation's relation. */
  refused: PrincipalKey;
  api: ReturnType<typeof vi.fn>;
}

const CASES: Case[] = [
  {
    // A GDPR export builds a bundle of everything held about one person, so `support` — which may
    // read the record on screen — is refused (#870 item 4 PR C).
    operation: 'exportCustomer',
    call: () => requestCustomerExportAction(STORE, CUSTOMER),
    allowed: 'storeAdmin',
    refused: 'support',
    api: api.exportCustomer,
  },
  {
    operation: 'eraseCustomer',
    call: () => eraseCustomerAction(STORE, CUSTOMER),
    allowed: 'storeAdmin',
    refused: 'support',
    api: api.eraseCustomer,
  },
  {
    operation: 'updateCustomer',
    call: () => updateCustomerAction(STORE, CUSTOMER, { first_name: 'Jane' } as never),
    allowed: 'support',
    refused: 'storeStaff',
    api: api.updateCustomer,
  },
  {
    operation: 'createPriceList',
    call: () =>
      createPriceListAction(STORE, {
        code: 'wholesale',
        name: 'Wholesale',
        type: 'override',
        currency: 'EUR',
        status: 'draft',
        priority: 0,
      }),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
    api: api.createPriceList,
  },
  {
    operation: 'upsertPrices',
    call: () =>
      upsertPricesAction(STORE, LIST, [
        { variant_id: VARIANT, amount_minor: 1200, currency: 'EUR', min_quantity: 1 },
      ]),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
    api: api.upsertPrices,
  },
  {
    operation: 'createPromotion',
    call: () => createPromotionAction(STORE, promotionValues),
    allowed: 'storeAdmin',
    refused: 'support',
    api: api.createPromotion,
  },
  {
    operation: 'updatePromotion',
    call: () => updatePromotionAction(STORE, PROMOTION, promotionValues),
    allowed: 'storeAdmin',
    refused: 'storeStaff',
    api: api.updatePromotion,
  },
];

beforeEach(() => {
  for (const fn of Object.values(api)) {
    fn.mockReset();
    fn.mockResolvedValue({ ok: true, status: 200, data: { id: PROMOTION } });
  }
});

describe.each(CASES)('$operation', ({ call, allowed, refused, api: request }) => {
  it(`refuses ${refused} with the contract's 403 before the API is called`, async () => {
    principalOf.current = refused;
    const result = await call();
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'error',
      refusal: { status: 403, error: { code: 'forbidden', details: { object: `store:${STORE}` } } },
    });
  });

  it('refuses when the session ended (401), without calling the API', async () => {
    principalOf.current = { status: 401 };
    const result = await call();
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'error', refusal: { status: 401 } });
  });

  it(`lets ${allowed} through to the API`, async () => {
    principalOf.current = allowed;
    await call();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('the relation is checked on the URL store, not on any store', () => {
  it('a store admin of brand-a and brand-b cannot erase on brand-c', async () => {
    principalOf.current = 'storeAdmin';
    const result = await eraseCustomerAction(SEED.stores.brandC, CUSTOMER);
    expect(api.eraseCustomer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'error', refusal: { status: 403 } });
  });
});

describe('a store id that is not a uuid', () => {
  it('never reaches the principal check or the API (erase)', async () => {
    principalOf.current = 'owner';
    const result = await eraseCustomerAction('../brand-a', CUSTOMER);
    expect(api.eraseCustomer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'error', formError: 'That store is not valid.' });
  });
});

describe('the #903 permission tables', () => {
  const spec = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const tables = { ...CUSTOMER_PERMISSIONS, ...PRICING_PERMISSIONS, ...PROMOTION_PERMISSIONS };

  it('are the x-permission admin-api.yaml carries', () => {
    for (const [operation, { relation }] of Object.entries(tables)) {
      const at = spec.indexOf(`operationId: ${operation}\n`);
      expect(at, operation).toBeGreaterThan(-1);
      const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
        spec.slice(at, at + 2000),
      );
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe('store:{storeId}');
    }
  });

  it('cover exactly the guarded actions this file exercises — a new one must be added here', () => {
    expect(Object.keys(tables).sort()).toEqual(CASES.map((c) => c.operation).sort());
  });
});
