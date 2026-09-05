// Store API handlers for the routes window 1 owns in Phase 1 (packages/contracts/openapi/store-api.yaml):
// GET /store, GET /store/categories, GET /store/products, GET /store/products/{handle}. Plain Express handlers
// over `req.tenant` (set by storeContextMiddleware), wrapped in `handle()` so errors render as the contract
// `Error`. Mounted by src/server.ts (mountCoreMiddleware) AHEAD of Medusa: Medusa registers its own routes at these
// paths and its publishable-key gate on /store, so a Medusa file route could not be guaranteed to win — ours answer
// first. Everything else on the Store API falls through to Medusa (Prism mock for clients in Phase 1).
import type { Request, RequestHandler } from 'express';
import type { StoreComponents } from '@platform/contracts';
import {
  getStoreProduct,
  listStoreCategories,
  listStoreProducts,
  type StoreSort,
} from '../modules/catalog';
import { getStore, listCurrencies, listLocales, listSalesChannels } from '../modules/registry';
import { AppError, validationError } from '../lib/errors';
import { handle } from './errors';
import { requireTenant, type StoreContext } from './tenant';

type StoreSummary = StoreComponents['schemas']['Store'];

const SORTS: readonly StoreSort[] = ['relevance', 'price_asc', 'price_desc', 'newest'];

function one(v: unknown): string | undefined {
  if (Array.isArray(v)) return one(v[0]);
  return typeof v === 'string' ? v : undefined;
}

function intParam(
  query: Request['query'],
  name: string,
  { min, max }: { min: number; max?: number },
  problems: Record<string, string>,
): number | undefined {
  const raw = one(query[name]);
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    problems[name] = max !== undefined ? `integer between ${min} and ${max}` : `integer >= ${min}`;
    return undefined;
  }
  return n;
}

/** `GET /store` — the store resolved from the publishable key. */
export async function storeSummary(t: StoreContext): Promise<StoreSummary> {
  const [store, currencies, locales, channels] = await Promise.all([
    getStore(t.client, t.storeId),
    listCurrencies(t.client, t.storeId),
    listLocales(t.client, t.storeId),
    listSalesChannels(t.client, t.storeId),
  ]);
  const channel =
    channels.find((c) => c.id === t.salesChannelId) ??
    channels.find((c) => c.is_active && c.type === 'web') ??
    channels.find((c) => c.is_active);
  if (!channel) throw new AppError('internal', 'store has no sales channel');
  return {
    id: store.id,
    code: store.code,
    name: store.name,
    default_currency: store.default_currency,
    default_locale: store.default_locale,
    default_country: store.default_country,
    currencies: currencies.map((c) => c.currency),
    locales: locales.map((l) => l.locale),
    sales_channel: { id: channel.id, code: channel.code, type: channel.type },
    content_space_id: store.content_space_id,
    search_index: store.search_index,
    theme: store.theme,
  };
}

export const getStoreRoute: RequestHandler = handle(async (req, res) => {
  res.json(await storeSummary(requireTenant(req)));
});

export const listCategoriesRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  res.json({ items: await listStoreCategories(t.client, t.storeId) });
});

export const listProductsRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const problems: Record<string, string> = {};
  const page = intParam(req.query, 'page', { min: 1 }, problems);
  const limit = intParam(req.query, 'limit', { min: 1, max: 100 }, problems);
  const sortRaw = one(req.query.sort);
  if (sortRaw !== undefined && !SORTS.includes(sortRaw as StoreSort)) {
    problems.sort = `one of ${SORTS.join(', ')}`;
  }
  if (Object.keys(problems).length) throw validationError('invalid query', problems);
  const result = await listStoreProducts(t.client, t.storeId, t.defaultCurrency, {
    q: one(req.query.q),
    category: one(req.query.category),
    tag: one(req.query.tag),
    sort: (sortRaw as StoreSort | undefined) ?? 'relevance',
    page: page ?? 1,
    limit: limit ?? 24,
  });
  res.json(result);
});

export const getProductRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const handleParam = req.params.handle;
  if (!handleParam) throw validationError('handle is required', { handle: 'required' });
  res.json(await getStoreProduct(t.client, t.storeId, t.defaultCurrency, handleParam));
});

/** Mounts the four Store API routes (src/server.ts and the HTTP tests use the same function). */
export function mountStoreRoutes(app: {
  get(path: string, ...handlers: RequestHandler[]): unknown;
}): void {
  app.get('/store', getStoreRoute);
  app.get('/store/categories', listCategoriesRoute);
  app.get('/store/products', listProductsRoute);
  app.get('/store/products/:handle', getProductRoute);
}
