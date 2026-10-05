// Store API customer self-service (#303): POST /store/customers, GET/PATCH /store/customers/me,
// GET /store/customers/me/orders, GET/POST /store/customers/me/addresses. Publishable key (tenant context) AND a customers-realm bearer token, verified
// against the store code of the key — a token for another brand, an expired or a malformed one is a 401. The
// store comes from the key; the subject and the email come from the token, never from the request.
// Nothing here logs: no email, no token, no body.
import express, { type Request, type RequestHandler } from 'express';
import { verifyCustomerToken, type CustomerClaims } from '@platform/auth-sdk';
import { fromApiError, validationError } from '../lib/errors';
import {
  addCustomerAddress,
  listCustomerAddresses,
  registerCustomer,
  resolveCustomer,
  updateCustomer,
  type AddressInput,
  type CustomerIdentity,
  type CustomerPatch,
  type CustomerScope,
  type RegisterCustomerInput,
} from '../modules/customers';
import { listStoreOrders } from '../modules/orders';
import { handle, routeNotImplemented } from './errors';
import { loadSpec } from './openapi';
import { pageParams } from './query';
import { requireTenant, type StoreContext } from './tenant';

/** Verifies a customers-realm token and its store binding; throws auth-sdk's `ApiError(401)` otherwise. */
export interface CustomerTokenVerifier {
  verify(
    tokenOrHeader: string | undefined | null,
    expectedStoreCode: string,
  ): Promise<CustomerClaims>;
}

/** The verifier every boot uses: `@platform/auth-sdk` against the customers realm's JWKS. */
export const keycloakCustomerTokenVerifier: CustomerTokenVerifier = {
  verify: verifyCustomerToken,
};

/**
 * Test seam, guarded like the dev-token switch: another verifier can be handed to `mountStoreRoutes` /
 * `mountCoreMiddleware` by CODE only — no environment variable and no configuration reaches it,
 * `createServer()` never passes one — and it is refused outright when NODE_ENV is `production`.
 */
export function customerTokenVerifierFor(
  override: CustomerTokenVerifier | undefined,
): CustomerTokenVerifier {
  if (!override || override === keycloakCustomerTokenVerifier) return keycloakCustomerTokenVerifier;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('a customer token verifier override is never accepted in production');
  }
  return override;
}

/**
 * The identity a verified token carries. `CustomerClaims.emailVerified` (auth-sdk, #307) is true only for the
 * literal boolean `email_verified: true`; it is consumed here as `=== true` and nowhere else, so anything that
 * is not exactly that — absent, null, a string — stays false.
 */
export function identityOf(claims: CustomerClaims): CustomerIdentity {
  return {
    subject: claims.subject,
    email: claims.email,
    emailVerified: claims.emailVerified === true,
  };
}

/** 401 (the contract's `Unauthorized`) unless the request carries a valid customer token for THIS store. */
export async function requireCustomer(
  req: Request,
  t: StoreContext,
  verifier: CustomerTokenVerifier,
): Promise<CustomerIdentity> {
  try {
    return identityOf(await verifier.verify(req.headers.authorization, t.storeCode));
  } catch (err) {
    throw fromApiError(err);
  }
}

const scopeOf = (t: StoreContext): CustomerScope => ({
  organizationId: t.organizationId,
  storeId: t.storeId,
  requestId: t.requestId,
});

/**
 * For the two cart operations that MAY carry a customer token (`createCart`, `completeCart` — Store API 0.5.1,
 * #310): no `Authorization` header → null (a guest, as before). A header that IS sent must verify exactly like
 * on `/store/customers/me` — invalid, expired, malformed or another store's token is a 401, never ignored —
 * and the customer is resolved or provisioned the same way (disabled / erased → 401, collision → 409).
 */
export async function optionalCustomerId(
  req: Request,
  t: StoreContext,
  verifier: CustomerTokenVerifier,
): Promise<string | null> {
  if (req.headers.authorization === undefined) return null;
  const identity = await requireCustomer(req, t, verifier);
  return (await resolveCustomer(t.client, scopeOf(t), identity)).id;
}

