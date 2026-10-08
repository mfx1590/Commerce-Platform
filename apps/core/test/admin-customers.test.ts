// Admin API customer routes (#414, Admin API 0.4.11): list / get / update / addresses / groups through the full
// middleware chain with dev tokens (role_assignment stub), spec-validated responses, tenant isolation.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminNotFound, coreErrorHandler, DevTokenVerifier } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { customerEmailHash } from '../src/modules/customers';
import { inMemoryStoreRegistrar } from '../src/modules/registry';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const spec = specValidator('admin-api.yaml');

// test-only rows (uuids in a range nothing else uses)
const JANE = '50000000-0000-4000-8000-000000000001'; // brand-a, registered, VIP
const JOHN = '50000000-0000-4000-8000-000000000002'; // brand-a, guest
const BOB = '50000000-0000-4000-8000-000000000003'; // brand-b
const VIP_A = '50000000-0000-4000-8000-000000000101';
const VIP_B = '50000000-0000-4000-8000-000000000102';
const A_ONLY_ADMIN = '50000000-0000-4000-8000-000000000201';

let db: TestDatabase;
let app: express.Express;

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
});
const support = as('seed-support');
const storeAdmin = as('seed-store-admin');
const storeStaff = as('seed-store-staff');
const analyst = as('seed-analyst');
const aOnlyAdmin = as('test-a-only-admin');

beforeAll(async () => {
  db = await createTestDatabase('core_admin_customers');
  await seed(db.owner, { productsPerStore: 1, log: () => {} });
  await db.owner.query(
    `INSERT INTO customer_group (id, organization_id, store_id, code, name) VALUES
       ($1, $3, $4, 'vip', 'VIP'), ($2, $3, $5, 'vip', 'VIP')`,
    [VIP_A, VIP_B, ORG, A, B],
  );
  await db.owner.query(
    `INSERT INTO customer (id, organization_id, store_id, email, first_name, last_name, phone, status, customer_group_id, consent, created_at)
     VALUES ($1, $4, $5, 'jane@example.com', 'Jane', 'Doe', '+31600000001', 'registered', $7,
             '{"marketing_email": {"granted": true, "source": "storefront"}}', now() - interval '2 days'),
            ($2, $4, $5, 'john@example.com', 'John', 'Smith', NULL, 'guest', NULL, '{}', now() - interval '1 day'),
            ($3, $4, $6, 'bob@example.com', 'Bob', 'Brown', NULL, 'registered', NULL, '{}', now())`,
    [JANE, JOHN, BOB, ORG, A, B, VIP_A],
  );
  await db.owner.query(
    `INSERT INTO customer_address (organization_id, store_id, customer_id, first_name, last_name, line1, city, postal_code, country, is_default_shipping, is_default_billing)
     VALUES ($1, $2, $3, 'Jane', 'Doe', 'Main 1', 'Amsterdam', '1011AA', 'NL', true, true),
            ($1, $2, $3, 'Jane', 'Doe', 'Side 2', 'Utrecht', '3511AA', 'NL', false, false)`,
    [ORG, A, JANE],
  );
  // a store admin of brand-a ONLY (the seeded one has both brands)
  await db.owner.query(
    `INSERT INTO staff_user (id, organization_id, keycloak_subject, email, display_name)
     VALUES ($1, $2, 'test-a-only-admin', 'a-only@example.com', 'A only')`,
    [A_ONLY_ADMIN, ORG],
  );
  await db.owner.query(
    `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
     VALUES ($1, $2, 'store_admin', 'store', $3)`,
    [ORG, A_ONLY_ADMIN, A],
  );

  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), { storeRegistrar: inMemoryStoreRegistrar() });
  app.use('/admin', adminNotFound);
  app.use(coreErrorHandler);
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('listCustomers / getCustomer (#414)', () => {
  it('support lists a store’s customers as a contract Page, newest first by default', async () => {
    const res = await support.get(`/admin/stores/${A}/customers`);
    expect(res.status).toBe(200);
    spec.assertPage('Customer', res.body);
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(res.body.items.map((c: { id: string }) => c.id)).toEqual([JOHN, JANE]);
    expect(res.body.items[1]).toMatchObject({
      email: 'jane@example.com',
      status: 'registered',
      customer_group_id: VIP_A,
      consent: { marketing_email: { granted: true } },
    });
  });

  it('filters by q (email or name, case-insensitive) and group_id; sorts and pages; 400 on bad params', async () => {
    expect(
      (await support.get(`/admin/stores/${A}/customers?q=SMITH`)).body.items.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([JOHN]);
    expect((await support.get(`/admin/stores/${A}/customers?q=jane@`)).body.total).toBe(1);
    expect((await support.get(`/admin/stores/${A}/customers?q=50%25`)).body.total).toBe(0); // % is literal
    expect(
      (await support.get(`/admin/stores/${A}/customers?group_id=${VIP_A}`)).body.items.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([JANE]);
    const byName = await support.get(
      `/admin/stores/${A}/customers?sort=last_name&order=asc&limit=1&page=2`,
    );
    expect(byName.body).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect(byName.body.items.map((c: { id: string }) => c.id)).toEqual([JOHN]); // Doe, then Smith
    const bad = await support.get(`/admin/stores/${A}/customers?sort=phone&group_id=x`);
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.details).sort()).toEqual(['group_id', 'sort']);
  });

  it('getCustomer: 200 Customer; another store’s customer through this store’s path is a 404', async () => {
    const res = await support.get(`/admin/stores/${A}/customers/${JANE}`);
    expect(res.status).toBe(200);
    spec.assertSchema('Customer', res.body);
    expect((await support.get(`/admin/stores/${A}/customers/${BOB}`)).status).toBe(404);
    expect((await support.get(`/admin/stores/${A}/customers/not-a-uuid`)).status).toBe(400);
  });

  it('permissions: support and store_admin read; store_staff and analyst get 403; a brand-a admin cannot reach brand-b', async () => {
    expect((await storeAdmin.get(`/admin/stores/${A}/customers`)).status).toBe(200);
    expect((await storeStaff.get(`/admin/stores/${A}/customers`)).status).toBe(403);
    expect((await analyst.get(`/admin/stores/${A}/customers/${JANE}`)).status).toBe(403);
    expect((await aOnlyAdmin.get(`/admin/stores/${A}/customers`)).status).toBe(200);
    expect((await aOnlyAdmin.get(`/admin/stores/${B}/customers`)).status).toBe(403);
    expect((await aOnlyAdmin.get(`/admin/stores/${B}/customers/${BOB}`)).status).toBe(403);
  });
});

