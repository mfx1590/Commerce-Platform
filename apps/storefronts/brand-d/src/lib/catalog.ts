import { cache } from 'react';
import {
  cacheTags,
  storeApi,
  type Category,
  type ListProductsQuery,
  type Product,
  type ProductPage,
} from './store-api';

/**
 * Catalog reads. Every call is tagged, so a webhook can revalidate exactly what changed
 * (`revalidateTag('product:classic-tee')`) instead of dropping the whole cache, and `cache()`
 * dedupes a page and its layout asking for the same thing in one render.
 */

/** Catalog data changes rarely and is not personalised; a minute of staleness is invisible. */
const CATALOG_REVALIDATE = 60;

export const SORT_OPTIONS = ['relevance', 'price_asc', 'price_desc', 'newest'] as const;
export type Sort = (typeof SORT_OPTIONS)[number];

export const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

export interface ListParams {
  page: number;
  limit: number;
  sort: Sort;
  category?: string;
  q?: string;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function isSort(value: string | undefined): value is Sort {
  return value !== undefined && (SORT_OPTIONS as readonly string[]).includes(value);
}

/**
 * Narrow untrusted query strings to the values the contract allows. Anything unparseable falls back
 * to the default rather than reaching the API, so a hand-edited URL cannot produce a 400.
 */
export function parseListParams(searchParams: RawSearchParams): ListParams {
  const sort = first(searchParams.sort);
  const params: ListParams = {
    page: positiveInt(first(searchParams.page), 1, 10_000),
    limit: positiveInt(first(searchParams.limit), DEFAULT_LIMIT, MAX_LIMIT),
    sort: isSort(sort) ? sort : 'relevance',
  };
  const category = first(searchParams.category);
  if (category !== undefined) params.category = category;
  const q = first(searchParams.q);
  if (q !== undefined) params.q = q;
  return params;
}

/** Every field optional *and* explicitly clearable — `{ category: undefined }` removes the filter. */
export type ListHrefParams = { [K in keyof ListParams]?: ListParams[K] | undefined };

/** Rebuild the PLP query string, dropping defaults so canonical URLs stay clean. */
export function listHref(basePath: string, params: ListHrefParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.category) search.set('category', params.category);
  if (params.sort && params.sort !== 'relevance') search.set('sort', params.sort);
  if (params.limit && params.limit !== DEFAULT_LIMIT) search.set('limit', String(params.limit));
  if (params.page && params.page > 1) search.set('page', String(params.page));
  const query = search.toString();
  return query === '' ? basePath : `${basePath}?${query}`;
}

/**
 * `currency` (Store API 0.3.0) is the customer's chosen currency, already reconciled against
 * `store.currencies` by `resolveCurrency` — the core answers 400 `validation_error` for one the
 * store does not sell in. It is part of the URL, so each currency caches separately at the fetch
 * layer instead of one price list poisoning the other; omitted, the core prices in the store
 * default, which is what an unpriced context (a sitemap, a build with no cookie) wants.
 */
export const listProducts = cache(
  async (params: ListParams, currency?: string): Promise<ProductPage> => {
    const query: ListProductsQuery = { page: params.page, limit: params.limit, sort: params.sort };
    if (params.category !== undefined) query.category = params.category;
    if (params.q !== undefined) query.q = params.q;
    if (currency !== undefined) query.currency = currency;

    return storeApi().listProducts(query, {
      tags: [cacheTags.products],
      revalidate: CATALOG_REVALIDATE,
    });
  },
);

export const listCategories = cache(async (): Promise<Category[]> => {
  const { items } = await storeApi().listCategories({
    tags: [cacheTags.categories],
    revalidate: CATALOG_REVALIDATE,
  });
  return items;
});

export const getProduct = cache(async (handle: string, currency?: string): Promise<Product> =>
  storeApi().getProduct(handle, currency === undefined ? undefined : { currency }, {
    tags: [cacheTags.products, cacheTags.product(handle)],
    revalidate: CATALOG_REVALIDATE,
  }),
);

/** The categories tree is returned flat; the PLP filter needs parents with their children. */
export interface CategoryNode extends Category {
  children: CategoryNode[];
}

export function buildCategoryTree(categories: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const category of categories) nodes.set(category.id, { ...category, children: [] });

  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byPosition = (a: CategoryNode, b: CategoryNode) => a.position - b.position;
  for (const node of nodes.values()) node.children.sort(byPosition);
  return roots.sort(byPosition);
}

export function totalPages(page: ProductPage): number {
  return Math.max(1, Math.ceil(page.total / Math.max(1, page.limit)));
}
