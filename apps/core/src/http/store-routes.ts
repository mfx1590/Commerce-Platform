// Store API handlers for the routes window 1 owns (packages/contracts/openapi/store-api.yaml 0.3.0):
// GET /store, GET /store/categories, GET /store/products, GET /store/products/{handle} (Phase 1, `currency`
// query since 0.3.0) and the cart operations POST /store/carts, GET/PATCH /store/carts/{cartId},
// POST /store/carts/{cartId}/line-items, PATCH/DELETE /store/carts/{cartId}/line-items/{lineItemId} (task 2.1),
// GET /store/carts/{cartId}/shipping-options, POST …/payment-session, POST …/complete, GET /store/orders/{orderId}
// (task 2.2, src/modules/checkout), and the customer self-service routes of src/http/customer-routes.ts (#303).
// Plain Express handlers over `req.tenant` (set by storeContextMiddleware), wrapped in `handle()` so errors render
// as the contract `Error`. Mounted by src/server.ts (mountCoreMiddleware) AHEAD of Medusa: Medusa registers its
// own routes at these paths and its publishable-key gate on /store, so a Medusa file route could not be guaranteed
// to win — ours answer first. Everything else on the Store API falls through to the fallback proxy / Medusa.
import express, { type Request, type RequestHandler, type Response } from 'express';
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
import { completeCart, createPaymentSession, listShippingOptions } from '../modules/checkout';
import { findCustomerForSubject } from '../modules/customers';
import { getStoreOrder } from '../modules/orders';
import {
  getStoreProduct,
  listStoreCategories,
  listStoreProducts,
  type StoreSort,
} from '../modules/catalog';
import { getStore, listCurrencies, listLocales, listSalesChannels } from '../modules/registry';
import { AppError, notFound, validationError } from '../lib/errors';
import {
  CUSTOMER_STORE_PATHS,
  customerTokenVerifierFor,
  identityOf,
  mountCustomerRoutes,
  optionalCustomerId,
  type CustomerTokenVerifier,
} from './customer-routes';
import { coreErrorHandler, handle } from './errors';
import { loadSpec } from './openapi';
import { intParam, one, uuidParam } from './query';
import { validateRecoveryToken } from '../modules/marketing';
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

const CUSTOMER_GATE = 'customerGate';

/**
 * The gate of the two cart operations that may carry a customer token (`createCart`, `completeCart` — #310).
 * Mounted AHEAD of the JSON body parser, so the token is judged before a single byte of the body is parsed: a
 * token that is sent but does not verify is a 401 — never a 400 for malformed JSON, never a 413 for a large
 * body, never ignored. No `Authorization` header = a guest. What it decided travels in `res.locals`.
 */
export const customerGateWith = (override?: CustomerTokenVerifier): RequestHandler => {
  const verifier = customerTokenVerifierFor(override);
  return (req, res, next) => {
    Promise.resolve()
      .then(async () => {
        const customerId = await optionalCustomerId(req, requireTenant(req), verifier);
        res.locals[CUSTOMER_GATE] = { customerId };
        next();
      })
      .catch((err) => coreErrorHandler(err, req, res, next));
  };
};

/**
 * What the gate decided for this request. Fail closed: a handler reached WITHOUT the gate (mounted on its own)
 * never treats a token that was sent as if it were absent.
 */
function gatedCustomerId(req: Request, res: Response): string | null {
  const gate = res.locals[CUSTOMER_GATE] as { customerId: string | null } | undefined;
  if (gate) return gate.customerId;
  if (req.headers.authorization !== undefined) {
    throw new AppError('unauthorized', 'customer token was not verified');
  }
  return null;
}

/**
 * `POST /store/carts`. With a valid customer token the cart is created for that customer (#310); without an
 * `Authorization` header it is a guest cart. The token is judged by `customerGateWith`, ahead of the body.
 */
export const createCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const customerId = gatedCustomerId(req, res);
  // createCart's body is optional: no body (or an empty one) means all defaults.
  const raw = req.body === undefined || req.body === '' ? {} : req.body;
  const input = body<CreateCartInput>('createCart', raw);
  res.status(201).json(await createCart(t.client, { ...cartScope(t), customerId }, input));
});

export const getCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  res.json(await getCart(t.client, uuidParam(req.params, 'cartId')));
});

/**
 * `POST /store/cart-recovery/{token}` (#246, window 17's abandoned-cart recovery; Store API 0.4.0 lands with
 * contracts-v0.4.5): redeems a recovery link and answers the cart — the same `Cart` body as
 * `GET /store/carts/{cartId}`. All of the logic is window 17's `validateRecoveryToken` (one transaction: hash,
 * find, refuse expired / redeemed, stamp, reactivate the cart); this is only its HTTP surface. The token in the
 * path IS the credential: publishable-key tenant context, no customer token. POST because it is single-use and
 * mutating — a GET would be burned by link prefetchers and mail scanners. Unknown, expired and already redeemed
 * are the SAME 404 on purpose (no oracle for a guessed token); a completed cart is a 409. The token is never
 * logged: it is not a uuid, so it goes to the module as is, capped in length.
 */
export const recoverCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const token = (one(req.params.token) ?? '').slice(0, 512);
  const { cartId } = await validateRecoveryToken(t.client, t.storeId, token);
  res.json(await getCart(t.client, cartId));
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

/**
 * `POST /store/carts/{cartId}/complete`. With a valid customer token the order is placed FOR that customer
 * (#310): a guest cart is linked inside the placement transaction, a cart of another customer is a 409. The
 * token is judged by `customerGateWith` — before the body, the path, the Idempotency-Key and anything about the
 * cart. Without an `Authorization` header the cart's own link decides (a guest cart places a guest order).
 */
