/**
 * Bulk actions on tables (#870 wave 1 item 2): the pure core (resolving a selection on the server,
 * per-row outcomes, concurrency, the report) and the catalog's bulk publish / archive — refused up
 * front and per row, never acting on rows nobody saw, every row reported. Also the catalog
 * permissions now pinned to the yaml and checked for the single-row publish / archive.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';

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
  listProducts: vi.fn(),
  publishProduct: vi.fn(),
  archiveProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createCategory: vi.fn(),
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
  listOrders: vi.fn(),
  cancelOrder: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const bulk = await import('@/lib/table/bulk');
const { bulkArchiveProductsAction, bulkPublishProductsAction } =
  await import('@/app/actions/bulk-catalog');
const { archiveProductAction, publishProductAction } = await import('@/app/actions/catalog');
const { bulkCancelOrdersAction } = await import('@/app/actions/bulk-orders');
const { CATALOG_PERMISSIONS } = await import('@/lib/catalog/permissions');

const STORE = SEED.stores.brandA;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const product = (n: number) => ({ id: id(n), title: `Product ${n}`, status: 'draft' });
const ok = <T>(data: T, status = 200) => ({ ok: true as const, status, data });
const fail = (status: number, message: string) => ({
  ok: false as const,
  status,
  error: { code: status === 409 ? 'conflict' : 'error', message },
});
/** A list of `count` products, paged as the API pages it. */
const listOf = (count: number) => (_store: string, query: { page: number; limit: number }) => {
  const all = Array.from({ length: count }, (_, i) => product(i + 1));
  const start = (query.page - 1) * query.limit;
  return Promise.resolve(
    ok({
      page: query.page,
      limit: query.limit,
      total: count,
      items: all.slice(start, start + query.limit),
    }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.publishProduct.mockImplementation((_s: string, productId: string) =>
    Promise.resolve(
      ok({ id: productId, title: `Title of ${productId.slice(-3)}`, status: 'published' }),
    ),
  );
  api.archiveProduct.mockResolvedValue(ok(null, 204));
  api.listProducts.mockImplementation(listOf(3));
});

describe('resolveSelection', () => {
  const listPage = (count: number) => (page: number, limit: number) =>
    listOf(count)(STORE, { page, limit });

  it('rows: deduplicated uuids, no list read', async () => {
    const read = vi.fn();
    const resolved = await bulk.resolveSelection(
      { mode: 'rows', ids: [id(1), id(2), id(1)] },
      (p: { id: string }) => p.id,
      read,
    );
    expect(resolved).toEqual({
      ok: true,
      rows: [
        { id: id(1), row: null },
        { id: id(2), row: null },
      ],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('rows: a non-uuid or an empty selection is refused', async () => {
    expect(
      (
        await bulk.resolveSelection(
          { mode: 'rows', ids: ['nope'] },
          (p: { id: string }) => p.id,
          vi.fn(),
        )
      ).ok,
    ).toBe(false);
    expect(
      (await bulk.resolveSelection({ mode: 'rows', ids: [] }, (p: { id: string }) => p.id, vi.fn()))
        .ok,
    ).toBe(false);
  });

  it('rows: more than the cap is refused', async () => {
    const ids = Array.from({ length: bulk.BULK_CAP + 1 }, (_, i) => id(i + 1));
    expect(
      await bulk.resolveSelection({ mode: 'rows', ids }, (p: { id: string }) => p.id, vi.fn()),
    ).toMatchObject({ ok: false, message: expect.stringContaining('at most 500') });
  });

  it('all matching: every page re-read, the unticked rows left out', async () => {
    const resolved = await bulk.resolveSelection(
      { mode: 'all-matching', excluded: [id(2)], total: 250, filters: {} },
      (p: { id: string }) => p.id,
      listPage(250),
    );
    expect(resolved.ok && resolved.rows.length).toBe(249);
    expect(resolved.ok && resolved.rows.some((r) => r.id === id(2))).toBe(false);
    expect(resolved.ok && resolved.rows[0]?.row).toMatchObject({ title: 'Product 1' });
  });

  it('all matching: a total that moved since the user saw it is refused', async () => {
    expect(
      await bulk.resolveSelection(
        { mode: 'all-matching', excluded: [], total: 12, filters: {} },
        (p: { id: string }) => p.id,
        listPage(13),
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('12 → 13') });
  });

  it('all matching: more than the cap is refused before any write', async () => {
    expect(
      await bulk.resolveSelection(
        { mode: 'all-matching', excluded: [], total: 501, filters: {} },
        (p: { id: string }) => p.id,
        listPage(501),
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('501 rows') });
  });
});

describe('outcomes, concurrency and the report', () => {
  it('outcomeOf: done, 409 skipped, 403 refused, 4xx failed, 0/5xx unknown', () => {
    expect(bulk.outcomeOf({ ok: true }, 'Done.').outcome).toBe('done');
    expect(bulk.outcomeOf(fail(409, 'already published'), '').outcome).toBe('skipped');
    expect(bulk.outcomeOf(fail(403, 'no'), '').outcome).toBe('refused');
    expect(bulk.outcomeOf(fail(404, 'gone'), '').outcome).toBe('failed');
    for (const status of [0, 500, 502, 504]) {
      const result = bulk.outcomeOf(fail(status, 'reset'), '');
      expect(result.outcome).toBe('unknown');
      expect(result.message).toContain('check this row before running it again');
    }
  });

  it('runBulk: at most N in flight, results in order, a throw fails only its row', async () => {
    let inFlight = 0;
    let most = 0;
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: id(i + 1) }));
    const report = await bulk.runBulk(
      rows,
      async (row) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        if (row.id === id(3)) throw new Error('boom');
        return { id: row.id, label: row.id, outcome: 'done', message: '' };
      },
      3,
    );
    expect(most).toBe(3);
    expect(report.results.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(report.results[2]).toMatchObject({ outcome: 'failed', message: 'boom' });
    expect(report.counts).toMatchObject({ done: 9, failed: 1 });
  });

  it('describeReport leaves zero counts out; sortForReport puts what needs attention first', () => {
    expect(bulk.describeReport({ done: 12, skipped: 1, failed: 2, unknown: 0, refused: 0 })).toBe(
      '12 done · 1 skipped · 2 failed',
    );
    const sorted = bulk.sortForReport([
      { id: 'a', label: 'a', outcome: 'done', message: '' },
      { id: 'b', label: 'b', outcome: 'skipped', message: '' },
      { id: 'c', label: 'c', outcome: 'unknown', message: '' },
      { id: 'd', label: 'd', outcome: 'failed', message: '' },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['c', 'd', 'b', 'a']);
  });
});

describe('bulk publish / archive on the catalog', () => {
  it('a principal without the relation is refused before any read or write', async () => {
    principalOf.current = 'storeStaff'; // store_staff: may publish, not archive
    expect(await bulkArchiveProductsAction(STORE, { mode: 'rows', ids: [id(1)] })).toMatchObject({
      status: 'error',
      refusal: { status: 403, error: { details: { relation: 'store_admin' } } },
    });
    principalOf.current = 'finance'; // no store relation that reaches store_staff
    expect(await bulkPublishProductsAction(STORE, { mode: 'rows', ids: [id(1)] })).toMatchObject({
      status: 'error',
      refusal: { status: 403 },
    });
    expect(api.listProducts).not.toHaveBeenCalled();
    expect(api.archiveProduct).not.toHaveBeenCalled();
    expect(api.publishProduct).not.toHaveBeenCalled();
  });

  it('store_staff publishes; a store the principal does not hold is refused', async () => {
    principalOf.current = 'storeStaff';
    expect((await bulkPublishProductsAction(STORE, { mode: 'rows', ids: [id(1)] })).status).toBe(
      'success',
    );
    expect(
      (await bulkPublishProductsAction(SEED.stores.brandB, { mode: 'rows', ids: [id(1)] })).status,
    ).toBe('error');
    expect(api.publishProduct).toHaveBeenCalledTimes(1);
  });

  it('ticked rows: one call per row, each reported with the title the API answered', async () => {
    api.publishProduct
      .mockResolvedValueOnce(ok({ id: id(1), title: 'Linen towel', status: 'published' }))
      .mockResolvedValueOnce(fail(409, 'already published'))
      .mockResolvedValueOnce(fail(0, 'socket hang up'));
    const result = await bulkPublishProductsAction(STORE, {
      mode: 'rows',
      ids: [id(1), id(2), id(3)],
    });
    expect(api.publishProduct).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: 'success',
      data: {
        counts: { done: 1, skipped: 1, unknown: 1, failed: 0, refused: 0 },
        results: [
          { id: id(1), label: 'Linen towel', outcome: 'done' },
          { id: id(2), outcome: 'skipped', message: 'already published' },
          { id: id(3), outcome: 'unknown' },
        ],
      },
    });
  });

  it('all matching: re-reads with the table’s filters only, and labels rows with their titles', async () => {
    const result = await bulkArchiveProductsAction(STORE, {
      mode: 'all-matching',
      excluded: [id(3)],
      total: 3,
      filters: { status: 'draft', category_id: id(99), injected: 'x' },
    });
    expect(api.listProducts).toHaveBeenCalledWith(STORE, {
      status: 'draft',
      category_id: id(99),
      page: 1,
      limit: 100,
    });
    expect(api.archiveProduct.mock.calls.map(([, productId]) => productId)).toEqual([id(1), id(2)]);
    expect(result).toMatchObject({
      status: 'success',
      data: { results: [{ label: 'Product 1', outcome: 'done' }, { label: 'Product 2' }] },
    });
  });

  it('all matching: the list moved → refused, nothing archived', async () => {
    const result = await bulkArchiveProductsAction(STORE, {
      mode: 'all-matching',
      excluded: [],
      total: 2,
      filters: {},
    });
    expect(result).toMatchObject({ status: 'error', formError: expect.stringContaining('2 → 3') });
    expect(api.archiveProduct).not.toHaveBeenCalled();
  });

  it('the permission is checked again per row: a row is never acted on unchecked', async () => {
    let checks = 0;
    // The principal answers once for the up-front check, then loses the relation.
    const fixtures = await import('./fixtures/principals');
    const principal = await import('@/lib/principal');
    const spy = vi.spyOn(principal, 'loadPrincipal').mockImplementation(async () => {
      checks += 1;
      return {
        ok: true,
        status: 200,
        data: checks === 1 ? fixtures.principals.storeAdmin : fixtures.principals.finance,
      } as Awaited<ReturnType<typeof principal.loadPrincipal>>;
    });
    const result = await bulkArchiveProductsAction(STORE, { mode: 'rows', ids: [id(1), id(2)] });
    spy.mockRestore();
    expect(api.archiveProduct).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'success',
      data: { counts: { refused: 2 } },
    });
  });
});

