// Admin API customer routes (#414, Admin API 0.4.11): list / get / update / addresses / groups through the full
// middleware chain with dev tokens (role_assignment stub), spec-validated responses, tenant isolation.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminNotFound, coreErrorHandler, DevTokenVerifier } from '../src/http';
import { closePool, initDb, tenantClient } from '../src/lib/db';
import { buildCustomerExport, customerEmailHash } from '../src/modules/customers';
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

describe('eraseCustomer / buildCustomerExport (#414, GDPR)', () => {
  const ERIN = '50000000-0000-4000-8000-000000000011'; // brand-a, identity shared with brand-b's Erin
  const ERIN_B = '50000000-0000-4000-8000-000000000012'; // brand-b, same person
  const OLLIE = '50000000-0000-4000-8000-000000000013'; // brand-a, identity only here
  const SHARED_ID = '50000000-0000-4000-8000-000000000301';
  const OWN_ID = '50000000-0000-4000-8000-000000000302';
  const post = (subject: string, path: string) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send({});
  const clientFor = (storeId: string) => tenantClient({ organizationId: ORG, storeIds: [storeId] });

  /** One placed order for a customer, with one line (a fixture: money columns only, no checkout). */
  async function order(storeId: string, customerId: string, email: string): Promise<string> {
    const channel = await db.owner.query<{ id: string }>(
      'SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY code LIMIT 1',
      [storeId],
    );
    const addr = JSON.stringify({
      first_name: 'E',
      last_name: 'R',
      line1: 'Main 1',
      city: 'Amsterdam',
      postal_code: '1011AA',
      country: 'NL',
    });
    const o = await db.owner.query<{ id: string }>(
      `INSERT INTO "order" (organization_id, store_id, sales_channel_id, customer_id, email, currency, locale,
                            shipping_address, billing_address, subtotal_minor, total_minor)
       VALUES ($1, $2, $3, $4, $5, 'EUR', 'en-GB', $6, $6, 2500, 2500) RETURNING id`,
      [ORG, storeId, channel.rows[0]!.id, customerId, email, addr],
    );
    await db.owner.query(
      `INSERT INTO order_line_item (organization_id, store_id, order_id, sku, title, variant_title, quantity,
                                    unit_price_minor, total_minor)
       VALUES ($1, $2, $3, 'TEE-M', 'Tee', 'M', 1, 2500, 2500)`,
      [ORG, storeId, o.rows[0]!.id],
    );
    return o.rows[0]!.id;
  }

  beforeAll(async () => {
    await db.owner.query(
      'INSERT INTO customer_identity (id, organization_id, email_hash) VALUES ($1, $3, $4), ($2, $3, $5)',
      [
        SHARED_ID,
        OWN_ID,
        ORG,
        customerEmailHash('erin@example.com'),
        customerEmailHash('ollie@example.com'),
      ],
    );
    await db.owner.query(
      `INSERT INTO customer (id, organization_id, store_id, identity_id, keycloak_subject, email, first_name,
                             last_name, phone, status, consent, metadata)
       VALUES ($1, $4, $5, $7, 'kc-erin', 'erin@example.com', 'Erin', 'Rae', '+31611111111', 'registered',
               '{"marketing_email": {"granted": true}}', '{"tags": ["vip"]}'),
              ($2, $4, $6, $7, 'kc-erin', 'erin@example.com', 'Erin', 'Rae', NULL, 'registered', '{}', '{}'),
              ($3, $4, $5, $8, NULL, 'ollie@example.com', 'Ollie', 'Oak', NULL, 'guest', '{}', '{}')`,
      [ERIN, ERIN_B, OLLIE, ORG, A, B, SHARED_ID, OWN_ID],
    );
    await db.owner.query(
      `INSERT INTO customer_address (organization_id, store_id, customer_id, first_name, last_name, line1, city,
                                     postal_code, country, is_default_shipping, is_default_billing)
       VALUES ($1, $2, $3, 'Erin', 'Rae', 'Canal 9', 'Amsterdam', '1015AA', 'NL', true, true),
              ($1, $4, $5, 'Erin', 'Rae', 'Other 3', 'Rotterdam', '3011AA', 'NL', true, true)`,
      [ORG, A, ERIN, B, ERIN_B],
    );
  });

  it('export: only that customer in that store — the record, addresses, consent and orders with lines', async () => {
    const mine = await order(A, ERIN, 'erin@example.com');
    await order(B, ERIN_B, 'erin@example.com'); // the same person in brand-b: never in brand-a's export
    await order(A, OLLIE, 'ollie@example.com'); // another customer of the same store: never in Erin's export
    const bundle = await buildCustomerExport(clientFor(A), A, ERIN);
    expect(bundle).toMatchObject({
      format: 'customer-export/v1',
      store_id: A,
      customer: { id: ERIN, email: 'erin@example.com', first_name: 'Erin', phone: '+31611111111' },
      consent: { marketing_email: { granted: true } },
    });
    expect(bundle.addresses.map((a) => a.line1)).toEqual(['Canal 9']);
    expect(bundle.orders.map((o) => o.id)).toEqual([mine]);
    expect(bundle.orders[0]).toMatchObject({
      total_minor: 2500,
      lines: [{ sku: 'TEE-M', quantity: 1, total_minor: 2500 }],
    });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('Other 3');
    expect(text).not.toContain('ollie@example.com');
    // through brand-b's client the brand-a customer does not exist
    await expect(buildCustomerExport(clientFor(B), B, ERIN)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('erase (store_admin, 202): no PII left; orders kept; one customer.erased; replay is a no-op', async () => {
    expect((await post('seed-support', `/admin/stores/${A}/customers/${ERIN}/erase`)).status).toBe(
      403,
    );
    const res = await post('seed-store-admin', `/admin/stores/${A}/customers/${ERIN}/erase`);
    expect(res.status).toBe(202);
    expect(res.text).toBe('');

    const row = (await db.owner.query('SELECT * FROM customer WHERE id = $1', [ERIN])).rows[0];
    expect(row).toMatchObject({
      status: 'erased',
      email: `erased+${ERIN}@invalid`,
      first_name: null,
      last_name: null,
      phone: null,
      keycloak_subject: null,
      identity_id: null,
      consent: {},
      metadata: {},
    });
    const addresses = await db.owner.query(
      'SELECT 1 FROM customer_address WHERE customer_id = $1',
      [ERIN],
    );
    expect(addresses.rowCount).toBe(0);
    // the identity is still used by brand-b's Erin: unlinked here, kept there
    const shared = await db.owner.query('SELECT 1 FROM customer_identity WHERE id = $1', [
      SHARED_ID,
    ]);
    expect(shared.rowCount).toBe(1);
    const other = await db.owner.query('SELECT identity_id FROM customer WHERE id = $1', [ERIN_B]);
    expect(other.rows[0].identity_id).toBe(SHARED_ID);
    // orders untouched and still linked by customer id (legal retention, decision A)
    const orders = await db.owner.query(
      'SELECT email, total_minor FROM "order" WHERE customer_id = $1',
      [ERIN],
    );
    expect(orders.rows).toEqual([{ email: 'erin@example.com', total_minor: '2500' }]);

    const ev = await db.owner.query<{ topic: string; payload: Record<string, unknown> }>(
      'SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq',
      [ERIN],
    );
    expect(ev.rows.map((e) => e.topic)).toEqual(['customer.erased']);
    expect(ev.rows[0]!.payload).toMatchObject({ customer_id: ERIN, identity_id: SHARED_ID });
    const audit = await db.owner.query('SELECT action, after FROM audit_log WHERE entity_id = $1', [
      ERIN,
    ]);
    expect(audit.rows).toEqual([
      {
        action: 'customer.erase',
        after: {
          status: 'erased',
          addresses_deleted: 1,
          identity_unlinked: true,
          identity_deleted: false,
        },
      },
    ]);
    const written = JSON.stringify(audit.rows) + JSON.stringify(ev.rows);
    for (const pii of ['erin@example.com', 'Erin', 'Rae', '+31611111111'])
      expect(written).not.toContain(pii);

    // replay: 202, nothing more written; the erased record stays readable, not updatable, not exportable
    expect(
      (await post('seed-store-admin', `/admin/stores/${A}/customers/${ERIN}/erase`)).status,
    ).toBe(202);
    const events = await db.owner.query('SELECT 1 FROM outbox WHERE aggregate_id = $1', [ERIN]);
    expect(events.rowCount).toBe(1);
    const read = await support.get(`/admin/stores/${A}/customers/${ERIN}`);
    expect(read.status).toBe(200);
    spec.assertSchema('Customer', read.body);
    expect(read.body).toMatchObject({
      status: 'erased',
      email: `erased+${ERIN}@invalid`,
      first_name: null,
    });
    expect(
      (await support.patch(`/admin/stores/${A}/customers/${ERIN}`, { first_name: 'X' })).status,
    ).toBe(404);
    await expect(buildCustomerExport(clientFor(A), A, ERIN)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('erase deletes an identity nothing else references; a brand-a admin cannot erase in brand-b; unknown → 404', async () => {
    expect(
      (await post('seed-store-admin', `/admin/stores/${A}/customers/${OLLIE}/erase`)).status,
    ).toBe(202);
    const own = await db.owner.query('SELECT 1 FROM customer_identity WHERE id = $1', [OWN_ID]);
    expect(own.rowCount).toBe(0);
    expect(
      (await post('test-a-only-admin', `/admin/stores/${B}/customers/${ERIN_B}/erase`)).status,
    ).toBe(403);
    expect(
      (await post('seed-store-admin', `/admin/stores/${A}/customers/${ERIN_B}/erase`)).status,
    ).toBe(404);
    const untouched = await db.owner.query('SELECT status FROM customer WHERE id = $1', [ERIN_B]);
    expect(untouched.rows[0].status).toBe('registered');
  });
});
