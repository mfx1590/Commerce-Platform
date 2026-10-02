// Store API customer self-service (#303) through the exact chain src/server.ts mounts: publishable key → tenant
// context → customer token → the customers module. The customers-realm verifier is replaced through the code-only
// test seam (`customerTokenVerifier`); the last describe runs the REAL verifier against docker Keycloak and skips
// itself when it is not reachable. Responses are validated against store-api.yaml. Tokens here are words.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { ApiError, verifyCustomerToken, type CustomerClaims } from '@platform/auth-sdk';
import { createOrganizationClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_STORE_PATHS,
  customerTokenVerifierFor,
  DevTokenVerifier,
  keycloakCustomerTokenVerifier,
  mountStoreRoutes,
  REAL_STORE_PATHS,
  type CustomerTokenVerifier,
} from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const KEY_A = SEED_IDS.publishableKeys.brandA;
const KEY_B = SEED_IDS.publishableKeys.brandB;
const A = SEED_IDS.stores.brandA;
const ORG = SEED_IDS.organization;
const spec = specValidator('store-api.yaml');

interface Persona {
  subject: string;
  storeCode: string;
  email?: string;
  emailVerified?: boolean;
}

/** token word → what the fake verifier answers. `emailVerified` absent = the claim is absent (= false). */
const PERSONAS: Record<string, Persona> = {
  jane: { subject: 'sub-jane', storeCode: 'brand-a', email: 'jane@example.test' },
  vera: {
    subject: 'sub-vera',
    storeCode: 'brand-a',
    email: 'vera@example.test',
    emailVerified: true,
  },
  ursula: { subject: 'sub-ursula', storeCode: 'brand-a', email: 'ursula@example.test' },
  mallory: {
    subject: 'sub-mallory',
    storeCode: 'brand-a',
    email: 'guest.buyer@example.test',
  },
  rita: {
    subject: 'sub-rita',
    storeCode: 'brand-a',
    email: 'guest.buyer@example.test',
    emailVerified: true,
  },
  bob: { subject: 'sub-bob', storeCode: 'brand-b', email: 'bob@example.test' },
  nomail: { subject: 'sub-nomail', storeCode: 'brand-a' },
  blocked: { subject: 'sub-blocked', storeCode: 'brand-a', email: 'blocked@example.test' },
};

const fakeVerifier: CustomerTokenVerifier = {
  async verify(header, expectedStoreCode) {
    const persona = PERSONAS[(header ?? '').replace(/^Bearer\s+/i, '')];
    if (!persona) throw new ApiError(401, 'unauthorized', 'Invalid bearer token');
    if (persona.storeCode !== expectedStoreCode) {
      throw new ApiError(401, 'unauthorized', 'Token is bound to another store', {
        reason: 'store_mismatch',
      });
    }
    return {
      subject: persona.subject,
      storeCode: persona.storeCode,
      ...(persona.email ? { email: persona.email } : {}),
      ...(persona.emailVerified === undefined ? {} : { emailVerified: persona.emailVerified }),
      issuer: 'test',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    } as CustomerClaims;
  },
};

let db: TestDatabase;
let app: express.Express;
let owner: ReturnType<typeof createOrganizationClient>;

