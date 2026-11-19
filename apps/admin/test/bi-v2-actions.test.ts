/**
 * BI v2 CSV (#871): the server action checks the BI section itself — HQ `bi` (analyst on hq) or the
 * store's `bi` (viewer on the store) — before any API call, rebuilds the block's query from the URL
 * state (never from the browser), and passes the API's CSV (with labels) or its error on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';
import { catalogue, CAT } from './bi-v2-fixtures';

vi.mock('server-only', () => ({}));

const principalOf = vi.hoisted(() => ({ current: 'analyst' as string, fail: 0 }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () =>
    principalOf.fail !== 0
      ? { ok: false, status: principalOf.fail, error: { code: 'unauthorized', message: 'ended' } }
      : {
          ok: true,
          status: 200,
          data: (await import('./fixtures/principals')).principals[
            principalOf.current as PrincipalKey
          ],
        },
}));
const biApi = vi.hoisted(() => ({ listMetrics: vi.fn() }));
vi.mock('@/app/(hq)/bi/_api', () => biApi);
const v2Api = vi.hoisted(() => ({ metricsCsv: vi.fn() }));
vi.mock('@/app/(hq)/bi/_v2/api', () => v2Api);

const { exportBiCsvAction } = await import('@/app/(hq)/bi/_v2/actions');

const window = { from: '2026-11-01', to: '2026-11-15' };

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'analyst';
  principalOf.fail = 0;
  biApi.listMetrics.mockResolvedValue({ ok: true, status: 200, data: catalogue() });
  v2Api.metricsCsv.mockResolvedValue({ ok: true, csv: 'a,b\r\n1,2\r\n3,4\r\n', truncated: false });
});

describe('the BI section is checked before any API call', () => {
  it('HQ: a store admin (no analyst on hq) is refused', async () => {
    principalOf.current = 'storeAdmin';
    expect(await exportBiCsvAction('overview', window, null)).toMatchObject({
      status: 'error',
      refusal: {
        status: 403,
        error: { details: { relation: 'analyst', object: 'organization:hq' } },
      },
    });
    expect(biApi.listMetrics).not.toHaveBeenCalled();
    expect(v2Api.metricsCsv).not.toHaveBeenCalled();
  });

  it('store: a store the principal cannot view is refused; a store id that is not a uuid never reaches the API', async () => {
    principalOf.current = 'storeAdmin';
    expect(await exportBiCsvAction('inventory', window, SEED.stores.brandC)).toMatchObject({
      status: 'error',
      refusal: { status: 403 },
    });
    expect((await exportBiCsvAction('inventory', window, '../hq')).status).toBe('error');
    expect(v2Api.metricsCsv).not.toHaveBeenCalled();
  });

  it('an ended session is the 401 refusal', async () => {
    principalOf.fail = 401;
    expect(await exportBiCsvAction('overview', window, null)).toMatchObject({
      refusal: { status: 401 },
    });
    expect(v2Api.metricsCsv).not.toHaveBeenCalled();
  });

  it('a store admin may export its own store', async () => {
    principalOf.current = 'storeAdmin';
    expect((await exportBiCsvAction('inventory', window, SEED.stores.brandA)).status).toBe(
      'success',
    );
  });
});

describe('the query is rebuilt from the URL state', () => {
  it('overview: the headline query with the window, comparison and filters', async () => {
    const result = await exportBiCsvAction(
      'overview',
      { ...window, compare: 'previous_year', category: CAT },
      null,
    );
    expect(v2Api.metricsCsv).toHaveBeenCalledWith(
      '/admin/metrics/query',
      expect.objectContaining({
        grain: 'total',
        from: '2026-11-01',
        to: '2026-11-15',
        compare: 'previous_year',
        filters: { category_ids: [CAT] },
      }),
    );
    expect(result).toMatchObject({ status: 'success', data: { exported: 2, truncated: false } });
  });

  it('a store view is always narrowed to its store, whatever the URL says', async () => {
    principalOf.current = 'storeAdmin';
    await exportBiCsvAction(
      'breakdown',
      { ...window, store: SEED.stores.brandB, by: 'country' },
      SEED.stores.brandA,
    );
    expect(v2Api.metricsCsv.mock.calls[0]?.[1]).toMatchObject({
      dimensions: ['country'],
      filters: { store_ids: [SEED.stores.brandA] },
    });
  });

  it('products: rank and direction from the state; an unknown rank falls back', async () => {
    await exportBiCsvAction('products', { ...window, rank: 'units', dir: 'asc' }, null);
    expect(v2Api.metricsCsv.mock.calls[0]?.[1]).toMatchObject({
      order_by: { metric: 'units', direction: 'asc' },
    });
    await exportBiCsvAction('products', { ...window, rank: 'drop table' }, null);
    expect(v2Api.metricsCsv.mock.calls[1]?.[1]).toMatchObject({
      order_by: { metric: 'product_net_ex_tax_minor', direction: 'desc' },
    });
  });

  it('inventory: the whole filtered set up to 500 rows, page 1, with the statuses', async () => {
    await exportBiCsvAction('inventory', { status: 'low,reorder', page: '4' }, null);
    expect(v2Api.metricsCsv).toHaveBeenCalledWith(
      '/admin/metrics/inventory',
      expect.objectContaining({ status: ['low', 'reorder'], page: 1, limit: 500 }),
    );
    expect(biApi.listMetrics).not.toHaveBeenCalled();
  });

  it('the API’s refusal or outage is passed on, never a partial file', async () => {
    v2Api.metricsCsv.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: 'unavailable', message: 'analytics store down' },
    });
    expect((await exportBiCsvAction('overview', window, null)).status).toBe('error');
    v2Api.metricsCsv.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'forbidden', message: 'finance only' },
    });
    expect(await exportBiCsvAction('overview', window, null)).toMatchObject({
      refusal: { status: 403 },
    });
  });
});