export const completeCartRoute: RequestHandler = handle(async (req, res) => {
  const t = requireTenant(req);
  const customerId = gatedCustomerId(req, res);
  const cartId = uuidParam(req.params, 'cartId');
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const idempotencyKey = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8) {
    throw validationError('Idempotency-Key header is required', {
      'Idempotency-Key': 'required, at least 8 characters',
    });
  }
  const { order } = await completeCart(t.client, {
    cartId,
    idempotencyKey,
    // the customer acts on their own order: the audit and event actor carry their id
    actor: customerId ? { ...t.actor, id: customerId } : t.actor,
    customerId,
  });
  res.status(201).json(order);
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /store/orders/{orderId}`: a customers-realm bearer token (verified against the store code of the key)
 * or the guest `?email=`. Any failure — bad token, unknown customer, wrong email, other store, a malformed id
 * or email — is a 404 exactly like the contract says (never 400/401/403): an order id must not be confirmable
 * and the shape of the input must not be either. Nothing here logs the email or the query string.
 *
 * What a token opens (#303): the orders placed for its customer, and — only when the token carries
 * `email_verified` — guest orders placed with the token's email. An unverified email opens nothing by itself.
 * This route never creates a customer row; a disabled or erased customer's token opens nothing.
 */
export const getOrderRouteWith = (override?: CustomerTokenVerifier): RequestHandler => {
  // Refused in production for anything but the default — here too, not only in mountStoreRoutes.
  const verifier = customerTokenVerifierFor(override);
  return handle(async (req, res) => {
    const t = requireTenant(req);
    const orderIdRaw = one(req.params.orderId) ?? '';
    if (!UUID.test(orderIdRaw)) throw notFound('order', orderIdRaw);
    const orderId = orderIdRaw;
    const emailRaw = one(req.query.email);
    if (emailRaw !== undefined && !EMAIL.test(emailRaw.trim())) throw notFound('order', orderId);
    let customerId: string | null = null;
    let verifiedEmail: string | null = null;
    const authorization = req.headers.authorization;
    if (authorization) {
      try {
        const identity = identityOf(await verifier.verify(authorization, t.storeCode));
        const customer = await findCustomerForSubject(t.client, t.storeId, identity.subject);
        if (!customer || (customer.status !== 'disabled' && customer.status !== 'erased')) {
          customerId = customer?.id ?? null;
          verifiedEmail = identity.emailVerified ? (identity.email ?? null) : null;
        }
      } catch {
        // invalid or foreign token → same 404 as no credentials
        customerId = null;
        verifiedEmail = null;
      }
    }
    res.json(
      await getStoreOrder(t.client, orderId, { customerId, email: emailRaw, verifiedEmail }),
    );
  });
};

export const getOrderRoute: RequestHandler = getOrderRouteWith();

/** The Store API paths the core answers itself (README "What is real"; the fallback proxy covers the rest). */
export const REAL_STORE_PATHS = [
  'GET /store',
  'GET /store/categories',
  'GET /store/products',
  'GET /store/products/{handle}',
  'POST /store/carts',
  'GET /store/carts/{cartId}',
  'POST /store/cart-recovery/{token}',
  'PATCH /store/carts/{cartId}',
  'POST /store/carts/{cartId}/line-items',
  'PATCH /store/carts/{cartId}/line-items/{lineItemId}',
  'DELETE /store/carts/{cartId}/line-items/{lineItemId}',
  'GET /store/carts/{cartId}/shipping-options',
  'POST /store/carts/{cartId}/payment-session',
  'POST /store/carts/{cartId}/complete',
  'GET /store/orders/{orderId}',
  ...CUSTOMER_STORE_PATHS,
] as const;

/**
 * Mounts the Store API routes (src/server.ts and the HTTP tests use the same function). `customerTokenVerifier`
 * is a test seam (src/http/customer-routes.ts): code only, refused in production, never passed by createServer().
 */
export function mountStoreRoutes(
  app: express.Express,
  customerTokenVerifier?: CustomerTokenVerifier,
): void {
  const customerVerifier = customerTokenVerifierFor(customerTokenVerifier);
  app.get('/store', getStoreRoute);
  app.get('/store/categories', listCategoriesRoute);
  app.get('/store/products', listProductsRoute);
  app.get('/store/products/:handle', getProductRoute);
  // JSON bodies for the cart mutations. Mounted on /store only here, after the read routes: the fallback proxy
  // (mounted later) re-serialises `req.body` when the stream was consumed, so proxied requests are unaffected.
  // The customer gate of createCart / completeCart sits AHEAD of the body parser: token first, then the body.
  const customerGate = customerGateWith(customerVerifier);
  app.post('/store/carts', customerGate);
  app.post('/store/carts/:cartId/complete', customerGate);
  app.use('/store/carts', express.json({ limit: '256kb' }));
  app.post('/store/carts', createCartRoute);
  app.get('/store/carts/:cartId', getCartRoute);
  app.post('/store/cart-recovery/:token', recoverCartRoute);
  app.patch('/store/carts/:cartId', updateCartRoute);
  app.post('/store/carts/:cartId/line-items', addLineItemRoute);
  app.patch('/store/carts/:cartId/line-items/:lineItemId', updateLineItemRoute);
  app.delete('/store/carts/:cartId/line-items/:lineItemId', removeLineItemRoute);
  app.get('/store/carts/:cartId/shipping-options', listShippingOptionsRoute);
  app.post('/store/carts/:cartId/payment-session', createPaymentSessionRoute);
  app.post('/store/carts/:cartId/complete', completeCartRoute);
  app.get('/store/orders/:orderId', getOrderRouteWith(customerVerifier));
  // Customer self-service (#303): POST /store/customers, GET /store/customers/me, GET …/me/orders.
  mountCustomerRoutes(app, customerVerifier);
}
