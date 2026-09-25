import { describe, expect, it, vi } from 'vitest';
import type { AdminComponents } from '@/lib/api/admin-client';
import { acceptedPrices, csvSummary, parsePriceCsv, type CsvResolution } from '@/lib/pricing/csv';
import { changedPrices, csvResolution, editorRows } from '@/lib/pricing/editor';

const upsertPrices = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/api/admin', () => ({ upsertPrices, createPriceList: vi.fn() }));
const { upsertPricesAction } = await import('@/app/actions/pricing');

type Product = AdminComponents['Product'];

const LIST = '50000000-0000-4000-8000-000000000002';
const OTHER_LIST = '50000000-0000-4000-8000-000000000001';
const TEE_M = '30000000-0000-4000-8000-00000000face';
const TEE_L = '30000000-0000-4000-8000-00000000fade';

const product: Product = {
  id: '30000000-0000-4000-8000-000000000201',
  handle: 'classic-tee',
  title: 'Classic Tee',
  subtitle: null,
  description: null,
  status: 'published',
  category_id: null,
  brand_name: null,
  tags: [],
  attributes: {},
  seo: {},
  thumbnail_url: null,
  options: [],
  media: [],
  published_at: null,
  created_at: '2026-09-04T00:00:00Z',
  updated_at: '2026-09-04T00:00:00Z',
  variants: [
    {
      id: TEE_M,
      product_id: '30000000-0000-4000-8000-000000000201',
      sku: 'TEE-M-RED',
      barcode: null,
      title: 'M / Red',
      options: {},
      manage_inventory: true,
      allow_backorder: false,
      weight_g: null,
      dimensions_mm: null,
      hs_code: null,
      origin_country: null,
      position: 0,
      prices: [
        {
          price_list_id: OTHER_LIST,
          currency: 'EUR',
          amount_minor: 1999,
          compare_at_minor: null,
          min_quantity: 1,
        },
        {
          price_list_id: LIST,
          currency: 'EUR',
          amount_minor: 1499,
          compare_at_minor: 1999,
          min_quantity: 1,
        },
      ],
      inventory: [],
    },
    {
      id: TEE_L,
      product_id: '30000000-0000-4000-8000-000000000201',
      sku: 'TEE-L-RED',
      barcode: null,
      title: 'L / Red',
      options: {},
      manage_inventory: true,
      allow_backorder: false,
      weight_g: null,
      dimensions_mm: null,
      hs_code: null,
      origin_country: null,
      position: 1,
      prices: [],
      inventory: [],
    },
  ],
};

const rows = editorRows([product], LIST);
const resolution: CsvResolution = csvResolution(rows, 'EUR');

describe('editor rows and the diff that becomes the upsert', () => {
  it('reads the price this list holds per variant, from the variant prices by list id', () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sku: 'TEE-M-RED',
      label: 'Classic Tee · M / Red',
      current: { amount_minor: 1499, compare_at_minor: 1999, min_quantity: 1 },
    });
    expect(rows[1]?.current).toBeNull();
  });

  it('sends only rows whose values changed; an untouched or identical edit is not re-sent', () => {
    expect(changedPrices(rows, {})).toEqual([]);
    expect(
      changedPrices(rows, {
        [TEE_M]: { amount_minor: 1499, compare_at_minor: 1999, min_quantity: 1 },
      }),
    ).toEqual([]);
    expect(
      changedPrices(rows, {
        [TEE_M]: { amount_minor: 1299, compare_at_minor: 1999, min_quantity: 1 },
        [TEE_L]: { amount_minor: null, compare_at_minor: null, min_quantity: 1 },
      }),
    ).toEqual([{ variant_id: TEE_M, amount_minor: 1299, compare_at_minor: 1999, min_quantity: 1 }]);
    expect(
      changedPrices(rows, {
        [TEE_L]: { amount_minor: 2499, compare_at_minor: null, min_quantity: 2 },
      }),
    ).toEqual([{ variant_id: TEE_L, amount_minor: 2499, compare_at_minor: null, min_quantity: 2 }]);
  });
});