describe('catalog permissions', () => {
  const spec = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('are the x-permission admin-api.yaml carries', () => {
    for (const [operation, { relation }] of Object.entries(CATALOG_PERMISSIONS)) {
      const at = spec.indexOf(`operationId: ${operation}\n`);
      expect(at, operation).toBeGreaterThan(-1);
      const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
        spec.slice(at, at + 2000),
      );
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe('store:{storeId}');
    }
  });

  it('single-row publish and archive are now refused before the API', async () => {
    principalOf.current = 'storeStaff';
    expect(await archiveProductAction(STORE, id(1))).toMatchObject({
      status: 'error',
      refusal: { status: 403 },
    });
    principalOf.current = 'analyst';
    expect(await publishProductAction(STORE, id(1))).toMatchObject({ status: 'error' });
    expect(api.archiveProduct).not.toHaveBeenCalled();
    expect(api.publishProduct).not.toHaveBeenCalled();
  });
});

describe('bulk cancel on the orders table', () => {
  const order = (n: number) => ({ id: id(n), display_id: 1000 + n, status: 'confirmed' });

  beforeEach(() => {
    api.cancelOrder.mockImplementation((_s: string, orderId: string) =>
      Promise.resolve(ok({ id: orderId, display_id: 1000 + Number(orderId.slice(-3)) })),
    );
    api.listOrders.mockResolvedValue(
      ok({ page: 1, limit: 100, total: 2, items: [order(1), order(2)] }),
    );
  });

  it('a reason is required; nothing is read or cancelled without one', async () => {
    expect(
      await bulkCancelOrdersAction(STORE, { mode: 'rows', ids: [id(1)] }, '   '),
    ).toMatchObject({ status: 'error', formError: 'Say why the orders are cancelled.' });
    expect(api.cancelOrder).not.toHaveBeenCalled();
  });

  it('store_staff is refused before any call (cancelOrder is store_admin)', async () => {
    principalOf.current = 'storeStaff';
    expect(
      await bulkCancelOrdersAction(STORE, { mode: 'rows', ids: [id(1)] }, 'out of stock'),
    ).toMatchObject({ status: 'error', refusal: { status: 403 } });
    expect(api.listOrders).not.toHaveBeenCalled();
    expect(api.cancelOrder).not.toHaveBeenCalled();
  });

  it('one reason for every row; a 409 is skipped in the API’s words, labelled by order number', async () => {
    api.cancelOrder
      .mockResolvedValueOnce(ok({ id: id(1), display_id: 1001 }))
      .mockResolvedValueOnce(fail(409, 'order already fulfilled'));
    const result = await bulkCancelOrdersAction(
      STORE,
      {
        mode: 'all-matching',
        excluded: [],
        total: 2,
        filters: { status: 'confirmed', placed_from: '2026-11-01T00:00:00.000Z' },
      },
      ' out of stock ',
    );
    expect(api.listOrders).toHaveBeenCalledWith(STORE, {
      status: 'confirmed',
      placed_from: '2026-11-01T00:00:00.000Z',
      page: 1,
      limit: 100,
    });
    expect(api.cancelOrder.mock.calls.map(([, orderId, body]) => [orderId, body])).toEqual([
      [id(1), { reason: 'out of stock' }],
      [id(2), { reason: 'out of stock' }],
    ]);
    expect(result).toMatchObject({
      status: 'success',
      data: {
        counts: { done: 1, skipped: 1 },
        results: [
          { label: '#1001', outcome: 'done' },
          { label: '#1002', outcome: 'skipped', message: 'order already fulfilled' },
        ],
      },
    });
  });
});
