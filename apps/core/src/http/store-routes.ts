// Store API handlers for the routes window 1 owns (packages/contracts/openapi/store-api.yaml 0.3.0):
// GET /store, GET /store/categories, GET /store/products, GET /store/products/{handle} (Phase 1, `currency`
// query since 0.3.0) and the cart operations POST /store/carts, GET/PATCH /store/carts/{cartId},
// POST /store/carts/{cartId}/line-items, PATCH/DELETE /store/carts/{cartId}/line-items/{lineItemId} (task 2.1),
// GET /store/carts/{cartId}/shipping-options, POST …/payment-session, POST …/complete, GET /store/orders/{orderId}
// (task 2.2, src/modules/checkout).
// Plain Express handlers over `req.tenant` (set by storeContextMiddleware), wrapped in `handle()` so errors render
// as the contract `Error`. Mounted by src/server.ts (mountCoreMiddleware) AHEAD of Medusa: Medusa registers its
// own routes at these paths and its publishable-key gate on /store, so a Medusa file route could not be guaranteed
// to win — ours answer first. Everything else on the Store API falls through to the fallback proxy / Medusa.
import express, { type RequestHandler } from 'express';
import { verifyCustomerToken } from '@platform/auth-sdk';
import type { StoreComponents } from '@platform/contracts';
import {
  addLineItem,
  createCart,
  getCart,
  removeLineItem,
  updateCart,
  updateLineItem,
  type CreateCartInput,
  type UpdateCartInput,
} from '../modules/cart';
import {
  completeCart,
  createPaymentSession,
  customerIdForSubject,
  getStoreOrder,
  listShippingOptions,
} from '../modules/checkout';
import {
  getStoreProduct,
  listStoreCategories,
  listStoreProducts,
  type StoreSort,
} from '../modules/catalog';
import { getStore, listCurrencies, listLocales, listSalesChannels } from '../modules/registry';
import { AppError, validationError } from '../lib/errors';
import { handle } from './errors';
import { loadSpec } from './openapi';
import { intParam, one, uuidParam } from './query';
import { requireTenant, type StoreContext } from './tenant';

type StoreSummary = StoreComponents['schemas']['Store'];

const SORTS: readonly StoreSort[] = ['relevance', 'price_asc', 'price_desc', 'newest'];
const CURRENCY = /^[A-Z]{3}$/;

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

/**
 * Store API 0.3.0 `currency` query parameter: one of the store's currencies (`GET /store` lists them), default
 * the store default currency; anything else → 400 `validation_error` with `details.currency = "one of …"`.
 */
export async function resolveCurrency(
  t: StoreContext,
  raw: string | undefined,
  problems: Record<string, string>,
): Promise<string> {
  if (raw === undefined || raw === '') return t.defaultCurrency;
  if (!CURRENCY.test(raw)) {
    problems.currency = 'ISO 4217 code, e.g. EUR';
    return t.defaultCurrency;
  }
  const currencies = (await listCurrencies(t.client, t.storeId)).map((c) => c.currency);
  if (!currencies.includes(raw)) {
    problems.currency = `one of ${currencies.join(', ')}`;
    return t.defaultCurrency;
  }
  return raw;
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
  const currency = await resolveCurrency(t, one(req.query.currency), problems);
  if (Object.keys(problems).length) throw validationError('invalid query', problems);
  const result = await listStoreProducts(t.client, t.storeId, currency, {
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
  const problems: Record<string, string> = {};
  const currency = await resolveCurrency(t, one(req.query.currency), problems);
  if (Object.keys(problems).length) throw validationError('invalid query', problems);
  res.json(await getStoreProduct(t.client, t.storeId, currency, handleParam));
});

// ---- cart (task 2.1) ----

/** Request bodies are validated against the frozen store-api.yaml operation schemas (400 with per-field details). */
const body = <T>(operationId: string, raw: unknown): T => {
  loadSpec('store-api.yaml').validateBody(operationId, raw);
  return raw as T;
};

const cartScope = (t: StoreContext) => ({
  organizationId: t.organizationId,
  storeId: t.storeId,
  salesChannelId: t.salesChannelId,
});

export const createCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  // createCart's body is optional: no body (or an empty one) means all defaults.
  const raw = req.body === undefined || req.body === '' ? {} : req.body;
  const input = body<CreateCartInput>('createCart', raw);
  res.status(201).json(await createCart(t.client, cartScope(t), input));
});

export const getCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  res.json(await getCart(t.client, uuidParam(req.params, 'cartId')));
});

export const updateCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const cartId = uuidParam(req.params, 'cartId');
  const input = body<UpdateCartInput>('updateCart', req.body);
  res.json(await updateCart(t.client, cartId, input));
});

