/**
 * CSV for the tables and "Export CSV" of a filtered list (#870 wave 1 item 2): quoting and the
 * formula-injection guard, the bulk report as CSV, the filters in words, the export actions
 * (section checked server-side, filters and sort whitelisted, paged to the cap, truncation said),
 * and every catalog action now refused in the admin before the API.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string, fail: 0 }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () =>
    principalOf.fail !== 0
      ? {
          ok: false,
          status: principalOf.fail,
          error: { code: 'unauthorized', message: 'session ended' },
        }
      : {
          ok: true,
          status: 200,
          data: (await import('./fixtures/principals')).principals[
            principalOf.current as PrincipalKey
          ],
        },
}));

const api = vi.hoisted(() => ({
  listProducts: vi.fn(),
  listOrders: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
  createCategory: vi.fn(),
  publishProduct: vi.fn(),
  archiveProduct: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const { csvCell, toCsv, reportCsv, csvFileName, EXPORT_CAP } = await import('@/lib/table/csv');
const { describeFilters } = await import('@/lib/table/bulk');
const { exportOrdersCsvAction, exportProductsCsvAction } =
  await import('@/app/actions/export-lists');
const catalog = await import('@/app/actions/catalog');

const STORE = SEED.stores.brandA;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });
const product = (n: number) => ({
  id: id(n),
  title: n === 1 ? '=HYPERLINK("http://evil.example","x")' : `Towel, size ${n}`,
  handle: `towel-${n}`,
  status: 'published',
  variants: [{}, {}],
  published_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-02T00:00:00Z',
});
const pagedProducts =
  (count: number) => (_store: string, query: { page: number; limit: number }) => {
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
const sort = { sort: null, order: 'desc' as const };

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  principalOf.fail = 0;
  api.listProducts.mockImplementation(pagedProducts(3));
});

describe('CSV', () => {
  it('quotes commas, quotes and line breaks; doubles quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(1200)).toBe('1200');
  });

  it('a cell that would run as a spreadsheet formula is prefixed with a quote', () => {
    for (const start of ['=', '+', '-', '@']) {
      expect(csvCell(`${start}SUM(A1)`)).toBe(`'${start}SUM(A1)`);
    }
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    // Numbers stay numbers, negative ones included.
    expect(csvCell(-5)).toBe('-5');
  });

  it('CRLF rows; the report has every row with its result', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
    expect(
      reportCsv([
        { id: id(1), label: 'Linen, towel', outcome: 'failed', message: 'gone' },
        { id: id(2), label: '#1002', outcome: 'skipped', message: 'already fulfilled' },
      ]),
    ).toBe(
      `id,name,result,message\r\n${id(1)},"Linen, towel",failed,gone\r\n${id(2)},#1002,skipped,already fulfilled\r\n`,
    );
    expect(csvFileName('orders', new Date('2026-11-17T09:30:12Z'))).toBe(
      'orders-2026-11-17T09-30.csv',
    );
  });
});

describe('the filters "all matching" acts on, in words', () => {
  it('named, valued, and an unnamed key still said', () => {
    expect(
      describeFilters(
        { status: 'draft', category_id: id(9), other: 'x' },
        {
          status: { label: 'Status' },
          category_id: { label: 'Category', value: () => 'Kitchen' },
        },
      ),
    ).toBe('Status: draft · Category: Kitchen · other: x');
    expect(describeFilters({})).toBe('');
  });
});

describe('Export CSV of the filtered list', () => {
  it('pages through, with only the table’s filters and sort, and writes every row', async () => {
    const result = await exportProductsCsvAction(
      STORE,
      { status: 'published', category_id: id(9), limit: '5', evil: 'x' },
      { sort: 'title', order: 'asc' },
    );
    expect(api.listProducts).toHaveBeenCalledWith(STORE, {
      status: 'published',
      category_id: id(9),
      sort: 'title',
      order: 'asc',
      page: 1,
      limit: 100,
    });
    expect(result).toMatchObject({
      status: 'success',
      data: { exported: 3, total: 3, truncated: false },
    });
    const csv = result.status === 'success' ? result.data.csv : '';
    expect(csv.split('\r\n')[0]).toBe('id,title,handle,status,variants,published_at,updated_at');
    // The injected formula is neutralised; a comma is quoted.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csv).toContain('"Towel, size 2"');
  });

  it('a sort the table does not offer is dropped', async () => {
    await exportProductsCsvAction(STORE, {}, { sort: 'price; drop', order: 'asc' });
    expect(api.listProducts.mock.calls[0]?.[1]).not.toHaveProperty('sort');
  });

  it('stops at the cap and says the file holds the first rows', async () => {
    api.listProducts.mockImplementation(pagedProducts(EXPORT_CAP + 250));
    const result = await exportProductsCsvAction(STORE, {}, sort);
    expect(api.listProducts).toHaveBeenCalledTimes(EXPORT_CAP / 100);
    expect(result).toMatchObject({
      status: 'success',
      data: { exported: EXPORT_CAP, total: EXPORT_CAP + 250, truncated: true },
    });
  });

  it('orders: money in minor units with its currency', async () => {
    api.listOrders.mockResolvedValue(
      ok({
        page: 1,
        limit: 100,
        total: 1,
        items: [
          {
            id: id(1),
            display_id: 1042,
            placed_at: '2026-11-10T10:00:00Z',
            email: 'a@example.com',
            status: 'confirmed',
            payment_status: 'authorized',
            fulfillment_status: 'not_fulfilled',
            total: { amount_minor: 120000, currency: 'JPY' },
          },
        ],
      }),
    );
    const result = await exportOrdersCsvAction(
      STORE,
      { placed_from: '2026-11-01T00:00:00.000Z' },
      { sort: 'placed_at', order: 'desc' },
    );
    expect(api.listOrders).toHaveBeenCalledWith(STORE, {
      placed_from: '2026-11-01T00:00:00.000Z',
      sort: 'placed_at',
      order: 'desc',
      page: 1,
      limit: 100,
    });
    const csv = result.status === 'success' ? result.data.csv : '';
    expect(csv).toContain(
      `${id(1)},1042,2026-11-10T10:00:00Z,a@example.com,confirmed,authorized,not_fulfilled,120000,JPY`,
    );
  });

  it('a store the principal cannot open is refused before any read (403)', async () => {
    const result = await exportProductsCsvAction(SEED.stores.brandC, {}, sort);
    expect(result).toMatchObject({
      status: 'error',
      refusal: {
        status: 403,
        error: { details: { relation: 'viewer', object: `store:${SEED.stores.brandC}` } },
      },
    });
    principalOf.current = 'unassigned';
    expect((await exportOrdersCsvAction(STORE, {}, sort)).status).toBe('error');
    expect(api.listProducts).not.toHaveBeenCalled();
    expect(api.listOrders).not.toHaveBeenCalled();
  });

  it('an ended session is the 401 refusal; a store id that is not a uuid never reaches the API', async () => {
    principalOf.fail = 401;
    expect(await exportProductsCsvAction(STORE, {}, sort)).toMatchObject({
      status: 'error',
      refusal: { status: 401 },
    });
    principalOf.fail = 0;
    expect((await exportProductsCsvAction('../admin', {}, sort)).status).toBe('error');
    expect(api.listProducts).not.toHaveBeenCalled();
  });

  it('a failed page is said, never a partial file', async () => {
    api.listProducts.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: 'unavailable', message: 'down' },
    });
    expect((await exportProductsCsvAction(STORE, {}, sort)).status).toBe('error');
  });
});

describe('every catalog mutation is now refused in the admin before the API (#870 audit)', () => {
  const values = { handle: 'x', title: 'X' };
  const calls = {
    createProduct: () => catalog.createProductAction(STORE, values as never),
    updateProduct: () => catalog.updateProductAction(STORE, id(1), values as never),
    createVariant: () => catalog.createVariantAction(STORE, id(1), {} as never),
    updateVariant: () => catalog.updateVariantAction(STORE, id(2), {} as never),
    createCategory: () => catalog.createCategoryAction(STORE, { name: 'x', handle: 'x' } as never),
    publishProduct: () => catalog.publishProductAction(STORE, id(1)),
    archiveProduct: () => catalog.archiveProductAction(STORE, id(1)),
  } as const;

  it.each(['finance', 'analyst', 'unassigned'] as const)(
    '%s is refused every one',
    async (role) => {
      principalOf.current = role;
      for (const [name, call] of Object.entries(calls)) {
        expect(await call(), name).toMatchObject({ status: 'error', refusal: { status: 403 } });
      }
      for (const operation of Object.keys(calls)) {
        expect(api[operation as keyof typeof api], operation).not.toHaveBeenCalled();
      }
    },
  );
});
