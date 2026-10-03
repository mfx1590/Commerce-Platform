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
  CUSTOMER_STORE_PATHS,
  customerTokenVerifierFor,
  DevTokenVerifier,
  keycloakCustomerTokenVerifier,
  mountStoreRoutes,
  REAL_STORE_PATHS,
  type CustomerTokenVerifier,
} from '../src/http';
import { mountCustomerRoutes } from '../src/http/customer-routes';
import { getOrderRouteWith } from '../src/http/store-routes';
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
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = logged.join('\n').toLowerCase();
    for (const secret of [
      '@example.test',
      'janet',
      'bearer',
      'sub-jane',
      'mallory',
      'secretstreet',
      'hiddentown',
      '6 7777',
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
      const call = (method: 'get' | 'post' | 'patch', path: string) =>
        request(proxied)
          [method](path)
          .set('X-Publishable-Key', KEY_A)
          .set('Authorization', 'Bearer jane');
      // every customer path is answered here — the bearer token never reaches the mock
      for (const res of [
        await call('get', '/store/customers/me'),
        await call('patch', '/store/customers/me').send({ first_name: 'Jane' }),
        await call('get', '/store/customers/me/orders'),
        await call('get', '/store/customers/me/addresses'),
        await call('post', '/store/customers/me/addresses').send(address),
        await call('post', '/store/customers').send({ email: 'jane@example.test' }),
      ]) {
        expect(res.status).toBeLessThan(300);
        expect(res.body.mock).toBeUndefined();
      }
      expect(seen).toEqual([]);
      // an operation the contract does not define under /store/customers is a 404 from the core — with or
      // without a bearer, and the mock never sees it (no 405, no new error code)
      const undefinedOperations: Array<['put' | 'delete' | 'get' | 'patch' | 'post', string]> = [
        ['put', '/store/customers/me'],
        ['delete', '/store/customers/me'],
        ['put', '/store/customers'],
        ['delete', '/store/customers/me/addresses'],
        ['patch', '/store/customers/me/orders'],
        ['get', '/store/customers'],
        ['get', '/store/customers/me/unknown'],
        ['delete', '/store/customers/me/addresses/00000000-0000-4000-8000-000000000001'],
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
    }
    expect(await customerCount()).toBe(before);
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
  });
});
