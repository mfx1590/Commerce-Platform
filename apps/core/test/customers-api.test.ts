// Store API customer self-service (#303) through the exact chain src/server.ts mounts: publishable key → tenant
// context → customer token → the customers module. The customers-realm verifier is replaced through the code-only
// test seam (`customerTokenVerifier`); the last describe runs the REAL verifier against docker Keycloak (the
// seeded, verified customer and a freshly self-registered, unverified one) and skips itself when it is not
// reachable. Responses are validated against store-api.yaml. Tokens here are words.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { ApiError, verifyCustomerToken, type CustomerClaims } from '@platform/auth-sdk';
import { createOrganizationClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  completeCartRoute,
  coreErrorHandler,
  createCartRoute,
  CUSTOMER_STORE_PATHS,
  customerTokenVerifierFor,
  DevTokenVerifier,
  keycloakCustomerTokenVerifier,
  mountStoreRoutes,
  REAL_STORE_PATHS,
  storeContextMiddleware,
  type CustomerTokenVerifier,
} from '../src/http';
import { mountCustomerRoutes } from '../src/http/customer-routes';
import { customerGateWith, getOrderRouteWith } from '../src/http/store-routes';
import { paymentProvider } from '../src/modules/checkout';
import { runCustomerExports } from '../src/jobs/customer-export';
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
  // #470 account self-service
  nina: { subject: 'sub-nina', storeCode: 'brand-a', email: 'nina@example.test' },
  dora: {
    subject: 'sub-dora',
    storeCode: 'brand-a',
    email: 'dora@example.test',
    emailVerified: true,
  },
  deleter: { subject: 'sub-deleter', storeCode: 'brand-a', email: 'deleter@example.test' },
  leaver: { subject: 'sub-leaver', storeCode: 'brand-a', email: 'leaver@example.test' },
  ghost: { subject: 'sub-ghost', storeCode: 'brand-a', email: 'ghost@example.test' },
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

type Method = 'get' | 'post' | 'patch' | 'delete' | 'put';
const as = (token: string | null, method: Method, path: string, key: string = KEY_A) => {
  const req = request(app)[method](path).set('X-Publishable-Key', key);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};
const guest = (method: Method, path: string) => as(null, method, path);