/** The Store API paths this file answers (they join `REAL_STORE_PATHS`). */
export const CUSTOMER_STORE_PATHS = [
  'POST /store/customers',
  'GET /store/customers/me',
  'PATCH /store/customers/me',
  'GET /store/customers/me/orders',
  'GET /store/customers/me/addresses',
  'POST /store/customers/me/addresses',
] as const;

/**
 * Mounts the customer routes. The verifier goes through `customerTokenVerifierFor` HERE as well: every function
 * that accepts a verifier refuses a non-default one in production itself, so there is no way round the seam by
 * calling a lower-level function. Not exported from src/http/index.ts — `mountStoreRoutes` is the entry.
 */
export function mountCustomerRoutes(app: express.Express, override?: CustomerTokenVerifier): void {
  const verifier = customerTokenVerifierFor(override);
  const registerRoute: RequestHandler = handle(async (req, res) => {
    const t = requireTenant(req);
    // The token first: an unauthenticated caller learns nothing about the body rules.
    const identity = await requireCustomer(req, t, verifier);
    loadSpec('store-api.yaml').validateBody('registerCustomer', req.body);
    const { customer, created } = await registerCustomer(
      t.client,
      scopeOf(t),
      identity,
      req.body as RegisterCustomerInput,
    );
    res.status(created ? 201 : 200).json(customer);
  });

  const getMeRoute: RequestHandler = handle(async (req, res) => {
    const t = requireTenant(req);
    const identity = await requireCustomer(req, t, verifier);
    res.json(await resolveCustomer(t.client, scopeOf(t), identity));
  });

  const listMyOrdersRoute: RequestHandler = handle(async (req, res) => {
    const t = requireTenant(req);
    const identity = await requireCustomer(req, t, verifier);
    const problems: Record<string, string> = {};
    const { page, limit } = pageParams(req.query, 20, problems);
    if (Object.keys(problems).length) throw validationError('invalid query', problems);
    const me = await resolveCustomer(t.client, scopeOf(t), identity);
    res.json(
      await listStoreOrders(
        t.client,
        t.storeId,
        // The email is an identity only when the token says it is verified — and then it is the TOKEN's email.
        { customerId: me.id, verifiedEmail: identity.emailVerified ? identity.email : null },
        { page, limit },
      ),
    );
  });

  const updateMeRoute: RequestHandler = handle(async (req, res) => {
    const t = requireTenant(req);
    const identity = await requireCustomer(req, t, verifier);
    loadSpec('store-api.yaml').validateBody('updateMe', req.body);
    res.json(await updateCustomer(t.client, scopeOf(t), identity, req.body as CustomerPatch));
  });

  const listMyAddressesRoute: RequestHandler = handle(async (req, res) => {
    const t = requireTenant(req);
    const identity = await requireCustomer(req, t, verifier);
    res.json({ items: await listCustomerAddresses(t.client, scopeOf(t), identity) });
  });

  const addMyAddressRoute: RequestHandler = handle(async (req, res) => {
    const t = requireTenant(req);
    const identity = await requireCustomer(req, t, verifier);
    // Store API 0.5.1 `Address`; the optional default flags of 0.4.9 are checked by the module.
    loadSpec('store-api.yaml').validateBody('addMyAddress', req.body);
    res
      .status(201)
      .json(await addCustomerAddress(t.client, scopeOf(t), identity, req.body as AddressInput));
  });

  // The JSON body parser sits on the routes that read a body, never on the prefix: mounted there it would also
  // parse — and answer 400 for — a malformed body sent along with a GET.
  const json = express.json({ limit: '64kb' });
  app.post('/store/customers', json, registerRoute);
  app.get('/store/customers/me', getMeRoute);
  app.patch('/store/customers/me', json, updateMeRoute);
  app.get('/store/customers/me/orders', listMyOrdersRoute);
  app.get('/store/customers/me/addresses', listMyAddressesRoute);
  app.post('/store/customers/me/addresses', json, addMyAddressRoute);
  // Terminal: every operation of this prefix is answered above, so whatever is left — an unknown path, or
  // PUT / DELETE / … on a known one — is a 404 here. It must never fall through to the Store API fallback proxy
  // (non-production), which would forward the customer's bearer token to the mock.
  app.use('/store/customers', routeNotImplemented);
}