export const addLineItemRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const cartId = uuidParam(req.params, 'cartId');
  const input = body<{ variant_id: string; quantity: number }>('addLineItem', req.body);
  res.json(await addLineItem(t.client, cartId, input));
});

export const updateLineItemRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const cartId = uuidParam(req.params, 'cartId');
  const lineItemId = uuidParam(req.params, 'lineItemId');
  const input = body<{ quantity: number }>('updateLineItem', req.body);
  res.json(await updateLineItem(t.client, cartId, lineItemId, input));
});

export const removeLineItemRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const cartId = uuidParam(req.params, 'cartId');
  const lineItemId = uuidParam(req.params, 'lineItemId');
  res.json(await removeLineItem(t.client, cartId, lineItemId));
});

// ---- checkout (task 2.2) ----

export const listShippingOptionsRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  res.json({ items: await listShippingOptions(t.client, uuidParam(req.params, 'cartId')) });
});

export const createPaymentSessionRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const cartId = uuidParam(req.params, 'cartId');
  const input = body<{ provider: string }>('createPaymentSession', req.body);
  res.json(await createPaymentSession(t.client, cartId, input));
});

const IDEMPOTENCY_HEADER = 'idempotency-key';

export const completeCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const cartId = uuidParam(req.params, 'cartId');
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const idempotencyKey = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8) {
    throw validationError('Idempotency-Key header is required', {
      'Idempotency-Key': 'required, at least 8 characters',
    });
  }
  const { order } = await completeCart(t.client, { cartId, idempotencyKey, actor: t.actor });
  res.status(201).json(order);
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `GET /store/orders/{orderId}`: a customers-realm bearer token (verified against the store code of the key)
 * or the guest `?email=`. Any failure — bad token, unknown customer, wrong email, other store — is a 404 exactly
 * like the contract says (never 401/403): an order id must not be confirmable. Nothing here logs the email or
 * the query string.
 */
export const getOrderRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const orderId = uuidParam(req.params, 'orderId');
  const emailRaw = one(req.query.email);
  if (emailRaw !== undefined && !EMAIL.test(emailRaw.trim())) {
    throw validationError('invalid query', { email: 'email address' });
  }
  let customerId: string | null = null;
  const authorization = req.headers.authorization;
  if (authorization) {
    try {
      const claims = await verifyCustomerToken(authorization, t.storeCode);
      customerId = await customerIdForSubject(t.client, t.storeId, claims.subject);
    } catch {
      customerId = null; // invalid or foreign token → same 404 as no credentials
    }
  }
  res.json(await getStoreOrder(t.client, orderId, { customerId, email: emailRaw }));
});

/** The Store API paths the core answers itself (README "What is real"; the fallback proxy covers the rest). */
export const REAL_STORE_PATHS = [
  'GET /store',
  'GET /store/categories',
  'GET /store/products',
  'GET /store/products/{handle}',
  'POST /store/carts',
  'GET /store/carts/{cartId}',
  'PATCH /store/carts/{cartId}',
  'POST /store/carts/{cartId}/line-items',
  'PATCH /store/carts/{cartId}/line-items/{lineItemId}',
  'DELETE /store/carts/{cartId}/line-items/{lineItemId}',
  'GET /store/carts/{cartId}/shipping-options',
  'POST /store/carts/{cartId}/payment-session',
  'POST /store/carts/{cartId}/complete',
  'GET /store/orders/{orderId}',
] as const;

/** Mounts the Store API routes (src/server.ts and the HTTP tests use the same function). */
export function mountStoreRoutes(app: express.Express): void {
  app.get('/store', getStoreRoute);
  app.get('/store/categories', listCategoriesRoute);
  app.get('/store/products', listProductsRoute);
  app.get('/store/products/:handle', getProductRoute);
  // JSON bodies for the cart mutations. Mounted on /store only here, after the read routes: the fallback proxy
  // (mounted later) re-serialises `req.body` when the stream was consumed, so proxied requests are unaffected.
  app.use('/store/carts', express.json({ limit: '256kb' }));
  app.post('/store/carts', createCartRoute);
  app.get('/store/carts/:cartId', getCartRoute);
  app.patch('/store/carts/:cartId', updateCartRoute);
  app.post('/store/carts/:cartId/line-items', addLineItemRoute);
  app.patch('/store/carts/:cartId/line-items/:lineItemId', updateLineItemRoute);
  app.delete('/store/carts/:cartId/line-items/:lineItemId', removeLineItemRoute);
  app.get('/store/carts/:cartId/shipping-options', listShippingOptionsRoute);
  app.post('/store/carts/:cartId/payment-session', createPaymentSessionRoute);
  app.post('/store/carts/:cartId/complete', completeCartRoute);
  app.get('/store/orders/:orderId', getOrderRoute);
}