const address = {
  first_name: 'Guest',
  last_name: 'Buyer',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

/**
 * A brand-a cart ready for completion (one line, email, addresses, shipping option, payment session), built on
 * the given app. `token` = the customer token sent with `createCart` (Store API 0.5.1); none = a guest cart.
 */
async function readyCartOn(
  target: express.Express,
  email: string,
  token: string | null = null,
): Promise<string> {
  const guest = (method: 'get' | 'post' | 'patch', path: string) =>
    request(target)[method](path).set('X-Publishable-Key', KEY_A);
  const create = guest('post', '/store/carts');
  const created = await (token ? create.set('Authorization', `Bearer ${token}`) : create).send({});
  expect(created.status).toBe(201);
  const cart = created.body;
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
  return cart.id as string;
}

/** `POST …/complete` on the given app, with or without a customer token. */
const completeOn = (
  target: express.Express,
  cartId: string,
  token: string | null = null,
  key = `idem-customers-${cartId}`,
) => {
  const req = request(target)
    .post(`/store/carts/${cartId}/complete`)
    .set('X-Publishable-Key', KEY_A)
    .set('Idempotency-Key', key);
  return (token ? req.set('Authorization', `Bearer ${token}`) : req).send();
};

/** Places a guest order in brand-a with the given checkout email (no customer token anywhere). */
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
  const routes: Array<['get' | 'post' | 'patch', string]> = [
    ['post', '/store/customers'],
    ['get', '/store/customers/me'],
    ['patch', '/store/customers/me'],
    ['get', '/store/customers/me/orders'],
    ['get', '/store/customers/me/addresses'],
    ['post', '/store/customers/me/addresses'],
  ];
  const bodyFor = (method: string, path: string) =>
    method === 'get'
      ? undefined
      : path.endsWith('/addresses')
        ? address
        : method === 'patch'
          ? { first_name: 'Jane' }
          : { email: 'jane@example.test' };

  it("no key → 401 before anything else; no token, an unknown token, another store's token → 401, and nothing is created", async () => {
    const before = await customerCount();
    for (const [method, path] of routes) {
      const noKey = await request(app)[method](path).set('Authorization', 'Bearer jane');
      expect(noKey.status).toBe(401);
      for (const token of [null, 'nobody', 'bob']) {
        const res = await as(token, method, path).send(bodyFor(method, path));
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

  it('the JSON body parser is on POST /store/customers only: a GET that carries a garbage body is unaffected', async () => {
    const garbage = '{"broken": ';
    // http.request, not supertest: the body must really travel with the GET.
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const getWithBody = (path: string, token: string | null) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: (server.address() as AddressInfo).port,
            path,
            method: 'GET',
            headers: {
              'X-Publishable-Key': KEY_A,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(garbage),
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(garbage);
      });
    try {
      for (const path of ['/store/customers/me', '/store/customers/me/orders']) {
        expect(await getWithBody(path, 'jane')).toBe(200);
        // the token rule, not a 400 about a body nobody reads
        expect(await getWithBody(path, null)).toBe(401);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    // On the one route that reads a body, JSON that does not parse is a 400 — before the token check
    // (accepted choice 10: the parser runs ahead of the handler).
    for (const token of ['jane', null]) {
      const res = await as(token, 'post', '/store/customers')
        .set('Content-Type', 'application/json')
        .send(garbage);
      expect(res.status).toBe(400);
      spec.assertSchema('Error', res.body);
      expect(res.body.code).toBe('validation_error');
    }
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
        path === '/store/customers' ? { email: 'blocked@example.test' } : bodyFor(method, path),
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
      await as('mallory', 'patch', '/store/customers/me').send({ first_name: 'Mallory' }),
      await as('mallory', 'get', '/store/customers/me/addresses'),
      await as('mallory', 'post', '/store/customers/me/addresses').send(address),
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
    // "Newest first" is a sort by placed_at (the database's now()). The three orders are placed a few hundred
    // milliseconds apart, and the Postgres container's clock is not guaranteed to be monotonic across requests
    // (seen once: the later order carried the earlier timestamp) — so the test sets the times it then sorts by.
    for (const [id, placedAt] of [
      [veraGuestOrder, '2026-09-01T10:00:00Z'],
      [janeGuestOrder, '2026-09-01T10:01:00Z'],
      [veraLinkedOrder, '2026-09-01T10:02:00Z'],
    ]) {
      await owner.query(`UPDATE "order" SET placed_at = $2 WHERE id = $1`, [id, placedAt]);
    }
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

describe('PATCH /store/customers/me', () => {
  it('200 with the updated customer; an empty string clears the phone; 400 on a wrong type or a non-object body', async () => {
    const updated = await as('ursula', 'patch', '/store/customers/me').send({
      last_name: 'K. Le Guin',
      phone: '+31 6 1111 1111',
      marketing_consent: true,
    });
    expect(updated.status).toBe(200);
    spec.assertSchema('Customer', updated.body);
    expect(updated.body).toMatchObject({
      first_name: 'Ursula',
      last_name: 'K. Le Guin',
      phone: '+31 6 1111 1111',
      marketing_consent: true,
    });
    const cleared = await as('ursula', 'patch', '/store/customers/me').send({ phone: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.phone).toBeNull();
    expect((await as('ursula', 'get', '/store/customers/me')).body).toEqual(cleared.body);

    // Store API 0.5.1 documents no 400 on updateMe; 0.4.9 adds it — the core answers it already.
    for (const body of [{ phone: 5 }, { marketing_consent: 'yes' }, [], 'text']) {
      const bad = await as('ursula', 'patch', '/store/customers/me')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body));
      expect(bad.status).toBe(400);
      spec.assertSchema('Error', bad.body);
      expect(bad.body.code).toBe('validation_error');
    }
    // a customer created by the PATCH itself (first contact): 200, not 201 — updateMe has no 201
    PERSONAS.newcomer = {
      subject: 'sub-newcomer',
      storeCode: 'brand-a',
      email: 'newcomer@example.test',
    };
    const fresh = await as('newcomer', 'patch', '/store/customers/me').send({ first_name: 'New' });
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ email: 'newcomer@example.test', first_name: 'New' });
  });
});

describe('GET and POST /store/customers/me/addresses', () => {
  it('201 CustomerAddress; the first one is the default; the list is default shipping first; blanks and a bad country are a 400 naming the field', async () => {
    const first = await as('ursula', 'post', '/store/customers/me/addresses').send({
      ...address,
      first_name: 'Ursula',
      last_name: 'Le Guin',
      company: null,
      line2: null,
      region: null,
      phone: null,
    });
    expect(first.status).toBe(201);
    spec.assertSchema('CustomerAddress', first.body);
    expect(first.body).toMatchObject({
      first_name: 'Ursula',
      country: 'NL',
      is_default_shipping: true,
      is_default_billing: true,
    });
    const second = await as('ursula', 'post', '/store/customers/me/addresses').send({
      ...address,
      line1: 'Prinsengracht 2',
    });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ is_default_shipping: false, is_default_billing: false });
    // contracts 0.4.9: the body may ask for a default; the 0.5.1 spec has no additionalProperties: false
    const gift = await as('ursula', 'post', '/store/customers/me/addresses').send({
      ...address,
      line1: 'Gift street 3',
      is_default_shipping: true,
    });
    expect(gift.status).toBe(201);
    expect(gift.body).toMatchObject({ is_default_shipping: true, is_default_billing: false });

    // "then oldest first" sorts by created_at: pinned here, not left to the database container's clock
    await owner.query(`UPDATE customer_address SET created_at = $2 WHERE id = $1`, [
      first.body.id,
      '2026-09-01T10:00:00Z',
    ]);
    await owner.query(`UPDATE customer_address SET created_at = $2 WHERE id = $1`, [
      second.body.id,
      '2026-09-01T10:01:00Z',
    ]);
    const list = await as('ursula', 'get', '/store/customers/me/addresses');
    expect(list.status).toBe(200);
    spec.assertItems('CustomerAddress', list.body);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([
      gift.body.id,
      first.body.id,
      second.body.id,
    ]);
    expect(list.body.items[1]).toMatchObject({
      is_default_shipping: false,
      is_default_billing: true,
    });

    const bad = await as('ursula', 'post', '/store/customers/me/addresses').send({
      ...address,
      city: '   ',
      country: 'nl',
    });
    expect(bad.status).toBe(400);
    spec.assertSchema('Error', bad.body);
    expect(bad.body.code).toBe('validation_error');
    const missing = await as('ursula', 'post', '/store/customers/me/addresses').send({
      first_name: 'Ursula',
    });
    expect(missing.status).toBe(400);
    expect((await as('ursula', 'get', '/store/customers/me/addresses')).body.items).toHaveLength(3);
  });

  it('a signed-in customer with no row yet gets one from the address call too (no 404 anywhere)', async () => {
    PERSONAS.mover = { subject: 'sub-mover', storeCode: 'brand-a', email: 'mover@example.test' };
    const list = await as('mover', 'get', '/store/customers/me/addresses');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ items: [] });
    expect((await as('mover', 'get', '/store/customers/me')).status).toBe(200);
  });
});

describe('placement-time customer link (Store API 0.5.1, #310): createCart and completeCart may carry a customer token', () => {
  const cartRow = async (id: string) =>
    (
      await owner.query<{ customer_id: string | null; status: string }>(
        `SELECT customer_id, status FROM cart WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const orderRow = async (id: string) =>
    (
      await owner.query<{ customer_id: string | null; email: string }>(
        `SELECT customer_id, email FROM "order" WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const count = async (table: 'cart' | '"order"' | 'payment') =>
    Number(
      (await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n,
    );
  const idOf = async (token: string) =>
    (await as(token, 'get', '/store/customers/me')).body.id as string;

  it("a token that is SENT must verify: invalid, another store's, a disabled customer's → 401 on both operations, before the body and the Idempotency-Key; nothing is created or placed", async () => {
    const cartId = await readyCartOn(app, 'someone@example.test');
    const before = { carts: await count('cart'), orders: await count('"order"') };
    for (const token of ['not-a-token', 'bob', 'blocked']) {
      // window 3 measured 201 here before this change
      const created = await as(token, 'post', '/store/carts').send({});
      expect(created.status).toBe(401);
      spec.assertSchema('Error', created.body);
      expect(created.body.code).toBe('unauthorized');
      // the token is judged before the body rules …
      expect((await as(token, 'post', '/store/carts').send({ currency: 'nope' })).status).toBe(401);
      // … and before the Idempotency-Key and the cart id
      const noKey = await as(token, 'post', `/store/carts/${cartId}/complete`).send();
      expect(noKey.status).toBe(401);
      expect((await as(token, 'post', '/store/carts/not-a-uuid/complete').send()).status).toBe(401);
      expect((await completeOn(app, cartId, token)).status).toBe(401);
    }
    expect(await count('cart')).toBe(before.carts);
    expect(await count('"order"')).toBe(before.orders);
    expect(await cartRow(cartId)).toEqual({ customer_id: null, status: 'active' });
    // an email collision that cannot be adopted is the customer routes' 409 here too
    expect((await as('mallory', 'post', '/store/carts').send({})).status).toBe(409);
    // without an Authorization header nothing changed: a guest cart, a guest order
    const guestOrder = await completeOn(app, cartId);
    expect(guestOrder.status).toBe(201);
    expect((await orderRow(guestOrder.body.id)).customer_id).toBeNull();
  });

  it("createCart with a token links the cart; completing it WITHOUT a token keeps the cart's link", async () => {
    const jane = await idOf('jane');
    const cartId = await readyCartOn(app, 'someone.else@example.test', 'jane');
    expect(await cartRow(cartId)).toEqual({ customer_id: jane, status: 'active' });
    // the Cart body does not expose the customer
    const read = await guest('get', `/store/carts/${cartId}`);
    spec.assertSchema('Cart', read.body);
    expect(JSON.stringify(read.body)).not.toContain(jane);

    const placed = await completeOn(app, cartId);
    expect(placed.status).toBe(201);
    spec.assertSchema('Order', placed.body);
    expect(await orderRow(placed.body.id)).toEqual({
      customer_id: jane,
      email: 'someone.else@example.test', // the order keeps the checkout email
    });
  });

  it("completeCart with a token links a GUEST cart in the placement: the order is the customer's without any email match — the gap this closes", async () => {
    const jane = await idOf('jane'); // jane's token email is NOT verified
    const listed = async () =>
      (await as('jane', 'get', '/store/customers/me/orders')).body.items.map(
        (o: { id: string }) => o.id,
      ) as string[];
    const cartId = await readyCartOn(app, 'gift.for.a.friend@example.test');
    expect((await cartRow(cartId)).customer_id).toBeNull();

    const placed = await completeOn(app, cartId, 'jane');
    expect(placed.status).toBe(201);
    spec.assertSchema('Order', placed.body);
    expect(await cartRow(cartId)).toEqual({ customer_id: jane, status: 'completed' });
    expect(await orderRow(placed.body.id)).toEqual({
      customer_id: jane,
      email: 'gift.for.a.friend@example.test',
    });
    expect(await listed()).toContain(placed.body.id);
    expect((await as('jane', 'get', `/store/orders/${placed.body.id}`)).status).toBe(200);

    // order.placed carries the customer id and the actor is the customer — and still no email
    const event = await owner.query<{
      payload: Record<string, unknown>;
      headers: { actor: unknown };
    }>(`SELECT payload, headers FROM outbox WHERE topic = 'order.placed' AND aggregate_id = $1`, [
      placed.body.id,
    ]);
    expect(event.rows[0]!.payload.customer_id).toBe(jane);
    expect(event.rows[0]!.headers.actor).toEqual({ type: 'customer', id: jane });
    expect(JSON.stringify(event.rows[0])).not.toContain('@example.test');

    // A replay with the same key answers the stored order to the customer it was placed for …
    const mine = await completeOn(app, cartId, 'jane');
    expect(mine.status).toBe(201);
    expect(mine.body.id).toBe(placed.body.id);
    // … and never to ANOTHER customer's token: 409, and the body carries nothing of the order (#325 review)
    for (const other of ['vera', 'rita']) {
      const refused = await completeOn(app, cartId, other);
      expect(refused.status).toBe(409);
      spec.assertSchema('Error', refused.body);
      expect(refused.body).toEqual({
        code: 'conflict',
        message: 'This cart belongs to another customer',
        details: {},
      });
      const text = JSON.stringify(refused.body);
      expect(text).not.toContain(placed.body.id);
      expect(text).not.toContain(String(placed.body.display_id));
      expect(text).not.toContain('@example.test');
    }
    // without a token the cart id + key are the capability, as on every other cart operation (accepted gap)
    const anonymous = await completeOn(app, cartId);
    expect(anonymous.status).toBe(201);
    expect(anonymous.body.id).toBe(placed.body.id);
    // nothing of that changed the link, and nothing was placed twice
    expect((await orderRow(placed.body.id)).customer_id).toBe(jane);
    const orders = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "order" WHERE cart_id = $1`,
      [cartId],
    );
    expect(orders.rows[0]!.n).toBe('1');
  });

  it("a replay WITH a token on a GUEST order is a 409 too: a token never opens an order that is not that customer's", async () => {
    const cartId = await readyCartOn(app, 'guest.replay@example.test');
    const placed = await completeOn(app, cartId);
    expect(placed.status).toBe(201);
    expect((await orderRow(placed.body.id)).customer_id).toBeNull();
    const withToken = await completeOn(app, cartId, 'jane');
    expect(withToken.status).toBe(409);
    expect(JSON.stringify(withToken.body)).not.toContain(placed.body.id);
    expect((await orderRow(placed.body.id)).customer_id).toBeNull();
    expect((await completeOn(app, cartId)).body.id).toBe(placed.body.id);
  });

  it('the token is judged BEFORE the JSON body parser: a bad token with malformed or oversized JSON is a 401, not a 400 / 413', async () => {
    const cartId = await readyCartOn(app, 'parser.order@example.test');
    const malformed = '{"currency": ';
    const oversized = JSON.stringify({ metadata: { blob: 'x'.repeat(300 * 1024) } });
    const post = (path: string, token: string | null, payload: string) => {
      const req = request(app)
        .post(path)
        .set('X-Publishable-Key', KEY_A)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', `idem-parser-${cartId}`);
      return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(payload);
    };
    for (const path of ['/store/carts', `/store/carts/${cartId}/complete`]) {
      for (const payload of [malformed, oversized]) {
        const bad = await post(path, 'not-a-token', payload);
        expect(bad.status).toBe(401);
        spec.assertSchema('Error', bad.body);
        expect(bad.body.code).toBe('unauthorized');
      }
      // with a valid token, or with none, the body rules apply as before
      expect((await post(path, 'jane', malformed)).status).toBe(400);
      expect((await post(path, null, malformed)).status).toBe(400);
      expect((await post(path, null, oversized)).status).toBe(413);
    }
    expect(await cartRow(cartId)).toEqual({ customer_id: null, status: 'active' });
  });

  it('fail closed: the cart handlers mounted WITHOUT the gate never treat a sent token as absent', async () => {
    const bare = express();
    bare.use('/store', storeContextMiddleware);
    bare.post('/store/carts', createCartRoute);
    bare.post('/store/carts/:cartId/complete', completeCartRoute);
    bare.use(coreErrorHandler);
    const cartId = await readyCartOn(app, 'bare@example.test');
    for (const token of ['jane', 'not-a-token']) {
      const created = await request(bare)
        .post('/store/carts')
        .set('X-Publishable-Key', KEY_A)
        .set('Authorization', `Bearer ${token}`);
      expect(created.status).toBe(401);
      expect((await completeOn(bare, cartId, token)).status).toBe(401);
    }
    // without a header they are the guest operations they always were
    expect((await request(bare).post('/store/carts').set('X-Publishable-Key', KEY_A)).status).toBe(
      201,
    );
    // and the gate itself refuses a verifier override in production, like every other door
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => customerGateWith(fakeVerifier)).toThrow(/never accepted in production/);
      expect(() => customerGateWith()).not.toThrow();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('a cart linked to ANOTHER customer → 409 conflict: nothing placed, nothing authorised, the cart stays theirs and can still be completed by them', async () => {
    const rita = await idOf('rita');
    const cartId = await readyCartOn(app, 'rita.checkout@example.test', 'rita');
    const before = { orders: await count('"order"'), payments: await count('payment') };

    // the provider itself is watched: a guard moved behind `authorize` would fail here even if it rolled back
    const authorize = vi.spyOn(paymentProvider('manual'), 'authorize');
    try {
      const refused = await completeOn(app, cartId, 'vera');
      expect(refused.status).toBe(409);
      spec.assertSchema('Error', refused.body);
      expect(refused.body).toEqual({
        code: 'conflict',
        message: 'This cart belongs to another customer',
        details: {},
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(await count('"order"')).toBe(before.orders);
      expect(await count('payment')).toBe(before.payments);
      expect(await cartRow(cartId)).toEqual({ customer_id: rita, status: 'active' });

      // same Idempotency-Key, the right customer: the refusal left nothing behind
      const placed = await completeOn(app, cartId, 'rita');
      expect(placed.status).toBe(201);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect((await orderRow(placed.body.id)).customer_id).toBe(rita);
    } finally {
      authorize.mockRestore();
    }
  });

  it('the other cart operations ignore the header, as the contract says: a bad token on GET / PATCH / line items changes nothing', async () => {
    const cartId = await readyCartOn(app, 'plain@example.test');
    const read = await as('not-a-token', 'get', `/store/carts/${cartId}`);
    expect(read.status).toBe(200);
    const patched = await as('not-a-token', 'patch', `/store/carts/${cartId}`).send({
      email: 'plain.two@example.test',
    });
    expect(patched.status).toBe(200);
    expect((await cartRow(cartId)).customer_id).toBeNull();
  });
});

describe('account self-service (#470, Store API 0.5.6): edit / delete an address, request my export, delete my account', () => {
  const outboxOf = async (customerId: string) =>
    (
      await owner.query<{ topic: string; payload: Record<string, unknown> }>(
        `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
        [customerId],
      )
    ).rows;

  it("PATCH / DELETE …/addresses/{id}: own addresses only; another customer's id and an unknown id are the same 404; a brand-b key refuses the brand-a token", async () => {
    const home = await as('nina', 'post', '/store/customers/me/addresses').send(address);
    const work = await as('nina', 'post', '/store/customers/me/addresses').send({
      ...address,
      line1: 'Office 2',
    });
    expect([home.status, work.status]).toEqual([201, 201]);
    const nina = (await as('nina', 'get', '/store/customers/me')).body;

    // edit: a field replaced, a default moved (clear-then-set), the contract shape
    const edited = await as('nina', 'patch', `/store/customers/me/addresses/${work.body.id}`).send({
      line1: 'Office 2b',
      company: 'ACME',
      is_default_shipping: true,
    });
    expect(edited.status).toBe(200);
    spec.assertSchema('CustomerAddress', edited.body);
    expect(edited.body).toMatchObject({
      id: work.body.id,
      line1: 'Office 2b',
      company: 'ACME',
      is_default_shipping: true,
      is_default_billing: false,
    });
    const list = await as('nina', 'get', '/store/customers/me/addresses');
    expect(
      list.body.items.map((x: { id: string; is_default_shipping: boolean }) => [
        x.id,
        x.is_default_shipping,
      ]),
    ).toEqual([
      [work.body.id, true],
      [home.body.id, false],
    ]);
    // the id is checked before the body: a malformed id is the same 404 as an unknown one (#487 review — the
    // contract documents no 400 for the path, as on getOrder); a bad body is a 400 naming the field
    for (const method of ['patch', 'delete'] as const) {
      const malformed = await as('nina', method, '/store/customers/me/addresses/not-a-uuid').send(
        method === 'patch' ? {} : undefined,
      );
      expect(malformed.status).toBe(404);
      spec.assertSchema('Error', malformed.body);
      expect(malformed.body.code).toBe('not_found');
    }
    const bad = await as('nina', 'patch', `/store/customers/me/addresses/${work.body.id}`).send({
      country: 'nl',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      code: 'validation_error',
      details: { country: expect.any(String) },
    });

    // isolation: jane (another customer of the same store) and an unknown id → the same 404
    for (const [method, id] of [
      ['patch', work.body.id],
      ['delete', work.body.id],
      ['patch', '00000000-0000-4000-8000-0000000000aa'],
      ['delete', '00000000-0000-4000-8000-0000000000aa'],
    ] as const) {
      const res = await as('jane', method, `/store/customers/me/addresses/${id}`).send(
        method === 'patch' ? { city: 'Elsewhere' } : undefined,
      );
      expect(res.status).toBe(404);
      spec.assertSchema('Error', res.body);
      expect(res.body.code).toBe('not_found');
    }
    // the store_code binding: nina's token with brand-b's key is a 401 on every new route, nothing written
    const before = (await outboxOf(nina.id)).length;
    for (const [method, path] of [
      ['patch', `/store/customers/me/addresses/${work.body.id}`],
      ['delete', `/store/customers/me/addresses/${work.body.id}`],
      ['post', '/store/customers/me/export'],
      ['delete', '/store/customers/me'],
    ] as const) {
      const res = await as('nina', method, path, KEY_B).send(
        method === 'patch' ? { city: 'X' } : undefined,
      );
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    }
    expect(await outboxOf(nina.id)).toHaveLength(before);
    expect((await as('nina', 'get', '/store/customers/me/addresses')).body.items).toHaveLength(2);

    // delete: 200 with the remaining addresses (listMyAddresses shape); the default the deleted address held
    // moves to the oldest remaining one, and the answer already shows it
    const gone = await as('nina', 'delete', `/store/customers/me/addresses/${work.body.id}`);
    expect(gone.status).toBe(200);
    spec.assertItems('CustomerAddress', gone.body);
    const left = await as('nina', 'get', '/store/customers/me/addresses');
    expect(left.body).toEqual(gone.body);
    expect(left.body.items).toEqual([
      expect.objectContaining({
        id: home.body.id,
        is_default_shipping: true,
        is_default_billing: true,
      }),
    ]);
    expect(
      (await as('nina', 'delete', `/store/customers/me/addresses/${work.body.id}`)).status,
    ).toBe(404);
  });

  it('POST /store/customers/me/export: 202 without a body, one customer.export_requested v2 per call (requested by the customer), ids only', async () => {
    const nina = (await as('nina', 'get', '/store/customers/me')).body;
    const before = (await outboxOf(nina.id)).filter((e) => e.topic === 'customer.export_requested');
    expect(before).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) {
      const res = await as('nina', 'post', '/store/customers/me/export');
      expect(res.status).toBe(202);
      expect(res.text).toBe('');
    }
    const requested = (await outboxOf(nina.id)).filter(
      (e) => e.topic === 'customer.export_requested',
    );
    expect(requested).toHaveLength(2);
    expect(requested[0]!.payload).toEqual({
      customer_id: nina.id,
      requested_by: nina.id,
      requested_by_type: 'customer',
      requested_at: expect.any(String),
    });
    expect(JSON.stringify(requested)).not.toContain('nina');
    const audit = await owner.query(
      `SELECT actor_type, actor_id FROM audit_log WHERE entity_id = $1 AND action = 'customer.export_request'`,
      [nina.id],
    );
    expect(audit.rows).toEqual([
      { actor_type: 'customer', actor_id: nina.id },
      { actor_type: 'customer', actor_id: nina.id },
    ]);
    // an unknown token cannot ask for anything
    expect((await as('nobody', 'post', '/store/customers/me/export')).status).toBe(401);
  });

  it('DELETE /me and POST /me/export for a subject with NO row: 202, nothing provisioned, the outbox stays empty (#487 review)', async () => {
    const count = await customerCount();
    const outbox = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM outbox WHERE aggregate_type = 'customer'`,
          )
        ).rows[0]!.n,
      );
    const events = await outbox();
    for (const [method, path] of [
      ['delete', '/store/customers/me'],
      ['post', '/store/customers/me/export'],
      ['delete', '/store/customers/me'],
    ] as const) {
      const res = await as('ghost', method, path);
      expect(res.status, `${method} ${path}`).toBe(202);
      expect(res.text).toBe('');
    }
    expect(await customerCount()).toBe(count);
    expect(await outbox()).toBe(events);
    // the first ordinary call still provisions as before
    expect((await as('ghost', 'get', '/store/customers/me')).status).toBe(200);
    expect(await customerCount()).toBe(count + 1);
  });

  it('DELETE /store/customers/me: 202; no PII left in customer or customer_address; the order keeps customer_id; one customer.erased; the replay is a 202 no-op; the same login is a 401 everywhere after', async () => {
    // dora: a profile, an address and one order placed with her token
    await as('dora', 'patch', '/store/customers/me').send({
      first_name: 'Dora',
      last_name: 'Explorer',
      phone: '+31 6 4444 4444',
      marketing_consent: true,
    });
    await as('dora', 'post', '/store/customers/me/addresses').send({
      ...address,
      line1: 'Mapstreet 7',
    });
    const dora = (await as('dora', 'get', '/store/customers/me')).body;
    const cartId = await readyCartOn(app, 'dora@example.test', 'dora');
    const placed = await completeOn(app, cartId, 'dora');
    expect(placed.status).toBe(201);
    const orderId = placed.body.id as string;

    const res = await as('dora', 'delete', '/store/customers/me');
    expect(res.status).toBe(202);
    expect(res.text).toBe('');

    const row = (await owner.query('SELECT * FROM customer WHERE id = $1', [dora.id])).rows[0];
    expect(row).toMatchObject({
      status: 'erased',
      email: `erased+${dora.id}@invalid`,
      first_name: null,
      last_name: null,
      phone: null,
      consent: {},
      metadata: {},
      keycloak_subject: 'sub-dora', // the erasure tombstone, #482
    });
    expect(
      (await owner.query('SELECT 1 FROM customer_address WHERE customer_id = $1', [dora.id]))
        .rowCount,
    ).toBe(0);
    const order = await owner.query<{ customer_id: string | null; email: string }>(
      'SELECT customer_id, email FROM "order" WHERE id = $1',
      [orderId],
    );
    expect(order.rows[0]).toEqual({ customer_id: dora.id, email: 'dora@example.test' });
    const erased = (await outboxOf(dora.id)).filter((e) => e.topic === 'customer.erased');
    expect(erased).toHaveLength(1);
    expect(erased[0]!.payload).toEqual({
      customer_id: dora.id,
      identity_id: null,
      erased_at: expect.any(String),
    });
    const docs = await owner.query<{ doc: string }>(
      `SELECT payload::text AS doc FROM outbox WHERE aggregate_id = $1
       UNION ALL SELECT coalesce(after::text, '') FROM audit_log WHERE entity_id = $1`,
      [dora.id],
    );
    const written = docs.rows.map((r) => r.doc).join('\n');
    for (const pii of ['dora@example.test', 'Dora', 'Explorer', '4444', 'Mapstreet', 'sub-dora']) {
      expect(written).not.toContain(pii);
    }

    // replay: 202, nothing more written
    expect((await as('dora', 'delete', '/store/customers/me')).status).toBe(202);
    expect((await outboxOf(dora.id)).filter((e) => e.topic === 'customer.erased')).toHaveLength(1);
    // the same login: 401 on every route, no fresh account (the tombstone keeps the subject bound to the erased row)
    const count = await customerCount();
    for (const [method, path] of [
      ['get', '/store/customers/me'],
      ['post', '/store/customers'],
      ['patch', '/store/customers/me'],
      ['get', '/store/customers/me/orders'],
      ['get', '/store/customers/me/addresses'],
      ['post', '/store/customers/me/addresses'],
      ['post', '/store/customers/me/export'],
    ] as const) {
      const r = await as('dora', method, path).send(
        method === 'get'
          ? undefined
          : path === '/store/customers'
            ? { email: 'dora@example.test' }
            : address,
      );
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect(await customerCount()).toBe(count);
  });
});

describe('consents (#471, Store API 0.5.7): GET / PUT /store/customers/me/consents', () => {
  it('GET: one item per purpose, granted null until asked; PUT records the answer under the version sent, answers the state, 400 names the field; a brand-b key refuses the token', async () => {
    const before = await as('nina', 'get', '/store/customers/me/consents');
    expect(before.status).toBe(200);
    spec.assertSchema('CustomerConsents', before.body);
    expect(before.body).toEqual({
      items: [
        {
          purpose: 'marketing_email',
          granted: null,
          source: null,
          policy_version: null,
          recorded_at: null,
        },
      ],
    });

    const put = await as('nina', 'put', '/store/customers/me/consents').send({
      policy_version: '2026-10',
      consents: [{ purpose: 'marketing_email', granted: true }],
    });
    expect(put.status).toBe(200);
    spec.assertSchema('CustomerConsents', put.body);
    expect(put.body.items[0]).toMatchObject({
      purpose: 'marketing_email',
      granted: true,
      source: 'storefront',
      policy_version: '2026-10',
    });
    expect((await as('nina', 'get', '/store/customers/me/consents')).body).toEqual(put.body);
    expect((await as('nina', 'get', '/store/customers/me')).body.marketing_consent).toBe(true);

    for (const [body, field] of [
      [{ consents: [{ purpose: 'marketing_email', granted: true }] }, 'policy_version'],
      [{ policy_version: 'v', consents: [] }, 'consents'],
      [
        { policy_version: 'v', consents: [{ purpose: 'marketing_sms', granted: true }] },
        'consents.0.purpose',
      ],
      // a non-JSON body is parsed as {}: the schema's required fields are what the 400 names
      ['not an object', 'policy_version'],
    ] as const) {
      const bad = await as('nina', 'put', '/store/customers/me/consents').send(body);
      expect(bad.status, field).toBe(400);
      spec.assertSchema('Error', bad.body);
      expect(bad.body.code).toBe('validation_error');
      expect(Object.keys(bad.body.details).join(',')).toContain(field);
    }
    // store_code binding
    for (const method of ['get', 'put'] as const) {
      const res = await as('nina', method, '/store/customers/me/consents', KEY_B).send(
        method === 'put'
          ? { policy_version: 'v', consents: [{ purpose: 'marketing_email', granted: false }] }
          : undefined,
      );
      expect(res.status).toBe(401);
    }
    expect((await as('nina', 'get', '/store/customers/me/consents')).body.items[0].granted).toBe(
      true,
    );
    // the unticked box: an explicit refusal is recorded, not "never asked"
    const refused = await as('nina', 'put', '/store/customers/me/consents').send({
      policy_version: '2026-10',
      consents: [{ purpose: 'marketing_email', granted: false }],
    });
    expect(refused.body.items[0]).toMatchObject({ granted: false });
    const ledger = await owner.query(
      `SELECT granted FROM customer_consent WHERE customer_id = (SELECT id FROM customer WHERE keycloak_subject = 'sub-nina' AND store_id = $1) ORDER BY recorded_at, id`,
      [A],
    );
    expect(ledger.rows.map((r: { granted: boolean }) => r.granted)).toEqual([true, false]);
  });
});

describe('export delivery (#472, Store API 0.5.8): the job, GET /store/customers/me/exports and the download', () => {
  it('requests → the job builds → list shows ready → the bundle downloads as a JSON attachment; malformed / foreign ids 404; expired 410; a brand-b key refuses the token', async () => {
    const T0 = new Date('2026-10-18T12:00:00.000Z');
    PERSONAS.exporter = {
      subject: 'sub-exporter',
      storeCode: 'brand-a',
      email: 'exporter@example.test',
    };
    await as('exporter', 'patch', '/store/customers/me').send({ first_name: 'Exa' });
    expect((await as('exporter', 'post', '/store/customers/me/export')).status).toBe(202);
    const empty = await as('exporter', 'get', '/store/customers/me/exports');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });

    // the job (the same function the Medusa job and the CLI run), with an injected clock
    const run = await runCustomerExports({ now: T0, organizationId: ORG });
    expect(run.stores).toBeGreaterThanOrEqual(2);
    expect(run.claimed).toBeGreaterThanOrEqual(1);
    const again = await runCustomerExports({ now: T0, organizationId: ORG });
    expect(again.claimed).toBe(0);
    expect(again.built).toEqual([]);

    const list = await as('exporter', 'get', '/store/customers/me/exports');
    expect(list.status).toBe(200);
    spec.assertItems('CustomerExportSummary', list.body);
    expect(list.body.items).toHaveLength(1);
    const item = list.body.items[0];
    expect(item).toMatchObject({ status: 'ready', ready_at: T0.toISOString(), reason: null });

    const file = await as('exporter', 'get', `/store/customers/me/exports/${item.id}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/^application\/json/);
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="customer-export-${item.id}.json"`,
    );
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.body).toMatchObject({
      format: 'customer-export/v1',
      store_id: A,
      customer: { email: 'exporter@example.test', first_name: 'Exa' },
    });

    expect((await as('exporter', 'get', '/store/customers/me/exports/not-a-uuid')).status).toBe(
      404,
    );
    expect((await as('jane', 'get', `/store/customers/me/exports/${item.id}`)).status).toBe(404);
    for (const path of ['/store/customers/me/exports', `/store/customers/me/exports/${item.id}`]) {
      expect((await as('exporter', 'get', path, KEY_B)).status).toBe(401);
    }

    // past the TTL: the next run purges; the download is 410 `expired`, the list says expired
    const later = await runCustomerExports({
      now: new Date(T0.getTime() + 31 * 86_400_000),
      organizationId: ORG,
    });
    expect(later.purged).toBeGreaterThanOrEqual(1);
    const gone = await as('exporter', 'get', `/store/customers/me/exports/${item.id}`);
    expect(gone.status).toBe(410);
    spec.assertSchema('Error', gone.body);
    expect(gone.body).toMatchObject({ code: 'expired', details: { expires_at: item.expires_at } });
    expect(
      (await as('exporter', 'get', '/store/customers/me/exports')).body.items[0],
    ).toMatchObject({
      status: 'expired',
      size_bytes: null,
    });
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
      await as('jane', 'patch', '/store/customers/me').send({ phone: '+31 6 7777 7777' });
      await as('jane', 'post', '/store/customers/me/addresses').send({
        ...address,
        line1: 'Secretstreet 9',
        city: 'Hiddentown',
      });
      await as('jane', 'post', '/store/customers/me/addresses').send({ ...address, city: '' });
      await as('jane', 'get', '/store/customers/me/addresses');
      // #470
      const mine = (await as('jane', 'get', '/store/customers/me/addresses')).body.items[0].id;
      await as('jane', 'patch', `/store/customers/me/addresses/${mine}`).send({
        line1: 'Quietlane 4',
        phone: '+31 6 5555 5555',
      });
      await as('jane', 'patch', `/store/customers/me/addresses/${mine}`).send({ country: 'x' });
      await as('jane', 'delete', `/store/customers/me/addresses/${mine}`);
      await as('jane', 'post', '/store/customers/me/export');
      await as('deleter', 'post', '/store/customers/me/addresses').send({
        ...address,
        line1: 'Lastlane 1',
      });
      await as('jane', 'put', '/store/customers/me/consents').send({
        policy_version: 'hush-policy-7',
        consents: [{ purpose: 'marketing_email', granted: false }],
      });
      await as('jane', 'get', '/store/customers/me/consents');
      await as('jane', 'get', '/store/customers/me/exports');
      await as('jane', 'get', '/store/customers/me/exports/00000000-0000-4000-8000-0000000000ee');
      await runCustomerExports({ organizationId: ORG });
      await as('deleter', 'delete', '/store/customers/me');
      await as('deleter', 'delete', '/store/customers/me');
      await as('deleter', 'get', '/store/customers/me');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = logged.join('\n').toLowerCase();
    for (const secret of [
      '@example.test',
      'janet',
      'bearer',
      'sub-jane',
      'sub-deleter',
      'mallory',
      'secretstreet',
      'hiddentown',
      '6 7777',
      'quietlane',
      'lastlane',
      '6 5555',
      'hush-policy',
    ]) {
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
      'PATCH /store/customers/me',
      'GET /store/customers/me/orders',
      'GET /store/customers/me/addresses',
      'POST /store/customers/me/addresses',
      'PATCH /store/customers/me/addresses/{addressId}',
      'DELETE /store/customers/me/addresses/{addressId}',
      'POST /store/customers/me/export',
      'DELETE /store/customers/me',
      'GET /store/customers/me/consents',
      'PUT /store/customers/me/consents',
      'GET /store/customers/me/exports',
      'GET /store/customers/me/exports/{exportId}',
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
      const call = (method: Method, path: string, token = 'jane') =>
        request(proxied)
          [method](path)
          .set('X-Publishable-Key', KEY_A)
          .set('Authorization', `Bearer ${token}`);
      // every customer path is answered here — the bearer token never reaches the mock
      const added = await call('post', '/store/customers/me/addresses').send(address);
      for (const res of [
        await call('get', '/store/customers/me'),
        await call('patch', '/store/customers/me').send({ first_name: 'Jane' }),
        await call('get', '/store/customers/me/orders'),
        await call('get', '/store/customers/me/addresses'),
        added,
        await call('post', '/store/customers').send({ email: 'jane@example.test' }),
        // #470: the four new operations answer from the customer router too (a path that were NOT mounted
        // would fall through to the fallback and come back as `{ mock: true }`)
        await call('patch', `/store/customers/me/addresses/${added.body.id}`).send({
          city: 'Utrecht',
        }),
        await call('delete', `/store/customers/me/addresses/${added.body.id}`),
        await call('post', '/store/customers/me/export'),
        await call('get', '/store/customers/me/consents'),
        await call('put', '/store/customers/me/consents').send({
          policy_version: 'v1',
          consents: [{ purpose: 'marketing_email', granted: true }],
        }),
        await call('get', '/store/customers/me/exports'),
        await call('delete', '/store/customers/me', 'leaver'),
      ]) {
        expect(res.status).toBeLessThan(300);
        expect(res.body.mock).toBeUndefined();
      }
      expect(seen).toEqual([]);
      // an operation the contract does not define under /store/customers is a 404 from the core — with or
      // without a bearer, and the mock never sees it (no 405, no new error code)
      const undefinedOperations: Array<['put' | 'delete' | 'get' | 'patch' | 'post', string]> = [
        ['put', '/store/customers/me'],
        ['put', '/store/customers'],
        ['delete', '/store/customers/me/addresses'],
        ['patch', '/store/customers/me/orders'],
        ['get', '/store/customers'],
        ['get', '/store/customers/me/unknown'],
        ['put', '/store/customers/me/addresses/00000000-0000-4000-8000-000000000001'],
        ['get', '/store/customers/me/addresses/00000000-0000-4000-8000-000000000001'],
        ['get', '/store/customers/me/export'],
        ['delete', '/store/customers/me/export'],
        ['post', '/store/customers/me/consents'],
        ['delete', '/store/customers/me/consents'],
        ['post', '/store/customers/me/exports'],
        ['delete', '/store/customers/me/exports/00000000-0000-4000-8000-000000000001'],
        ['post', '/store/customers/someone-else'],
      ];
      for (const [method, path] of undefinedOperations) {
        for (const bearer of ['Bearer jane', 'Bearer not-a-token', null]) {
          const req = request(proxied)[method](path).set('X-Publishable-Key', KEY_A);
          const res = await (bearer ? req.set('Authorization', bearer) : req);
          expect(res.status).toBe(404);
          spec.assertSchema('Error', res.body);
          expect(res.body).toEqual({
            code: 'not_found',
            message: `${method.toUpperCase()} ${path} is not implemented`,
            details: {},
          });
        }
      }
      // still behind the publishable key
      expect((await request(proxied).put('/store/customers/me')).status).toBe(401);
      expect(seen).toEqual([]);
      // the proxy itself still works for a Store path the core does not answer
      const other = await call('get', '/store/wishlist');
      expect(other.body).toEqual({ mock: true });
      expect(seen).toEqual(['GET /store/wishlist']);
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
      // every function that accepts a verifier refuses it itself — no door past the seam
      expect(() => mountCustomerRoutes(express(), fakeVerifier)).toThrow(
        /never accepted in production/,
      );
      expect(() => getOrderRouteWith(fakeVerifier)).toThrow(/never accepted in production/);
      expect(() => mountCustomerRoutes(express())).not.toThrow();
      expect(() => getOrderRouteWith()).not.toThrow();
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
      // window 3's measurement: POST /store/carts with a bearer that is not a token answered 201
      const cart = await request(real)
        .post('/store/carts')
        .set('X-Publishable-Key', KEY_A)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(cart.status).toBe(401);
      spec.assertSchema('Error', cart.body);
    }
    expect(await customerCount()).toBe(before);
    // and without the header it is the guest cart it always was
    const guestCart = await request(real).post('/store/carts').set('X-Publishable-Key', KEY_A);
    expect(guestCart.status).toBe(201);
  });
});

// ---- live: docker Keycloak mints real customers-realm tokens. The seeded customer signs in through the dev-only
// test-cli password grant (stamps store_code=brand-a; her email is verified in the realm import); a second user
// self-registers through storefront-brand-a's registration form — the same flow as
// packages/auth-sdk/test/customer-claims.test.ts — and is therefore NOT verified (the dev realm has verifyEmail
// off). Skipped when Keycloak is down. Both tokens state `email_verified` through Keycloak's built-in email
// scope (true for her, false for the fresh user); the mapper of #313 only makes that explicit in the realm export.
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM = process.env.KEYCLOAK_REALM_CUSTOMERS ?? 'customers';
const TOKEN_URL = `${KC}/realms/${REALM}/protocol/openid-connect/token`;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
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

const rawClaims = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

async function seedCustomerToken(): Promise<string> {
  const grant = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      client_id: 'test-cli',
      grant_type: 'password',
      username: SEED_CUSTOMER,
      // dev-only seed user of the local realm import: the password is the local part
      password: SEED_CUSTOMER.split('@')[0]!,
    }),
  });
  const { access_token: token } = (await grant.json()) as { access_token?: string };
  if (!token) throw new Error(`no token for the seed customer: ${grant.status}`);
  return token;
}

// RFC 7636 appendix B pair.
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CALLBACK = 'http://localhost:3101/auth/callback';

/** Self-registers through storefront-brand-a's registration form and returns the new user's access token. */
async function registerAndSignIn(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const unescape = (s: string) => s.replace(/&amp;/g, '&');

  const authorize =
    `${KC}/realms/${REALM}/protocol/openid-connect/auth?client_id=storefront-brand-a` +
    `&response_type=code&scope=openid&redirect_uri=${encodeURIComponent(CALLBACK)}` +
    `&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256&state=t`;
  const loginPage = await fetch(authorize, { redirect: 'manual' });
  keep(loginPage);
  const registerHref = (await loginPage.text()).match(/href="([^"]*registration[^"]*)"/)?.[1];
  if (!registerHref) throw new Error('registration link not found on the login page');

  const formPage = await fetch(new URL(unescape(registerHref), KC), {
    redirect: 'manual',
    headers: { cookie: cookie() },
  });
  keep(formPage);
  const action = (await formPage.text()).match(/id="kc-register-form"[^>]*action="([^"]+)"/)?.[1];
  if (!action) throw new Error('registration form not found');

  const submitted = await fetch(unescape(action), {
    method: 'POST',
    redirect: 'manual',
    headers: { ...FORM, cookie: cookie() },
    body: new URLSearchParams({
      email,
      firstName: 'Fresh',
      lastName: 'Shopper',
      password,
      'password-confirm': password,
    }),
  });
  const location = submitted.headers.get('location') ?? '';
  if (submitted.status !== 302 || !location.startsWith(`${CALLBACK}?`)) {
    throw new Error(`registration did not reach the callback: ${submitted.status}`);
  }
  const code = new URL(location).searchParams.get('code')!;

  const exchanged = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'storefront-brand-a',
      code,
      redirect_uri: CALLBACK,
      code_verifier: PKCE_VERIFIER,
    }),
  });
  if (!exchanged.ok) throw new Error(`code exchange: ${exchanged.status}`);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

/** Best effort: removes a user this file registered, with the local bootstrap admin (as reimport.mjs does). */
async function deleteKeycloakUser(subject: string): Promise<void> {
  const admin = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: process.env.KEYCLOAK_ADMIN ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  if (!admin.ok) return;
  const { access_token: adminToken } = (await admin.json()) as { access_token: string };
  await fetch(`${KC}/admin/realms/${REALM}/users/${subject}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${adminToken}` },
  });
}

describe.runIf(live)('live: real customers-realm tokens through the real verifier', () => {
  let real: express.Express;
  let seedToken: string;
  const registered: string[] = [];
  const call = (token: string, path: string, key: string = KEY_A) =>
    request(real).get(path).set('X-Publishable-Key', key).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    real = express();
    mountCoreMiddleware(real, new DevTokenVerifier()); // no seam: auth-sdk verifies against Keycloak's JWKS
    seedToken = await seedCustomerToken();
  });

  afterAll(async () => {
    for (const subject of registered) await deleteKeycloakUser(subject).catch(() => undefined);
  });

  it('GET /store/customers/me provisions the Keycloak customer in brand-a; the same token is a 401 for brand-b', async () => {
    const me = await call(seedToken, '/store/customers/me');
    expect(me.status).toBe(200);
    spec.assertSchema('Customer', me.body);
    expect(me.body).toMatchObject({ email: SEED_CUSTOMER, status: 'registered' });
    expect((await call(seedToken, '/store/customers/me')).body).toEqual(me.body);

    const otherStore = await call(seedToken, '/store/customers/me', KEY_B);
    expect(otherStore.status).toBe(401);
    expect(otherStore.body.code).toBe('unauthorized');
  });

  it("the seeded customer's token reads verified: a guest order placed with her address is listed and opens by the token alone", async () => {
    expect(
      rawClaims(seedToken).email_verified,
      `the seed customer's token carries email_verified = ${JSON.stringify(rawClaims(seedToken).email_verified)} (expected the boolean true)`,
    ).toBe(true);
    const orderId = await placeGuestOrder('Jane@Example.com');

    const orders = await call(seedToken, '/store/customers/me/orders');
    expect(orders.status).toBe(200);
    spec.assertPage('OrderSummary', orders.body);
    expect(orders.body.items.map((o: { id: string }) => o.id)).toContain(orderId);

    const opened = await call(seedToken, `/store/orders/${orderId}`);
    expect(opened.status).toBe(200);
    spec.assertSchema('Order', opened.body);
  });

  it('a freshly self-registered user (email NOT verified) sees none: the order placed with their address is neither listed nor opened by the token', async () => {
    const email = `fresh-${randomUUID()}@example.com`;
    const token = await registerAndSignIn(email, `pw-${randomUUID()}`);
    const raw = rawClaims(token);
    registered.push(String(raw.sub));
    expect(raw.email_verified).toBe(false);
    const orderId = await placeGuestOrder(email);

    const me = await call(token, '/store/customers/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email, status: 'registered' });

    const orders = await call(token, '/store/customers/me/orders');
    expect(orders.status).toBe(200);
    expect(orders.body).toMatchObject({ total: 0, items: [] });
    expect((await call(token, `/store/orders/${orderId}`)).status).toBe(404);

    // the self-service routes of part B with a real token
    const renamed = await request(real)
      .patch('/store/customers/me')
      .set('X-Publishable-Key', KEY_A)
      .set('Authorization', `Bearer ${token}`)
      .send({ first_name: 'Fresh', last_name: 'Shopper' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ first_name: 'Fresh', last_name: 'Shopper' });
    const added = await request(real)
      .post('/store/customers/me/addresses')
      .set('X-Publishable-Key', KEY_A)
      .set('Authorization', `Bearer ${token}`)
      .send(address);
    expect(added.status).toBe(201);
    spec.assertSchema('CustomerAddress', added.body);
    expect(added.body).toMatchObject({ is_default_shipping: true, is_default_billing: true });
    const mine = await call(token, '/store/customers/me/addresses');
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual([added.body.id]);
    // the guest rule is unchanged: order id + checkout email opens it, token or not
    const byEmail = await call(
      token,
      `/store/orders/${orderId}?email=${encodeURIComponent(email)}`,
    );
    expect(byEmail.status).toBe(200);

    // part C with a real token: an order placed WITH the token is the customer's — listed and opened by the
    // token alone, although the email is not verified and the checkout email is someone else's
    const linkedCart = await readyCartOn(real, 'a.friend@example.com', token);
    const placed = await completeOn(real, linkedCart, token);
    expect(placed.status).toBe(201);
    const after = await call(token, '/store/customers/me/orders');
    expect(after.body).toMatchObject({ total: 1 });
    expect(after.body.items[0].id).toBe(placed.body.id);
    expect((await call(token, `/store/orders/${placed.body.id}`)).status).toBe(200);
    // and the seeded customer's valid token does not open it
    expect((await call(seedToken, `/store/orders/${placed.body.id}`)).status).toBe(404);
  });
});