describe('listCustomerAddresses / listCustomerGroups (#414)', () => {
  it('addresses: defaults first, contract shape; 404 for another store’s customer', async () => {
    const res = await support.get(`/admin/stores/${A}/customers/${JANE}/addresses`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      line1: 'Main 1',
      is_default_shipping: true,
      is_default_billing: true,
    });
    for (const a of res.body.items) spec.assertSchema('Address', a);
    expect((await support.get(`/admin/stores/${A}/customers/${BOB}/addresses`)).status).toBe(404);
  });

  it('groups: viewer may list, only this store’s', async () => {
    const res = await analyst.get(`/admin/stores/${A}/customer-groups`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ id: VIP_A, code: 'vip', name: 'VIP' }] });
  });
});

describe('updateCustomer (#414)', () => {
  const events = async (id: string) =>
    (
      await db.owner.query<{ topic: string; payload: Record<string, unknown> }>(
        `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
        [id],
      )
    ).rows;

  it('names, phone, group and status: one customer.updated with the sorted fields, no PII in audit or event', async () => {
    const res = await support.patch(`/admin/stores/${A}/customers/${JANE}`, {
      first_name: ' Janet ',
      phone: '',
      customer_group_id: null,
      status: 'disabled',
    });
    expect(res.status).toBe(200);
    spec.assertSchema('Customer', res.body);
    expect(res.body).toMatchObject({
      first_name: 'Janet',
      phone: null,
      customer_group_id: null,
      status: 'disabled',
    });

    const ev = await events(JANE);
    expect(ev.map((e) => e.topic)).toEqual(['customer.updated']);
    expect(ev[0]!.payload).toMatchObject({
      customer_id: JANE,
      email_hash: customerEmailHash('jane@example.com'),
      status: 'disabled',
      customer_group_id: null,
      marketing_consent: true,
      changed_fields: ['customer_group_id', 'first_name', 'phone', 'status'],
    });
    const audit = await db.owner.query(
      `SELECT action, before, after FROM audit_log WHERE entity_id = $1`,
      [JANE],
    );
    const text = JSON.stringify(audit.rows) + JSON.stringify(ev);
    for (const pii of ['jane@example.com', 'Janet', 'Jane', '+31600000001'])
      expect(text).not.toContain(pii);

    // the same patch again changes nothing and writes nothing
    await support.patch(`/admin/stores/${A}/customers/${JANE}`, {
      first_name: 'Janet',
      status: 'disabled',
    });
    expect(await events(JANE)).toHaveLength(1);
  });

  it('group of another store is a 400; a guest has no account to (dis)able (400); unknown / foreign customer 404; analyst 403', async () => {
    const foreignGroup = await support.patch(`/admin/stores/${A}/customers/${JOHN}`, {
      customer_group_id: VIP_B,
    });
    expect(foreignGroup.status).toBe(400);
    expect(foreignGroup.body.details).toEqual({ customer_group_id: 'not a group of this store' });
    expect(
      (await support.patch(`/admin/stores/${A}/customers/${JOHN}`, { status: 'registered' }))
        .status,
    ).toBe(400);
    expect(
      (await support.patch(`/admin/stores/${A}/customers/${BOB}`, { first_name: 'X' })).status,
    ).toBe(404);
    expect(
      (await support.patch(`/admin/stores/${A}/customers/${JOHN}`, { status: 'erased' })).status,
    ).toBe(400); // schema enum
    expect(
      (await analyst.patch(`/admin/stores/${A}/customers/${JOHN}`, { first_name: 'X' })).status,
    ).toBe(403);
    expect(await events(JOHN)).toEqual([]);
  });
});