describe('CSV import: parse, preview, and reject what must not be sent', () => {
  it('parses a header row, SKUs and variant ids, amounts as integer minor units', () => {
    const parsed = parsePriceCsv(
      [
        'sku,amount,compare_at,min_quantity',
        'TEE-M-RED,19.99,24.99,1',
        `${TEE_L},12,,3`,
        '',
        '# a comment',
      ].join('\n'),
      resolution,
    );
    expect(csvSummary(parsed)).toEqual({ ok: 2, errors: 0 });
    expect(acceptedPrices(parsed)).toEqual([
      { variant_id: TEE_M, amount_minor: 1999, compare_at_minor: 2499, min_quantity: 1 },
      { variant_id: TEE_L, amount_minor: 1200, compare_at_minor: null, min_quantity: 3 },
    ]);
  });

  it('rejects rows with non-integer minor amounts — three decimals in EUR, any decimal in JPY, words', () => {
    const eur = parsePriceCsv(
      'TEE-M-RED,12.345\nTEE-L-RED,abc\nTEE-M-RED,-5\nTEE-L-RED,',
      resolution,
    );
    expect(eur.map((row) => row.verdict)).toEqual(['error', 'error', 'error', 'error']);
    expect(eur[0]).toMatchObject({
      line: 1,
      message: 'amount: not a whole number of minor units for EUR',
    });
    expect(eur[1]).toMatchObject({ message: 'amount: not a number' });
    expect(eur[3]).toMatchObject({ message: 'amount: empty' });

    const jpy = parsePriceCsv('TEE-M-RED,1200.5\nTEE-L-RED,1200', {
      ...resolution,
      currency: 'JPY',
    });
    expect(jpy[0]?.verdict).toBe('error');
    expect(jpy[1]).toMatchObject({ verdict: 'ok', price: { amount_minor: 1200 } });
  });

  it('rejects unknown SKUs, a compare-at below the amount, and a bad min quantity — each named', () => {
    const parsed = parsePriceCsv(
      'NOPE-1,10\nTEE-M-RED,20,15\nTEE-M-RED,20,,0\nTEE-M-RED,20,,x',
      resolution,
    );
    expect(parsed.map((row) => (row.verdict === 'error' ? row.message : 'ok'))).toEqual([
      'Unknown SKU or variant: NOPE-1',
      'compare_at is below the amount',
      'min_quantity: a whole number ≥ 1',
      'min_quantity: a whole number ≥ 1',
    ]);
    expect(acceptedPrices(parsed)).toEqual([]);
  });

  it('accepted rows are exactly the ok ones, in file order', () => {
    const parsed = parsePriceCsv('TEE-L-RED,10\nBAD,1\nTEE-M-RED,20', resolution);
    expect(csvSummary(parsed)).toEqual({ ok: 2, errors: 1 });
    expect(acceptedPrices(parsed).map((price) => price.variant_id)).toEqual([TEE_L, TEE_M]);
  });
});

describe('the server action re-validates the batch — a rejected row can never reach the API', () => {
  const STORE = '00000000-0000-4000-8000-000000000031';

  it('sends a valid batch as is', async () => {
    upsertPrices.mockResolvedValueOnce({ ok: true, status: 200, data: { upserted: 1 } });
    const result = await upsertPricesAction(STORE, LIST, [
      { variant_id: TEE_M, amount_minor: 1299, compare_at_minor: null, min_quantity: 1 },
    ]);
    expect(result).toEqual({ status: 'success', data: { upserted: 1 } });
    // `null` compare-at is meaningful ("no compare-at price") and travels; only undefined is dropped.
    expect(upsertPrices).toHaveBeenCalledWith(STORE, LIST, [
      { variant_id: TEE_M, amount_minor: 1299, compare_at_minor: null, min_quantity: 1 },
    ]);
  });

  it.each([
    [
      'a non-integer amount',
      [{ variant_id: TEE_M, amount_minor: 12.5, compare_at_minor: null, min_quantity: 1 }],
    ],
    [
      'a negative amount',
      [{ variant_id: TEE_M, amount_minor: -1, compare_at_minor: null, min_quantity: 1 }],
    ],
    [
      'a string amount',
      [{ variant_id: TEE_M, amount_minor: '1299', compare_at_minor: null, min_quantity: 1 }],
    ],
    [
      'a non-uuid variant',
      [{ variant_id: 'TEE-M-RED', amount_minor: 1299, compare_at_minor: null, min_quantity: 1 }],
    ],
    [
      'a zero min quantity',
      [{ variant_id: TEE_M, amount_minor: 1299, compare_at_minor: null, min_quantity: 0 }],
    ],
    [
      'one bad row among good ones',
      [
        { variant_id: TEE_M, amount_minor: 1299, min_quantity: 1 },
        { variant_id: TEE_L, amount_minor: 9.99, min_quantity: 1 },
      ],
    ],
    ['an empty batch', []],
    ['not even an array', { variant_id: TEE_M, amount_minor: 1299 }],
  ])('refuses the whole batch with %s, and the API is never called', async (_label, batch) => {
    upsertPrices.mockClear();
    const result = await upsertPricesAction(STORE, LIST, batch);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected a refusal');
    expect(result.formError).toMatch(/Nothing was saved|Nothing to save/);
    expect(upsertPrices).not.toHaveBeenCalled();
  });

  it('names the offending row so the operator can find it', async () => {
    const result = await upsertPricesAction(STORE, LIST, [
      { variant_id: TEE_M, amount_minor: 1299, min_quantity: 1 },
      { variant_id: TEE_L, amount_minor: 9.99, min_quantity: 1 },
    ]);
    if (result.status !== 'error') throw new Error('expected a refusal');
    expect(result.formError).toContain('(row 2)');
  });
});