const as = (
  token: string | null,
  method: 'get' | 'post' | 'patch',
  path: string,
  key: string = KEY_A,
) => {
  const req = request(app)[method](path).set('X-Publishable-Key', key);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
const guest = (method: 'get' | 'post' | 'patch', path: string) => as(null, method, path);

const address = {
  first_name: 'Guest',
  last_name: 'Buyer',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

/** Places a guest order in brand-a with the given checkout email (the Store API has no customer on carts yet). */
async function placeGuestOrder(email: string): Promise<string> {
  const cart = (await guest('post', '/store/carts').send({})).body;
  const list = await guest('get', '/store/products?limit=3&sort=price_asc');
  let variant: { id: string } | undefined;
  for (const item of list.body.items as Array<{ handle: string }>) {
    const product = await guest('get', `/store/products/${item.handle}`);
    variant = product.body.variants.find((v: { in_stock: boolean }) => v.in_stock);
    if (variant) break;
  }
  if (!variant) throw new Error('the seed has no variant in stock');
  await guest('post', `/store/carts/${cart.id}/line-items`).send({
    variant_id: variant.id,
    quantity: 1,
  });
  const options = await guest('get', `/store/carts/${cart.id}/shipping-options`);
  await guest('patch', `/store/carts/${cart.id}`).send({
    email,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: options.body.items[0].id,
  });
  await guest('post', `/store/carts/${cart.id}/payment-session`).send({ provider: 'manual' });
  const placed = await guest('post', `/store/carts/${cart.id}/complete`)
    .set('Idempotency-Key', `idem-customers-${cart.id}`)
    .send();
  expect(placed.status).toBe(201);
  return placed.body.id as string;
}

const customerCount = async () =>
  Number((await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM customer`)).rows[0]!.n);

beforeAll(async () => {
  db = await createTestDatabase('core_customers_api');
  await seed(db.owner, { productsPerStore: 3, log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), { customerTokenVerifier: fakeVerifier });
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('authentication: publishable key AND a customer token for this store', () => {
  const routes: Array<['get' | 'post', string]> = [
    ['post', '/store/customers'],
    ['get', '/store/customers/me'],
    ['get', '/store/customers/me/orders'],
  ];

  it("no key → 401 before anything else; no token, an unknown token, another store's token → 401, and nothing is created", async () => {
    const before = await customerCount();
    for (const [method, path] of routes) {
      const noKey = await request(app)[method](path).set('Authorization', 'Bearer jane');
      expect(noKey.status).toBe(401);
      for (const token of [null, 'nobody', 'bob']) {
        const res = await as(token, method, path).send(
          method === 'post' ? { email: 'jane@example.test' } : undefined,
        );
        expect(res.status).toBe(401);
        spec.assertSchema('Error', res.body);
        expect(res.body.code).toBe('unauthorized');
      }
    }
    // bob's token is valid for brand-b — and only there
    const bob = await as('bob', 'get', '/store/customers/me', KEY_B);
    expect(bob.status).toBe(200);
    expect(await customerCount()).toBe(before + 1);
  });

  it('an unauthenticated caller learns nothing about the body rules (401, not 400)', async () => {
    const res = await guest('post', '/store/customers').send({ nonsense: true });
    expect(res.status).toBe(401);
  });

  it('a disabled customer is a 401 on every route; a token without an email cannot create a customer', async () => {
    await owner.query(
      `INSERT INTO customer (organization_id, store_id, keycloak_subject, email, status)
       VALUES ($1, $2, 'sub-blocked', 'blocked@example.test', 'disabled')`,
      [ORG, A],
    );
    const before = await customerCount();
    for (const [method, path] of routes) {
      const res = await as('blocked', method, path).send(
        method === 'post' ? { email: 'blocked@example.test' } : undefined,
      );
      expect(res.status).toBe(401);
      spec.assertSchema('Error', res.body);
    }
    const nomail = await as('nomail', 'get', '/store/customers/me');
    expect(nomail.status).toBe(401);
    expect(nomail.body.details).toEqual({ reason: 'no_email' });
    expect(await customerCount()).toBe(before);
  });
});

describe('GET /store/customers/me and POST /store/customers', () => {
  it('getMe creates the customer on first use — there is no 404 — and answers the same customer afterwards', async () => {
    const first = await as('jane', 'get', '/store/customers/me');
    expect(first.status).toBe(200);
    spec.assertSchema('Customer', first.body);
    expect(first.body).toMatchObject({
      email: 'jane@example.test',
      first_name: null,
      status: 'registered',
      marketing_consent: false,
    });
    const again = await as('jane', 'get', '/store/customers/me');
    expect(again.body).toEqual(first.body);
  });

  it('registerCustomer: 200 when the row already existed (names and consent applied), 201 when this call created it', async () => {
    const existing = await as('jane', 'post', '/store/customers').send({
      email: 'Jane@Example.test',
      first_name: 'Jane',
      last_name: 'Doe',
      marketing_consent: true,
    });
    expect(existing.status).toBe(200);
    spec.assertSchema('Customer', existing.body);
    expect(existing.body).toMatchObject({
      first_name: 'Jane',
      last_name: 'Doe',
      marketing_consent: true,
    });
    expect((await as('jane', 'get', '/store/customers/me')).body).toEqual(existing.body);

    const created = await as('ursula', 'post', '/store/customers').send({
      email: 'ursula@example.test',
      first_name: 'Ursula',
    });
    expect(created.status).toBe(201);
    spec.assertSchema('Customer', created.body);
    expect(created.body).toMatchObject({
      email: 'ursula@example.test',
      first_name: 'Ursula',
      last_name: null,
      marketing_consent: false,
    });
  });

  it('400: a body email that is not the token email, a missing email, a wrong type — nothing written', async () => {
    const before = await customerCount();
    const other = await as('vera', 'post', '/store/customers').send({
      email: 'someone.else@example.test',
    });
    expect(other.status).toBe(400);
    spec.assertSchema('Error', other.body);
    expect(other.body).toMatchObject({
      code: 'validation_error',
      details: { email: 'must equal the email of the customer token' },
    });
    const missing = await as('vera', 'post', '/store/customers').send({ first_name: 'Vera' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('validation_error');
    const wrongType = await as('vera', 'post', '/store/customers').send({
      email: 'vera@example.test',
      marketing_consent: 'yes',
    });
    expect(wrongType.status).toBe(400);
    expect(await customerCount()).toBe(before);
  });

  it('409 conflict when the token email is on a row that cannot be adopted; a verified email adopts a guest row', async () => {
    const guestRow = await owner.query<{ id: string }>(
      `INSERT INTO customer (organization_id, store_id, email, status)
       VALUES ($1, $2, 'guest.buyer@example.test', 'guest') RETURNING id`,
      [ORG, A],
    );
    const before = await customerCount();
    // mallory signed up at Keycloak with that address but never verified it
    for (const res of [
      await as('mallory', 'get', '/store/customers/me'),
      await as('mallory', 'get', '/store/customers/me/orders'),
      await as('mallory', 'post', '/store/customers').send({ email: 'guest.buyer@example.test' }),
    ]) {
      expect(res.status).toBe(409);
      spec.assertSchema('Error', res.body);
      expect(res.body).toEqual({
        code: 'conflict',
        message: 'This email already has an account',
        details: {},
      });
    }
    expect(await customerCount()).toBe(before);

    const rita = await as('rita', 'get', '/store/customers/me');
    expect(rita.status).toBe(200);
    expect(rita.body).toMatchObject({ id: guestRow.rows[0]!.id, status: 'registered' });
    expect(await customerCount()).toBe(before);
    // the row now belongs to rita's identity: mallory stays refused
    expect((await as('mallory', 'get', '/store/customers/me')).status).toBe(409);
  });
});

describe('orders of the signed-in customer: an email is an identity only when the token says it is verified', () => {
  let veraGuestOrder: string;
  let janeGuestOrder: string;
  let veraLinkedOrder: string;

  beforeAll(async () => {
    veraGuestOrder = await placeGuestOrder('Vera@Example.test');
    janeGuestOrder = await placeGuestOrder('jane@example.test');
    // An order placed FOR vera's customer row (what PR C's placement link produces) whose checkout email is
    // rita's verified address: the link decides, the email does not.
    veraLinkedOrder = await placeGuestOrder('guest.buyer@example.test');
    const vera = await as('vera', 'get', '/store/customers/me');
    await owner.query(`UPDATE "order" SET customer_id = $2 WHERE id = $1`, [
      veraLinkedOrder,
      vera.body.id,
    ]);
  }, 120_000);

  it('listMyOrders: verified email → guest orders with that email plus the linked ones, newest first, paginated', async () => {
    const res = await as('vera', 'get', '/store/customers/me/orders');
    expect(res.status).toBe(200);
    spec.assertPage('OrderSummary', res.body);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([
      veraLinkedOrder,
      veraGuestOrder,
    ]);
    const second = await as('vera', 'get', '/store/customers/me/orders?page=2&limit=1');
    expect(second.body).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect(second.body.items.map((o: { id: string }) => o.id)).toEqual([veraGuestOrder]);
    const bad = await as('vera', 'get', '/store/customers/me/orders?limit=0');
    expect(bad.status).toBe(400);
    expect(bad.body.details).toEqual({ limit: 'integer between 1 and 100' });
  });

  it("listMyOrders: an UNVERIFIED email matches nothing — the guest order with jane's email is not hers to list", async () => {
    const res = await as('jane', 'get', '/store/customers/me/orders');
    expect(res.status).toBe(200);
    spec.assertPage('OrderSummary', res.body);
    expect(res.body).toMatchObject({ total: 0, items: [] });
  });

  it('getOrder: the same guard — token alone opens the order only for a verified email or a linked order; ?email= still works for guests', async () => {
    const path = (id: string) => `/store/orders/${id}`;
    expect((await as('vera', 'get', path(veraGuestOrder))).status).toBe(200);
    expect((await as('vera', 'get', path(veraLinkedOrder))).status).toBe(200);
    expect((await as('vera', 'get', path(janeGuestOrder))).status).toBe(404);

    // jane's token is not verified: her own address on a guest order opens nothing by itself …
    const unverified = await as('jane', 'get', path(janeGuestOrder));
    expect(unverified.status).toBe(404);
    spec.assertSchema('Error', unverified.body);
    // … but knowing the order id and the checkout email is the guest rule, token or not
    const byEmail = await as('jane', 'get', `${path(janeGuestOrder)}?email=jane%40example.test`);
    expect(byEmail.status).toBe(200);
    spec.assertSchema('Order', byEmail.body);

    // an order linked to a customer is not opened — or listed — by someone else's verified token, even when
    // the checkout email on it is theirs
    expect((await as('rita', 'get', path(veraLinkedOrder))).status).toBe(404);
    expect((await as('rita', 'get', '/store/customers/me/orders')).body).toMatchObject({
      total: 0,
      items: [],
    });
    // a disabled customer's token opens nothing; a bad token is the same 404 as no credentials
    expect((await as('blocked', 'get', path(veraGuestOrder))).status).toBe(404);
    expect((await as('nobody', 'get', path(veraGuestOrder))).status).toBe(404);
  });

  it('getOrder never creates a customer row', async () => {
    const before = await customerCount();
    PERSONAS.walkin = { subject: 'sub-walkin', storeCode: 'brand-a', email: 'walkin@example.test' };
    expect((await as('walkin', 'get', `/store/orders/${veraGuestOrder}`)).status).toBe(404);
    expect(await customerCount()).toBe(before);
  });
});

describe('nothing personal is logged', () => {
  it('no log line carries an email, a token or a name across every customer route, errors included', async () => {
    const logged: string[] = [];
    const spies = (['info', 'warn', 'error', 'log', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    try {
      await as('jane', 'get', '/store/customers/me');
      await as('jane', 'post', '/store/customers').send({
        email: 'jane@example.test',
        first_name: 'Janet',
      });
      await as('jane', 'post', '/store/customers').send({ email: 'wrong@example.test' });
      await as('mallory', 'get', '/store/customers/me');
      await as('nobody', 'get', '/store/customers/me');
      await as('vera', 'get', '/store/customers/me/orders');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = logged.join('\n').toLowerCase();
    for (const secret of ['@example.test', 'janet', 'bearer', 'sub-jane', 'mallory']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('the core answers these paths itself', () => {
  it('REAL_STORE_PATHS lists them, and the fallback proxy never sees them', async () => {
    expect(REAL_STORE_PATHS).toEqual(expect.arrayContaining([...CUSTOMER_STORE_PATHS]));
    expect([...CUSTOMER_STORE_PATHS]).toEqual([
      'POST /store/customers',
      'GET /store/customers/me',
      'GET /store/customers/me/orders',
    ]);

    const seen: string[] = [];
    const mock = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mock: true }));
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    try {
      const proxied = express();
      mountCoreMiddleware(proxied, new DevTokenVerifier(), {
        customerTokenVerifier: fakeVerifier,
        storeApiFallbackUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}`,
      });
      const call = (method: 'get' | 'post', path: string) =>
        request(proxied)
          [method](path)
          .set('X-Publishable-Key', KEY_A)
          .set('Authorization', 'Bearer jane');
      const me = await call('get', '/store/customers/me');
      expect(me.status).toBe(200);
      expect(me.body.mock).toBeUndefined();
      expect((await call('get', '/store/customers/me/orders')).body.mock).toBeUndefined();
      expect(
        (await call('post', '/store/customers').send({ email: 'jane@example.test' })).body.mock,
      ).toBeUndefined();
      expect(seen).toEqual([]);
      // a customer path the core does not answer yet (addresses: PR B) still goes to the mock
      const addresses = await call('get', '/store/customers/me/addresses');
      expect(addresses.body).toEqual({ mock: true });
      expect(seen).toEqual(['GET /store/customers/me/addresses']);
    } finally {
      await new Promise<void>((r) => mock.close(() => r()));
    }
  });
});

