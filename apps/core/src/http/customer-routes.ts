// Store API customer self-service (#303): POST /store/customers, GET /store/customers/me,
// GET /store/customers/me/orders. Publishable key (tenant context) AND a customers-realm bearer token, verified
// against the store code of the key — a token for another brand, an expired or a malformed one is a 401. The
// store comes from the key; the subject and the email come from the token, never from the request.
// Nothing here logs: no email, no token, no body.
import express, { type Request, type RequestHandler } from 'express';
import { verifyCustomerToken, type CustomerClaims } from '@platform/auth-sdk';
import { fromApiError, validationError } from '../lib/errors';
import {
  registerCustomer,
  resolveCustomer,
  type CustomerIdentity,
  type CustomerScope,
  type RegisterCustomerInput,
} from '../modules/customers';
import { listStoreOrders } from '../modules/orders';
import { handle } from './errors';
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
 * The identity a verified token carries. `emailVerified` is true only for an explicit `email_verified: true`
 * (auth-sdk surfaces it as `CustomerClaims.emailVerified`, #307; absent = false).
 */
export function identityOf(claims: CustomerClaims): CustomerIdentity {
  return {
    subject: claims.subject,
    email: claims.email,
    emailVerified: (claims as { emailVerified?: unknown }).emailVerified === true,
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

/** The Store API paths this file answers (they join `REAL_STORE_PATHS`). */
export const CUSTOMER_STORE_PATHS = [
  'POST /store/customers',
  'GET /store/customers/me',
  'GET /store/customers/me/orders',
] as const;

export function mountCustomerRoutes(app: express.Express, verifier: CustomerTokenVerifier): void {
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

  app.use('/store/customers', express.json({ limit: '64kb' }));
  app.post('/store/customers', registerRoute);
  app.get('/store/customers/me', getMeRoute);
  app.get('/store/customers/me/orders', listMyOrdersRoute);
}
