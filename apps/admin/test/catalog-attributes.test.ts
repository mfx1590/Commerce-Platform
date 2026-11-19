/**
 * Catalog attributes (#870 wave 1 item 5, PR A): the formats the admin checks itself (the contract
 * declares none), the compare-at warning, what a variant / product is missing, SEO merging that
 * never loses a key, attributes as rows, and the server action refusing a bad canonical.
 */
/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attributeRows,
  attributesFrom,
  canonicalProblem,
  compareAtWarnings,
  COUNTRY,
  describeGaps,
  duplicateKeys,
  HS_CODE,
  mergeSeo,
  missingVariantData,
  normalizeCountry,
  normalizeHsCode,
  parseTags,
  parseWhole,
  productDataGaps,
} from '@/lib/catalog/attributes';
import { variantCreateSchema } from '@/lib/forms/schemas';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals.storeStaff,
  }),
}));
const api = vi.hoisted(() => ({
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
  createCategory: vi.fn(),
  publishProduct: vi.fn(),
  archiveProduct: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);
const { updateProductAction, updateVariantAction } = await import('@/app/actions/catalog');

const STORE = '00000000-0000-4000-8000-000000000031';
const PRODUCT = '10000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  api.updateProduct.mockResolvedValue({ ok: true, status: 200, data: { id: PRODUCT } });
  api.updateVariant.mockResolvedValue({ ok: true, status: 200, data: { id: 'v1' } });
});

describe('formats the admin checks (the contract declares none)', () => {
  it('HS code: 6, 8 or 10 digits; dots and spaces typed are stripped', () => {
    expect(normalizeHsCode('6302.60 00')).toBe('63026000');
    for (const ok of ['630260', '63026000', '6302600010']) expect(HS_CODE.test(ok)).toBe(true);
    for (const bad of ['63026', '6302600', '63026000100', '6302AB'])
      expect(HS_CODE.test(bad)).toBe(false);
  });

  it('country: ISO alpha-2, upper case', () => {
    expect(normalizeCountry(' jp ')).toBe('JP');
    expect(COUNTRY.test('JP')).toBe(true);
    expect(COUNTRY.test('JPN')).toBe(false);
  });

  it('grams and millimetres: whole numbers ≥ 0; blank is "not set", never 0', () => {
    expect(parseWhole('')).toBeNull();
    expect(parseWhole(' 120 ')).toBe(120);
    expect(parseWhole('0')).toBe(0);
    for (const bad of ['-1', '1.5', '1e3', 'ten']) expect(parseWhole(bad)).toBe('invalid');
  });

  it('the shared schema refuses the same on the server', () => {
    const base = { sku: 'S', title: 'T' };
    expect(variantCreateSchema.safeParse({ ...base, hs_code: '6302.60' }).success).toBe(false);
    expect(variantCreateSchema.safeParse({ ...base, origin_country: 'jp' }).success).toBe(false);
    expect(variantCreateSchema.safeParse({ ...base, weight_g: -5 }).success).toBe(false);
    expect(
      variantCreateSchema.safeParse({ ...base, dimensions_mm: { l: 1.5, w: 2, h: 3 } }).success,
    ).toBe(false);
    expect(
      variantCreateSchema.safeParse({
        ...base,
        hs_code: '630260',
        origin_country: 'JP',
        weight_g: 120,
        dimensions_mm: { l: 400, w: 300, h: 20 },
      }).success,
    ).toBe(true);
  });

  it('compare-at at or below the price is a warning per currency (not a block)', () => {
    expect(
      compareAtWarnings([
        { currency: 'EUR', amount_minor: 1999, compare_at_minor: 2499 },
        { currency: 'JPY', amount_minor: 1200, compare_at_minor: 1200 },
        { currency: 'GBP', amount_minor: 1500, compare_at_minor: null },
      ]),
    ).toEqual(['JPY']);
  });
});