describe('the verifier seam is code-only and never reaches production', () => {
  it("the default is auth-sdk's verifyCustomerToken; an override is refused when NODE_ENV is production", () => {
    expect(keycloakCustomerTokenVerifier.verify).toBe(verifyCustomerToken);
    expect(customerTokenVerifierFor(undefined)).toBe(keycloakCustomerTokenVerifier);
    expect(customerTokenVerifierFor(fakeVerifier)).toBe(fakeVerifier);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => customerTokenVerifierFor(fakeVerifier)).toThrow(/never accepted in production/);
      expect(() => mountStoreRoutes(express(), fakeVerifier)).toThrow(
        /never accepted in production/,
      );
      expect(() =>
        mountCoreMiddleware(express(), new DevTokenVerifier(), {
          customerTokenVerifier: fakeVerifier,
        }),
      ).toThrow(/never accepted in production/);
      // a production mount without an override is the real verifier
      expect(customerTokenVerifierFor(undefined)).toBe(keycloakCustomerTokenVerifier);
      expect(() => mountStoreRoutes(express())).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('a chain mounted WITHOUT the seam uses the real verifier: the test words are not tokens there', async () => {
    const real = express();
    mountCoreMiddleware(real, new DevTokenVerifier());
    const before = await customerCount();
    for (const token of ['jane', 'vera', 'not-a-jwt']) {
      const res = await request(real)
        .get('/store/customers/me')
        .set('X-Publishable-Key', KEY_A)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      spec.assertSchema('Error', res.body);
    }
    expect(await customerCount()).toBe(before);
  });
});

// ---- live: docker Keycloak mints a real customers-realm token (dev-only test-cli password grant, which stamps
// store_code=brand-a; seed user jane@example.com — infra/keycloak/README.md). Skipped when Keycloak is down.
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM = process.env.KEYCLOAK_REALM_CUSTOMERS ?? 'customers';
const SEED_CUSTOMER = 'jane@example.com';
const live = await (async () => {
  try {
    const res = await fetch(`${KC}/realms/${REALM}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
})();

describe.runIf(live)('live: a real customers-realm token through the real verifier', () => {
  it('GET /store/customers/me provisions the Keycloak customer in brand-a; the same token is a 401 for brand-b', async () => {
    const grant = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'test-cli',
        grant_type: 'password',
        username: SEED_CUSTOMER,
        // dev-only seed user of the local realm import: the password is the local part
        password: SEED_CUSTOMER.split('@')[0]!,
      }),
    });
    const { access_token: token } = (await grant.json()) as { access_token?: string };
    expect(typeof token).toBe('string');

    const real = express();
    mountCoreMiddleware(real, new DevTokenVerifier()); // no seam: auth-sdk verifies against Keycloak's JWKS
    const call = (path: string, key: string) =>
      request(real).get(path).set('X-Publishable-Key', key).set('Authorization', `Bearer ${token}`);

    const me = await call('/store/customers/me', KEY_A);
    expect(me.status).toBe(200);
    spec.assertSchema('Customer', me.body);
    expect(me.body).toMatchObject({ email: SEED_CUSTOMER, status: 'registered' });
    expect((await call('/store/customers/me', KEY_A)).body).toEqual(me.body);

    const orders = await call('/store/customers/me/orders', KEY_A);
    expect(orders.status).toBe(200);
    spec.assertPage('OrderSummary', orders.body);

    const otherStore = await call('/store/customers/me', KEY_B);
    expect(otherStore.status).toBe(401);
    expect(otherStore.body.code).toBe('unauthorized');
  });
});
