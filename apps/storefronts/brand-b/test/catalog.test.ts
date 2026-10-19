import { describe, expect, it } from 'vitest';
import type { Category, ProductPage } from '@/lib/store-api';
import {
  buildCategoryTree,
  DEFAULT_LIMIT,
  listHref,
  parseListParams,
  totalPages,
} from '@/lib/catalog';
import { pageNumbers } from '@/components/pagination';

describe('parseListParams', () => {
  it('applies the contract defaults for an empty query', () => {
    expect(parseListParams({})).toEqual({ page: 1, limit: DEFAULT_LIMIT, sort: 'relevance' });
  });

  it('reads page, limit, sort, category and q', () => {
    expect(
      parseListParams({
        page: '3',
        limit: '12',
        sort: 'price_asc',
        category: 't-shirts',
        q: 'tee',
      }),
    ).toEqual({ page: 3, limit: 12, sort: 'price_asc', category: 't-shirts', q: 'tee' });
  });

  it('falls back rather than passing junk to the API', () => {
    expect(parseListParams({ page: 'abc', limit: '-4', sort: 'cheapest' })).toEqual({
      page: 1,
      limit: DEFAULT_LIMIT,
      sort: 'relevance',
    });
  });

  it('caps limit at the contract maximum', () => {
    expect(parseListParams({ limit: '1000' }).limit).toBe(100);
  });

  it('takes the first value of a repeated parameter and ignores blanks', () => {
    expect(parseListParams({ sort: ['newest', 'price_asc'] }).sort).toBe('newest');
    expect(parseListParams({ q: '   ' }).q).toBeUndefined();
    expect(parseListParams({ category: '' }).category).toBeUndefined();
  });
});

describe('listHref', () => {
  it('omits defaults so the canonical URL stays clean', () => {
    expect(listHref('/products', { page: 1, limit: DEFAULT_LIMIT, sort: 'relevance' })).toBe(
      '/products',
    );
  });

  it('keeps the parameters that differ from the defaults', () => {
    expect(
      listHref('/products', { page: 2, limit: DEFAULT_LIMIT, sort: 'price_desc', q: 'tee' }),
    ).toBe('/products?q=tee&sort=price_desc&page=2');
  });

  it('clears a filter when it is explicitly undefined', () => {
    expect(
      listHref('/products', {
        page: 1,
        limit: DEFAULT_LIMIT,
        sort: 'relevance',
        category: undefined,
      }),
    ).toBe('/products');
  });
});

describe('buildCategoryTree', () => {
  const categories: Category[] = [
    { id: 'c2', handle: 't-shirts', name: 'T-shirts', parent_id: 'c1', position: 1 },
    { id: 'c1', handle: 'tops', name: 'Tops', parent_id: null, position: 0 },
    { id: 'c3', handle: 'shirts', name: 'Shirts', parent_id: 'c1', position: 0 },
    { id: 'c4', handle: 'shoes', name: 'Shoes', parent_id: null, position: 1 },
  ];

  it('nests children under their parent and sorts by position', () => {
    const tree = buildCategoryTree(categories);
    expect(tree.map((node) => node.handle)).toEqual(['tops', 'shoes']);
    expect(tree[0]?.children.map((node) => node.handle)).toEqual(['shirts', 't-shirts']);
    expect(tree[1]?.children).toEqual([]);
  });

  it('treats a child whose parent is missing as a root rather than dropping it', () => {
    const orphan: Category[] = [
      { id: 'c9', handle: 'sale', name: 'Sale', parent_id: 'gone', position: 0 },
    ];
    expect(buildCategoryTree(orphan).map((node) => node.handle)).toEqual(['sale']);
  });
});

describe('totalPages', () => {
  const page = (total: number, limit: number): ProductPage =>
    ({ page: 1, limit, total, items: [] }) as ProductPage;

  it('rounds up and never returns zero', () => {
    expect(totalPages(page(200, 24))).toBe(9);
    expect(totalPages(page(24, 24))).toBe(1);
    expect(totalPages(page(0, 24))).toBe(1);
  });
});

describe('pageNumbers', () => {
  it('always shows the first and last page', () => {
    expect(pageNumbers(1, 9)).toEqual([1, 2, 3, 'gap', 9]);
    expect(pageNumbers(9, 9)).toEqual([1, 'gap', 7, 8, 9]);
  });

  it('windows around the current page', () => {
    expect(pageNumbers(5, 9)).toEqual([1, 'gap', 3, 4, 5, 6, 7, 'gap', 9]);
  });

  it('lists every page when there are few', () => {
    expect(pageNumbers(2, 3)).toEqual([1, 2, 3]);
  });
});
