/**
 * Promotions and price lists against the spec's own examples (Admin API 0.4.5). Prism is spawned
 * here on its own port; the wrappers are pointed at it before the app modules load.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

const BASE = 'http://127.0.0.1:4215';
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
const promotionActions = await import('@/app/actions/promotions');
const pricingActions = await import('@/app/actions/pricing');
const { EMPTY_PROMOTION, describeValue, fromPromotion } = await import('@/lib/promotions/form');
const { forPromotionRows } = await import('@/lib/promotions/projection');
const { editorRows } = await import('@/lib/pricing/editor');

const PROMOTION_ID = '50000000-0000-4000-8000-000000000101';
const PRICE_LIST_ID = '50000000-0000-4000-8000-000000000001';
const VARIANT_ID = '30000000-0000-4000-8000-000000000301';

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('promotions: the wrappers reach the paths the spec documents', () => {
  it('lists promotions with the contract sort, and the rows describe the example value', async () => {
    const result = await api.listPromotions(SEED_STORE_ID, {
      page: 1,
      limit: 20,
      sort: 'created_at',
      order: 'desc',
    });
    if (!result.ok) throw new Error(`listPromotions failed: ${result.status}`);
    const rows = forPromotionRows(result.data.items, 'en-GB');
    expect(rows[0]).toMatchObject({ code: 'WELCOME10', value_label: '10 %', status: 'active' });
  });

  it('reads one promotion and the form round-trips its rules', async () => {
    const result = await api.getPromotion(SEED_STORE_ID, PROMOTION_ID);
    if (!result.ok) throw new Error(`getPromotion failed: ${result.status}`);
    expect(describeValue(result.data)).toBe('buy 2 get 1 free');
    expect(fromPromotion(result.data)).toMatchObject({
      type: 'buy_x_get_y',
      buy_quantity: 2,
      get_quantity: 1,
      exclusive: true,
    });
  });

  it('creates (201) and patches (200) through the actions', async () => {
    const created = await promotionActions.createPromotionAction(SEED_STORE_ID, {
      ...EMPTY_PROMOTION,
      name: 'Welcome 10%',
      code: 'WELCOME10',
      type: 'percentage',
      value_bp: 1000,
      status: 'active',
    });
    expect(created.status).toBe('success');
    if (created.status !== 'success') throw new Error('expected success');
    expect(created.data).toMatchObject({ id: expect.any(String), code: 'WELCOME10' });

    const patched = await promotionActions.updatePromotionAction(SEED_STORE_ID, PROMOTION_ID, {
      ...EMPTY_PROMOTION,
      name: 'Renamed',
      type: 'buy_x_get_y',
      buy_quantity: 2,
      get_quantity: 1,
      status: 'disabled',
    });
    expect(patched.status).toBe('success');
  });

  it('the action refuses what the schema refuses before anything is sent', async () => {
    const result = await promotionActions.createPromotionAction(SEED_STORE_ID, {
      ...EMPTY_PROMOTION,
      name: 'Bad',
      type: 'percentage',
      value_bp: null,
    });
    expect(result).toMatchObject({ status: 'error', formError: 'Enter a percentage' });
  });

  it("the spec's 400 and 409 on createPromotion map to field errors, 403 to a refusal", async () => {
    const ask = (code: number) =>
      adminRequest<'createPromotion'>({
        baseUrl: BASE,
        path: `/admin/stores/${SEED_STORE_ID}/promotions`,
        method: 'POST',
        body: { name: 'x', type: 'percentage' },
        accessToken: 'contract-test-token',
        headers: preferring(code),
      });
    const bad = await ask(400);
    if (bad.ok) throw new Error('expected 400');
    const mappedBad = toActionResult(bad, ['handle', 'name']);
    if (mappedBad.status !== 'error') throw new Error('expected error');
    expect(mappedBad.refusal).toBeUndefined();
    expect(
      Object.keys(mappedBad.fieldErrors).length + (mappedBad.formError === null ? 0 : 1),
    ).toBeGreaterThan(0);

    const conflict = await ask(409);
    if (conflict.ok) throw new Error('expected 409');
    expect(conflict.error.code).toBe('conflict');

    const forbidden = await ask(403);
    if (forbidden.ok) throw new Error('expected 403');
    const mapped = toActionResult(forbidden, []);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal?.status).toBe(403);
  });
});

describe('price lists: the wrappers reach the paths the spec documents', () => {
  it('lists price lists (no paging) and the editor reads a variant price by list id', async () => {
    const lists = await api.listPriceLists(SEED_STORE_ID);
    if (!lists.ok) throw new Error(`listPriceLists failed: ${lists.status}`);
    expect(lists.data.items[0]).toMatchObject({ code: 'default-eur', currency: 'EUR' });

    const products = await api.listProducts(SEED_STORE_ID, { page: 1, limit: 5 });
    if (!products.ok) throw new Error(`listProducts failed: ${products.status}`);
    const rows = editorRows(products.data.items, PRICE_LIST_ID);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('creates a price list (201) through the action', async () => {
    const result = await pricingActions.createPriceListAction(SEED_STORE_ID, {
      code: 'summer-sale',
      name: 'Summer sale',
      type: 'sale',
      currency: 'EUR',
      customer_group_id: '',
      sales_channel_id: '',
      starts_at: '2026-06-01T00:00',
      ends_at: '2026-08-31T23:59',
      status: 'active',
      priority: 10,
    });
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data).toMatchObject({ id: expect.any(String), type: 'sale' });
  });

  it('upserts prices (200 with the count) through the action, and a 400 maps to a form error', async () => {
    const ok = await pricingActions.upsertPricesAction(SEED_STORE_ID, PRICE_LIST_ID, [
      { variant_id: VARIANT_ID, amount_minor: 1999, compare_at_minor: 2499, min_quantity: 1 },
    ]);
    expect(ok).toMatchObject({ status: 'success', data: { upserted: expect.any(Number) } });

    const bad = await adminRequest<'upsertPrices'>({
      baseUrl: BASE,
      path: `/admin/stores/${SEED_STORE_ID}/price-lists/${PRICE_LIST_ID}/prices`,
      method: 'PUT',
      body: { prices: [] },
      accessToken: 'contract-test-token',
      headers: preferring(400),
    });
    if (bad.ok) throw new Error('expected 400');
    const mapped = toActionResult(bad, ['prices']);
    expect(mapped.status).toBe('error');
  });
});