describe('what is missing', () => {
  const complete = {
    barcode: '4006381333931',
    weight_g: 120,
    dimensions_mm: { l: 1, w: 2, h: 3 },
    hs_code: '630260',
    origin_country: 'PT',
  };

  it('per variant, in words', () => {
    expect(missingVariantData(complete)).toEqual([]);
    expect(
      missingVariantData({
        barcode: null,
        weight_g: null,
        dimensions_mm: { l: 1, w: 2 },
        hs_code: null,
        origin_country: null,
      }),
    ).toEqual(['barcode', 'weight', 'dimensions', 'HS code', 'origin']);
  });

  it('per product: counts per kind, said in one line; null when complete', () => {
    const gaps = productDataGaps([
      complete,
      { ...complete, weight_g: null },
      { ...complete, weight_g: null, hs_code: null },
    ]);
    expect(gaps).toEqual({ barcode: 0, weight: 2, dimensions: 0, 'HS code': 1, origin: 0 });
    expect(describeGaps(gaps)).toBe('2 lack weight · 1 lacks HS code');
    expect(describeGaps(productDataGaps([complete]))).toBeNull();
  });
});

describe('SEO and attributes', () => {
  it('SEO: the edited keys merged over the others, blanks removed, nothing else lost', () => {
    expect(
      mergeSeo(
        { title: 'Old', og_image: 'https://cdn/x.jpg', canonical: '/a' },
        { title: ' New ', description: '', canonical: '' },
      ),
    ).toEqual({ title: 'New', og_image: 'https://cdn/x.jpg' });
  });

  it('canonical: an https URL or a store path', () => {
    expect(canonicalProblem('')).toBeNull();
    expect(canonicalProblem('/products/towel')).toBeNull();
    expect(canonicalProblem('https://brand-a.example/products/towel')).toBeNull();
    expect(canonicalProblem('http://brand-a.example/x')).not.toBeNull();
    expect(canonicalProblem('products/towel')).not.toBeNull();
  });

  it('attributes: text and numbers become rows; anything else is kept untouched', () => {
    const { rows, kept } = attributeRows({
      material: 'linen',
      gsm: 180,
      colours: ['red'],
      organic: true,
    });
    expect(rows).toEqual([
      { key: 'material', value: 'linen' },
      { key: 'gsm', value: '180' },
    ]);
    expect(
      attributesFrom([...rows, { key: ' ', value: 'x' }, { key: 'care', value: ' 40°C ' }], kept),
    ).toEqual({
      colours: ['red'],
      organic: true,
      material: 'linen',
      gsm: '180',
      care: '40°C',
    });
    expect(
      duplicateKeys([
        { key: 'a', value: '1' },
        { key: ' a', value: '2' },
      ]),
    ).toEqual(['a']);
  });

  it('tags: trimmed, blanks and duplicates dropped', () => {
    expect(parseTags(' linen, kitchen,,linen , gift ')).toEqual(['linen', 'kitchen', 'gift']);
  });
});

describe('the server refuses what the form would', () => {
  it('a canonical that is neither https nor a path never reaches the API', async () => {
    const result = await updateProductAction(STORE, PRODUCT, {
      handle: 'towel',
      title: 'Towel',
      seo: { canonical: 'http://elsewhere.example/x' },
    });
    expect(result).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('Canonical URL'),
    });
    expect(api.updateProduct).not.toHaveBeenCalled();
  });

  it('dimensions are compacted inside: a cleared HS code is sent as null, not left out', async () => {
    await updateVariantAction(STORE, 'v1', {
      sku: 'S',
      title: 'T',
      hs_code: null,
      dimensions_mm: { l: 400, w: 300, h: 20 },
    });
    expect(api.updateVariant).toHaveBeenCalledWith(STORE, 'v1', {
      sku: 'S',
      title: 'T',
      hs_code: null,
      dimensions_mm: { l: 400, w: 300, h: 20 },
    });
  });
});
