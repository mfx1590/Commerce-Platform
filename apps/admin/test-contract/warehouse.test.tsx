/**
 * HQ warehouse and store inventory (#468) against the spec's own examples (Admin API 0.4.15): the
 * reads and mutations the screens call, and the refusals the spec documents. Prism's `/admin/me`
 * example is a store_admin, so the actions are refused by the server-side guard before the API
 * here, and the operations themselves are exercised through the wrappers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

// 4211–4219 are taken by the other suites.
const BASE = 'http://127.0.0.1:4220';
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
const actions = await import('@/app/actions/warehouse');
const { describeCycleCountError, describeMapError } = await import('@/lib/warehouse');

const ITEM = '71000000-0000-4000-8000-000000000001';
const VARIANT = '30000000-0000-4000-8000-000000000301';
const COUNT = '72000000-0000-4000-8000-000000000001';
const WAREHOUSE = '00000000-0000-4000-8000-000000000021';

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('the warehouse reads reach the paths the spec documents', () => {
  it('lists inventory levels for a store, with the pool fields the table keys on', async () => {
    const result = await api.listInventoryLevels({ store_id: SEED_STORE_ID, sort: 'sku' });
    if (!result.ok) throw new Error(`listInventoryLevels failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      variant_id: expect.any(String),
      warehouse_id: expect.any(String),
      stock_item_id: expect.any(String),
      on_hand: expect.any(Number),
      available: expect.any(Number),
    });
  });

  it('lists stock items with variants and levels', async () => {
    const result = await api.listStockItems({ shared: 'true', limit: 25 });
    if (!result.ok) throw new Error(`listStockItems failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      id: expect.any(String),
      sku: expect.any(String),
      variants: expect.any(Array),
      levels: expect.any(Array),
    });
  });

  it('lists cycle counts', async () => {
    const result = await api.listCycleCounts({ status: 'flagged', limit: 25 });
    if (!result.ok) throw new Error(`listCycleCounts failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      id: expect.any(String),
      status: expect.stringMatching(/^(recorded|flagged|applied)$/),
      counted_quantity: expect.any(Number),
    });
  });
});

describe('the warehouse mutations against the spec', () => {
  it('mapVariantToStockItem answers the stock item', async () => {
    const result = await api.mapVariantToStockItem(ITEM, VARIANT);
    expect(result).toMatchObject({ ok: true, data: { id: expect.any(String) } });
  });

  it('createCycleCount answers 201 with a recorded count', async () => {
    const result = await api.createCycleCount({
      warehouse_id: WAREHOUSE,
      stock_item_id: ITEM,
      counted_quantity: 38,
    });
    expect(result).toMatchObject({ ok: true, status: 201 });
  });

  it('reconcileCycleCount answers the count — without a body, and with approve', async () => {
    expect(await api.reconcileCycleCount(COUNT)).toMatchObject({ ok: true });
    expect(await api.reconcileCycleCount(COUNT, true)).toMatchObject({ ok: true });
  });

  it("every warehouse action is refused for Prism's store_admin before the API (operations on hq)", async () => {
    const refusal = {
      status: 'error',
      refusal: {
        status: 403,
        error: { details: { relation: 'operations', object: 'organization:hq' } },
      },
    };
    expect(await actions.mapVariantAction(ITEM, VARIANT)).toMatchObject(refusal);
    expect(
      await actions.recordCycleCountAction({
        warehouse_id: WAREHOUSE,
        stock_item_id: ITEM,
        counted_quantity: '1',
      }),
    ).toMatchObject(refusal);
    expect(await actions.reconcileCycleCountAction(COUNT, false)).toMatchObject(refusal);
  });

  it("the documented 409 on mapVariantToStockItem reads as 'move the stock first'", async () => {
    const result = await adminRequest<'mapVariantToStockItem'>({
      baseUrl: BASE,
      path: `/admin/stock-items/${ITEM}/variants/${VARIANT}`,
      method: 'PUT',
      accessToken: 'contract-test-token',
      headers: preferring(409),
    });
    if (result.ok) throw new Error('expected 409');
    expect(describeMapError(result).formError).toMatch(/move the stock first/);
  });

  it('the documented 409 superseded and 422 counted_at on createCycleCount read as the brief says', async () => {
    const request = (code: number) =>
      adminRequest<'createCycleCount'>({
        baseUrl: BASE,
        path: '/admin/cycle-counts',
        method: 'POST',
        body: { warehouse_id: WAREHOUSE, stock_item_id: ITEM, counted_quantity: 38 },
        accessToken: 'contract-test-token',
        headers: preferring(code),
      });
    const superseded = await request(409);
    if (superseded.ok) throw new Error('expected 409');
    expect(describeCycleCountError(superseded).formError).toMatch(
      /newer count of this shelf is already applied/,
    );
    const future = await request(422);
    if (future.ok) throw new Error('expected 422');
    expect(describeCycleCountError(future, ['counted_at']).fieldErrors).toEqual({
      counted_at: 'The count’s time is in the future.',
    });
  });
});
