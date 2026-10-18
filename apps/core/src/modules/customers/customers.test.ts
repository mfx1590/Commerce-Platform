// Customers module (#303): resolve-or-provision from a verified token, register, the email collision rule,
// disabled / erased, and what reaches the outbox and the audit log. Runs as platform_app (RLS enforced) over a
// seeded throwaway database. The seed has no customers, so every row here is made by the test. Keys are words.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { segmentQuery, type SegmentRules } from '../marketing';
import {
  ADDRESS_LIMIT,
  addCustomerAddress,
  buildCustomerExport,
  buildPendingExports,
  claimExportRequests,
  customerEmailHash,
  deleteCustomerAddress,
  eraseCustomer,
  eraseMe,
  findCustomerForSubject,
  getMyConsents,
  getMyExport,
  listCustomerAddresses,
  listMyExports,
  purgeExpiredExports,
  requestCustomerExport,
  putMyConsents,
  registerCustomer,
  resolveCustomer,
  updateCustomer,
  updateCustomerAddress,
  type AddressInput,
  type CustomerIdentity,
  type CustomerScope,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

let db: TestDatabase;
let owner: ReturnType<typeof createOrganizationClient>;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;

const scopeA: CustomerScope = { organizationId: ORG, storeId: A, requestId: 'req-customers' };
const scopeB: CustomerScope = { organizationId: ORG, storeId: B, requestId: 'req-customers' };

const who = (name: string, over: Partial<CustomerIdentity> = {}): CustomerIdentity => ({
  subject: `sub-${name}`,
  email: `${name}@example.test`,
  emailVerified: false,
  ...over,
});

beforeAll(async () => {
  db = await createTestDatabase('core_customers');
  await seed(db.owner, { productsPerStore: 1, log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

const events = async (customerId: string) =>
  (
    await owner.query<{ topic: string; store_id: string; payload: Record<string, unknown> }>(
      `SELECT topic, store_id, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [customerId],
    )
  ).rows;

const audits = async (customerId: string) =>
  (
    await owner.query<{
      action: string;
      actor_id: string | null;
      actor_type: string;
      store_id: string;
      request_id: string | null;
      before: unknown;
      after: Record<string, unknown> | null;
    }>(
      `SELECT action, actor_id, actor_type, store_id, request_id, before, after
       FROM audit_log WHERE entity_type = 'customer' AND entity_id = $1 ORDER BY created_at, id`,
      [customerId],
    )
  ).rows;

const rowsOf = async (storeId: string, email: string) =>
  (
    await owner.query<{
      id: string;
      keycloak_subject: string | null;
      email: string;
      status: string;
      consent: Record<string, unknown>;
      first_name: string | null;
    }>(
      `SELECT id, keycloak_subject, email, status, consent, first_name FROM customer
       WHERE store_id = $1 AND lower(email) = lower($2) ORDER BY created_at`,
      [storeId, email],
    )
  ).rows;

const totals = async () => {
  const r = await owner.query<{ customers: string; events: string; audits: string }>(
    `SELECT (SELECT count(*) FROM customer)::text AS customers,
            (SELECT count(*) FROM outbox WHERE aggregate_type = 'customer')::text AS events,
            (SELECT count(*) FROM audit_log WHERE entity_type = 'customer')::text AS audits`,
  );
  return r.rows[0]!;
};

async function insertRow(
  storeId: string,
  email: string,
  over: { subject?: string | null; status?: string } = {},
): Promise<string> {
  const r = await owner.query<{ id: string }>(
    `INSERT INTO customer (organization_id, store_id, keycloak_subject, email, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ORG, storeId, over.subject ?? null, email, over.status ?? 'guest'],
  );
  return r.rows[0]!.id;
}

describe('resolve-or-provision (every /me operation starts here)', () => {
  it('creates the row on first use from the token — once: one customer.created, one audit row; a second call writes nothing', async () => {
    const ada = who('ada', { email: '  Ada@Example.TEST ' });
    const first = await resolveCustomer(a, scopeA, ada);
    expect(first).toEqual({
      id: first.id,
      email: 'ada@example.test',
      first_name: null,
      last_name: null,
      phone: null,
      status: 'registered',
      marketing_consent: false,
    });
    const stored = await rowsOf(A, 'ada@example.test');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: first.id, keycloak_subject: 'sub-ada', consent: {} });

    expect(await events(first.id)).toEqual([
      {
        topic: 'customer.created',
        store_id: A,
        payload: {
          customer_id: first.id,
          identity_id: null,
          email_hash: customerEmailHash('ada@example.test'),
          status: 'registered',
          customer_group_id: null,
          marketing_consent: false,
        },
      },
    ]);
    expect(await audits(first.id)).toEqual([
      {
        action: 'customer.create',
        actor_id: first.id,
        actor_type: 'customer',
        store_id: A,
        request_id: 'req-customers',
        before: null,
        after: { status: 'registered', marketing_consent: false },
      },
    ]);

    const before = await totals();
    expect(await resolveCustomer(a, scopeA, ada)).toEqual(first);
    expect(await totals()).toEqual(before);
  });

  it('concurrent first requests of one subject: one row, one event, one audit row, the same customer for everyone', async () => {
    const grace = who('grace');
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => resolveCustomer(a, scopeA, grace)),
    );
    expect(settled.map((s) => s.status)).toEqual(Array(8).fill('fulfilled'));
    const ids = new Set(settled.map((s) => (s as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
    const [id] = [...ids] as [string];
    expect(await rowsOf(A, 'grace@example.test')).toHaveLength(1);
    expect((await events(id)).map((e) => e.topic)).toEqual(['customer.created']);
    expect((await audits(id)).map((x) => x.action)).toEqual(['customer.create']);
  });

  it('customers never cross stores: the same subject and email in another store is another row', async () => {
    const ada = who('ada');
    const inA = await resolveCustomer(a, scopeA, ada);
    const inB = await resolveCustomer(b, scopeB, ada);
    expect(inB.id).not.toBe(inA.id);
    expect((await events(inB.id))[0]).toMatchObject({ topic: 'customer.created', store_id: B });
    // a store client cannot see the other store's customer at all
    expect(await findCustomerForSubject(b, A, 'sub-ada')).toBeNull();
    expect(await findCustomerForSubject(a, A, 'sub-ada')).toEqual({
      id: inA.id,
      status: 'registered',
    });
  });

  it('a token without an email reads an existing customer but cannot create one (401)', async () => {
    const before = await totals();
    await expect(
      resolveCustomer(a, scopeA, { subject: 'sub-nomail', emailVerified: false }),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect(await totals()).toEqual(before);
    const ada = await resolveCustomer(a, scopeA, who('ada'));
    expect(await resolveCustomer(a, scopeA, { subject: 'sub-ada', emailVerified: false })).toEqual(
      ada,
    );
  });

  it('disabled and erased customers are a 401 and are never provisioned again', async () => {
    await insertRow(A, 'disabled@example.test', { subject: 'sub-disabled', status: 'disabled' });
    await insertRow(A, 'gone@example.test', { subject: 'sub-erased', status: 'erased' });
    const before = await totals();
    for (const identity of [
      who('disabled', { emailVerified: true }),
      // an erased row whose token now carries another email must not get a fresh row either
      { subject: 'sub-erased', email: 'new-address@example.test', emailVerified: true },
    ]) {
      await expect(resolveCustomer(a, scopeA, identity)).rejects.toMatchObject({
        code: 'unauthorized',
      });
      await expect(
        registerCustomer(a, scopeA, identity, { email: identity.email! }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    }
    expect(await totals()).toEqual(before);
    // a disabled row WITHOUT a subject is not adopted either, even with a verified email
    await insertRow(A, 'frozen@example.test', { status: 'disabled' });
    await expect(
      resolveCustomer(a, scopeA, who('frozen', { emailVerified: true })),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await rowsOf(A, 'frozen@example.test'))[0]!.keycloak_subject).toBeNull();
  });
});

describe('registerCustomer', () => {
  it('201-shaped on creation: names and consent land in the one customer.created; then 200-shaped updates name what changed', async () => {
    const linus = who('linus');
    const created = await registerCustomer(a, scopeA, linus, {
      email: ' Linus@example.test ',
      first_name: 'Linus',
      last_name: 'T',
      marketing_consent: true,
    });
    expect(created.created).toBe(true);
    expect(created.customer).toMatchObject({
      email: 'linus@example.test',
      first_name: 'Linus',
      last_name: 'T',
      status: 'registered',
      marketing_consent: true,
    });
    const id = created.customer.id;
    expect((await events(id)).map((e) => [e.topic, e.payload.marketing_consent])).toEqual([
      ['customer.created', true],
    ]);
    const consent = (await rowsOf(A, 'linus@example.test'))[0]!.consent as {
      marketing_email: { granted: boolean; at: string; source: string };
    };
    expect(consent.marketing_email).toMatchObject({ granted: true, source: 'storefront' });
    expect(Number.isNaN(Date.parse(consent.marketing_email.at))).toBe(false);

    const again = await registerCustomer(a, scopeA, linus, {
      email: 'linus@example.test',
      first_name: 'Linus',
      last_name: 'Torvalds',
      marketing_consent: false,
    });
    expect(again.created).toBe(false);
    expect(again.customer).toMatchObject({
      id,
      last_name: 'Torvalds',
      marketing_consent: false,
    });
    const after = await events(id);
    expect(after.map((e) => e.topic)).toEqual(['customer.created', 'customer.updated']);
    expect(after[1]!.payload).toMatchObject({
      customer_id: id,
      marketing_consent: false,
      changed_fields: ['last_name', 'marketing_consent'],
    });
    expect((await audits(id)).map((x) => [x.action, x.after])).toEqual([
      ['customer.create', { status: 'registered', marketing_consent: true }],
      [
        'customer.update',
        {
          status: 'registered',
          marketing_consent: false,
          changed_fields: ['last_name', 'marketing_consent'],
        },
      ],
    ]);

    // an identical repeat changes nothing and writes nothing
    const before = await totals();
    const same = await registerCustomer(a, scopeA, linus, {
      email: 'linus@example.test',
      last_name: 'Torvalds',
    });
    expect(same).toEqual({ customer: again.customer, created: false });
    expect(await totals()).toEqual(before);
  });

  it('the body email is a confirmation, never an input: a different one is a 400 and nothing is written', async () => {
    const before = await totals();
    await expect(
      registerCustomer(a, scopeA, who('margaret'), { email: 'someone.else@example.test' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { email: 'must equal the email of the customer token' },
    });
    expect(await totals()).toEqual(before);
    expect(await rowsOf(A, 'someone.else@example.test')).toEqual([]);
    expect(await rowsOf(A, 'margaret@example.test')).toEqual([]);
  });

  it('a "false" on a customer who was never asked IS recorded (#471 — a refusal is a decision; this changes #303\'s rule): one ledger row, the projection block, source storefront, the store\'s policy version', async () => {
    const { customer } = await registerCustomer(a, scopeA, who('barbara'), {
      email: 'barbara@example.test',
      marketing_consent: false,
    });
    expect(customer.marketing_consent).toBe(false);
    expect((await rowsOf(A, 'barbara@example.test'))[0]!.consent).toEqual({
      marketing_email: { granted: false, at: expect.any(String), source: 'storefront' },
    });
    const ledger = await owner.query(
      `SELECT purpose, granted, source, policy_version FROM customer_consent WHERE customer_id = $1`,
      [customer.id],
    );
    // brand-a's seed has no settings.privacy.policy_version: the core records "unversioned"
    expect(ledger.rows).toEqual([
      {
        purpose: 'marketing_email',
        granted: false,
        source: 'storefront',
        policy_version: 'unversioned',
      },
    ]);
    const ev = await events(customer.id);
    expect(ev[0]!.payload).toMatchObject({ marketing_consent: false });
  });
});

describe('email collision: the token email is already on a row of this store', () => {
  it('verified email + a row without a subject → the row is adopted (one customer.updated, one audit row, no new row)', async () => {
    const guestId = await insertRow(A, 'Guest.Shopper@example.test');
    const before = await totals();
    const identity = who('guest.shopper', { subject: 'sub-guest', emailVerified: true });
    const me = await resolveCustomer(a, scopeA, identity);
    expect(me).toMatchObject({ id: guestId, status: 'registered' });
    const stored = await rowsOf(A, 'guest.shopper@example.test');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: guestId, keycloak_subject: 'sub-guest' });
    expect(await events(guestId)).toEqual([
      {
        topic: 'customer.updated',
        store_id: A,
        payload: {
          customer_id: guestId,
          identity_id: null,
          email_hash: customerEmailHash('guest.shopper@example.test'),
          status: 'registered',
          customer_group_id: null,
          marketing_consent: false,
          changed_fields: ['keycloak_subject', 'status'],
        },
      },
    ]);
    expect((await audits(guestId)).map((x) => [x.action, x.after])).toEqual([
      [
        'customer.link',
        {
          status: 'registered',
          marketing_consent: false,
          changed_fields: ['keycloak_subject', 'status'],
        },
      ],
    ]);
    const after = await totals();
    expect(Number(after.customers)).toBe(Number(before.customers));
    expect(Number(after.events)).toBe(Number(before.events) + 1);
    // from now on it is simply this subject's customer
    expect(await resolveCustomer(a, scopeA, identity)).toEqual(me);
    expect(await totals()).toEqual(after);
  });

  it('rows that differ only by letter case: a verified token adopts NEITHER — 409, nothing written (no guess which one is the person)', async () => {
    // UNIQUE (store_id, email) is case-sensitive, so both rows can exist; the lookup is case-insensitive.
    const upper = await insertRow(A, 'Case.Twin@example.test');
    const lower = await insertRow(A, 'case.twin@example.test');
    const before = await totals();
    const identity = who('case.twin', { subject: 'sub-twin', emailVerified: true });
    await expect(resolveCustomer(a, scopeA, identity)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: {},
    });
    await expect(
      registerCustomer(a, scopeA, identity, { email: 'case.twin@example.test' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await totals()).toEqual(before);
    const stored = await rowsOf(A, 'case.twin@example.test');
    expect(stored.map((r) => r.id).sort()).toEqual([upper, lower].sort());
    expect(stored.map((r) => [r.keycloak_subject, r.status])).toEqual([
      [null, 'guest'],
      [null, 'guest'],
    ]);
    expect(await events(upper)).toEqual([]);
    expect(await events(lower)).toEqual([]);
  });

  it('an UNVERIFIED email never adopts: 409 conflict, nothing written, the row keeps no subject', async () => {
    const guestId = await insertRow(A, 'second.guest@example.test');
    const before = await totals();
    const identity = who('second.guest', { subject: 'sub-unverified' });
    await expect(resolveCustomer(a, scopeA, identity)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: {},
    });
    await expect(
      registerCustomer(a, scopeA, identity, { email: 'second.guest@example.test' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await totals()).toEqual(before);
    expect((await rowsOf(A, 'second.guest@example.test'))[0]).toMatchObject({
      id: guestId,
      keycloak_subject: null,
      status: 'guest',
    });
  });

  it('a row that belongs to another identity is never taken over, verified or not: 409, nothing written', async () => {
    const ada = await resolveCustomer(a, scopeA, who('ada'));
    const before = await totals();
    await expect(
      resolveCustomer(a, scopeA, who('ada', { subject: 'sub-impostor', emailVerified: true })),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await totals()).toEqual(before);
    expect((await rowsOf(A, 'ada@example.test'))[0]).toMatchObject({
      id: ada.id,
      keycloak_subject: 'sub-ada',
    });
  });

  it('two identities racing for one guest row with verified tokens: one adopts, the other is refused', async () => {
    const guestId = await insertRow(A, 'contested@example.test');
    const settled = await Promise.allSettled(
      ['sub-first', 'sub-second'].map((subject) =>
        resolveCustomer(a, scopeA, who('contested', { subject, emailVerified: true })),
      ),
    );
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'conflict' });
    const stored = await rowsOf(A, 'contested@example.test');
    expect(stored).toHaveLength(1);
    expect(['sub-first', 'sub-second']).toContain(stored[0]!.keycloak_subject);
    expect((await events(guestId)).map((e) => e.topic)).toEqual(['customer.updated']);
  });
});

describe('updateCustomer (updateMe)', () => {
  it('names, phone and consent: one customer.updated naming the columns; an empty string clears; a no-op writes nothing; blank-only values count as cleared', async () => {
    const hedy = who('hedy');
    const first = await updateCustomer(a, scopeA, hedy, {
      first_name: 'Hedy',
      phone: ' +31 6 1234 ',
    });
    // created by this very call: the one customer.created carries the values, nothing more
    expect(first).toMatchObject({ first_name: 'Hedy', last_name: null, phone: '+31 6 1234' });
    expect((await events(first.id)).map((e) => e.topic)).toEqual(['customer.created']);

    const second = await updateCustomer(a, scopeA, hedy, {
      last_name: 'Lamarr',
      phone: '',
      marketing_consent: true,
    });
    expect(second).toMatchObject({
      id: first.id,
      first_name: 'Hedy',
      last_name: 'Lamarr',
      phone: null,
      marketing_consent: true,
    });
    const after = await events(first.id);
    expect(after.map((e) => e.topic)).toEqual(['customer.created', 'customer.updated']);
    expect(after[1]!.payload).toMatchObject({
      changed_fields: ['last_name', 'phone', 'marketing_consent'],
      marketing_consent: true,
    });
    expect((await audits(first.id)).map((x) => x.action)).toEqual([
      'customer.create',
      'customer.update',
    ]);

    const before = await totals();
    expect(await updateCustomer(a, scopeA, hedy, { last_name: ' Lamarr ', phone: '   ' })).toEqual(
      second,
    );
    expect(await updateCustomer(a, scopeA, hedy, {})).toEqual(second);
    expect(await totals()).toEqual(before);
  });

  it('refuses an over-long value with a 400 naming the field, nothing written', async () => {
    const before = await totals();
    await expect(
      updateCustomer(a, scopeA, who('hedy'), { first_name: 'x'.repeat(201) }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { first_name: 'at most 200 characters' },
    });
    expect(await totals()).toEqual(before);
  });

  it('a disabled customer cannot update anything (401), and nothing is written', async () => {
    const before = await totals();
    await expect(
      updateCustomer(a, scopeA, who('disabled'), { first_name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await totals()).toEqual(before);
  });
});

describe('addresses', () => {
  const home: AddressInput = {
    first_name: 'Ada',
    last_name: 'Lovelace',
    line1: 'Keizersgracht 1',
    city: 'Amsterdam',
    postal_code: '1015 CJ',
    country: 'NL',
  };
  const addressRows = async (customerId: string) =>
    (
      await owner.query<{ id: string; is_default_shipping: boolean; is_default_billing: boolean }>(
        `SELECT id, is_default_shipping, is_default_billing FROM customer_address
         WHERE customer_id = $1 ORDER BY id`,
        [customerId],
      )
    ).rows;

  it('the first address is the default for shipping and billing; a later one is neither; the list puts the default shipping first', async () => {
    const ada = await resolveCustomer(a, scopeA, who('ada'));
    const e0 = (await events(ada.id)).length;
    const first = await addCustomerAddress(a, scopeA, who('ada'), {
      ...home,
      company: '  ',
      line2: ' Floor 2 ',
      phone: '',
    });
    expect(first).toEqual({
      id: first.id,
      first_name: 'Ada',
      last_name: 'Lovelace',
      company: null,
      line1: 'Keizersgracht 1',
      line2: 'Floor 2',
      city: 'Amsterdam',
      region: null,
      postal_code: '1015 CJ',
      country: 'NL',
      phone: null,
      is_default_shipping: true,
      is_default_billing: true,
    });
    const second = await addCustomerAddress(a, scopeA, who('ada'), {
      ...home,
      line1: 'Prinsengracht 2',
    });
    expect(second).toMatchObject({ is_default_shipping: false, is_default_billing: false });

    const listed = await listCustomerAddresses(a, scopeA, who('ada'));
    expect(listed.map((x) => x.id)).toEqual([first.id, second.id]);

    const after = await events(ada.id);
    expect(after.slice(e0).map((e) => [e.topic, e.payload.changed_fields])).toEqual([
      ['customer.updated', ['addresses']],
      ['customer.updated', ['addresses']],
    ]);
    const addressAudits = await owner.query<{ action: string; entity_id: string; after: unknown }>(
      `SELECT action, entity_id, after FROM audit_log WHERE entity_type = 'customer_address' AND entity_id = ANY($1)
       ORDER BY created_at, id`,
      [[first.id, second.id]],
    );
    expect(addressAudits.rows).toEqual([
      {
        action: 'customer_address.create',
        entity_id: first.id,
        after: { customer_id: ada.id, is_default_shipping: true, is_default_billing: true },
      },
      {
        action: 'customer_address.create',
        entity_id: second.id,
        after: { customer_id: ada.id, is_default_shipping: false, is_default_billing: false },
      },
    ]);
  });

  it('explicit flags (contracts 0.4.9): true moves that default to the new row and clears it elsewhere; an explicit false is ignored on the FIRST address', async () => {
    const grace = who('grace');
    const me = await resolveCustomer(a, scopeA, grace);
    const first = await addCustomerAddress(a, scopeA, grace, {
      ...home,
      is_default_billing: false,
    });
    // the first address is always the default for both: a customer with addresses always has one
    expect(first).toMatchObject({ is_default_shipping: true, is_default_billing: true });
    const gift = await addCustomerAddress(a, scopeA, grace, {
      ...home,
      line1: 'Gift street 3',
      is_default_shipping: true,
      is_default_billing: false,
    });
    expect(gift).toMatchObject({ is_default_shipping: true, is_default_billing: false });
    // compared by id, not by creation time: nothing here depends on the database clock
    expect(await addressRows(me.id)).toEqual(
      [
        { id: first.id, is_default_shipping: false, is_default_billing: true },
        { id: gift.id, is_default_shipping: true, is_default_billing: false },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    const listed = await listCustomerAddresses(a, scopeA, grace);
    expect(listed.map((x) => x.id)).toEqual([gift.id, first.id]);
  });

  it('two concurrent first addresses: exactly one default shipping and one default billing', async () => {
    const linus = who('linus');
    const me = await resolveCustomer(a, scopeA, linus);
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        addCustomerAddress(a, scopeA, linus, { ...home, line1: `Street ${i}` }),
      ),
    );
    expect(settled.map((s) => s.status)).toEqual(Array(6).fill('fulfilled'));
    const rows = await addressRows(me.id);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.is_default_shipping)).toHaveLength(1);
    expect(rows.filter((r) => r.is_default_billing)).toHaveLength(1);
  });

  it('validation: blank required fields and a bad country are a 400 naming the field; nothing written', async () => {
    const before = await totals();
    await expect(
      addCustomerAddress(a, scopeA, who('ada'), {
        ...home,
        first_name: '  ',
        line1: '',
        country: 'Netherlands',
        is_default_shipping: 'yes' as unknown as boolean,
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: {
        first_name: 'required',
        line1: 'required',
        country: 'ISO 3166-1 alpha-2',
        is_default_shipping: 'boolean',
      },
    });
    expect(await totals()).toEqual(before);
  });

  it(`at most ${ADDRESS_LIMIT} addresses per customer: the next one is a 400, the list stays unpaginated and complete`, async () => {
    const margaret = who('margaret');
    const me = await resolveCustomer(a, scopeA, margaret);
    for (let i = 0; i < ADDRESS_LIMIT; i += 1) {
      await addCustomerAddress(a, scopeA, margaret, { ...home, line1: `Street ${i}` });
    }
    await expect(
      addCustomerAddress(a, scopeA, margaret, { ...home, line1: 'One too many' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { addresses: `at most ${ADDRESS_LIMIT}` },
    });
    expect(await addressRows(me.id)).toHaveLength(ADDRESS_LIMIT);
    expect(await listCustomerAddresses(a, scopeA, margaret)).toHaveLength(ADDRESS_LIMIT);
  });

  it('customers never cross stores: the same subject in store B has no addresses there', async () => {
    expect(await listCustomerAddresses(b, scopeB, who('ada'))).toEqual([]);
    expect((await listCustomerAddresses(a, scopeA, who('ada'))).length).toBeGreaterThan(0);
  });

  it('a disabled customer cannot add or list addresses (401)', async () => {
    await expect(listCustomerAddresses(a, scopeA, who('disabled'))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(addCustomerAddress(a, scopeA, who('disabled'), home)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('address edit and delete (#470, Store API 0.5.6)', () => {
  const home: AddressInput = {
    first_name: 'Ada',
    last_name: 'Lovelace',
    line1: 'Keizersgracht 1',
    city: 'Amsterdam',
    postal_code: '1015 CJ',
    country: 'NL',
  };
  const flags = async (customerId: string) =>
    (
      await owner.query<{ id: string; is_default_shipping: boolean; is_default_billing: boolean }>(
        `SELECT id, is_default_shipping, is_default_billing FROM customer_address
         WHERE customer_id = $1 ORDER BY created_at, id`,
        [customerId],
      )
    ).rows;
  const pin = (id: string, at: string) =>
    owner.query('UPDATE customer_address SET created_at = $2 WHERE id = $1', [id, at]);

  it('update: a present field replaces, null clears a nullable one, a required one cannot be blanked; a no-op writes nothing; one audit row with the changed column names', async () => {
    const ida = who('ida');
    const me = await resolveCustomer(a, scopeA, ida);
    const first = await addCustomerAddress(a, scopeA, ida, { ...home, company: 'Old Co' });
    const e0 = (await events(me.id)).length;

    const edited = await updateCustomerAddress(a, scopeA, ida, first.id, {
      line1: '  Prinsengracht 9 ',
      company: null,
      phone: '+31 6 1234 5678',
    });
    expect(edited).toMatchObject({
      id: first.id,
      line1: 'Prinsengracht 9',
      company: null,
      phone: '+31 6 1234 5678',
      is_default_shipping: true,
      is_default_billing: true,
    });
    const ev = await events(me.id);
    expect(ev).toHaveLength(e0 + 1);
    expect(ev[ev.length - 1]).toMatchObject({
      topic: 'customer.updated',
      payload: expect.objectContaining({ changed_fields: ['addresses'] }),
    });
    const audit = await owner.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM audit_log WHERE entity_type = 'customer_address' AND entity_id = $1
       ORDER BY created_at`,
      [first.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'customer_address.create',
      'customer_address.update',
    ]);
    expect(audit.rows[1]!.after).toEqual({
      customer_id: me.id,
      changed_fields: ['company', 'line1', 'phone'],
      is_default_shipping: true,
      is_default_billing: true,
    });

    // the same values again: nothing written
    expect(
      await updateCustomerAddress(a, scopeA, ida, first.id, { line1: 'Prinsengracht 9' }),
    ).toEqual(edited);
    expect(await events(me.id)).toHaveLength(e0 + 1);

    // validation: a required field blanked or nulled, an over-long value, a bad country — 400 naming the field
    for (const [patch, field] of [
      [{ city: '  ' }, 'city'],
      [{ first_name: null as unknown as string }, 'first_name'],
      [{ line2: 'x'.repeat(201) }, 'line2'],
      [{ country: 'Netherlands' }, 'country'],
    ] as const) {
      await expect(updateCustomerAddress(a, scopeA, ida, first.id, patch)).rejects.toMatchObject({
        code: 'validation_error',
        details: { [field]: expect.any(String) },
      });
    }
    expect(await events(me.id)).toHaveLength(e0 + 1);
  });

  it('update: a default flag true moves the default here (cleared elsewhere); false hands it to the oldest other address, and is ignored on the only address', async () => {
    const kay = who('kay');
    const me = await resolveCustomer(a, scopeA, kay);
    const one = await addCustomerAddress(a, scopeA, kay, home);
    // the only address: `false` is ignored, nothing written
    const e0 = (await events(me.id)).length;
    expect(
      await updateCustomerAddress(a, scopeA, kay, one.id, { is_default_shipping: false }),
    ).toMatchObject({ is_default_shipping: true, is_default_billing: true });
    expect(await events(me.id)).toHaveLength(e0);

    const two = await addCustomerAddress(a, scopeA, kay, { ...home, line1: 'Second 2' });
    const three = await addCustomerAddress(a, scopeA, kay, { ...home, line1: 'Third 3' });
    await pin(one.id, '2026-09-01T10:00:00Z');
    await pin(two.id, '2026-09-01T10:01:00Z');
    await pin(three.id, '2026-09-01T10:02:00Z');

    // true on `three`: clear-then-set, `one` loses it
    expect(
      await updateCustomerAddress(a, scopeA, kay, three.id, { is_default_shipping: true }),
    ).toMatchObject({ is_default_shipping: true, is_default_billing: false });
    expect(await flags(me.id)).toEqual([
      { id: one.id, is_default_shipping: false, is_default_billing: true },
      { id: two.id, is_default_shipping: false, is_default_billing: false },
      { id: three.id, is_default_shipping: true, is_default_billing: false },
    ]);
    // false on `three`: the OLDEST other address (`one`) takes shipping back
    expect(
      await updateCustomerAddress(a, scopeA, kay, three.id, { is_default_shipping: false }),
    ).toMatchObject({ is_default_shipping: false });
    // false on `one` for billing: `two` is the oldest OTHER one
    expect(
      await updateCustomerAddress(a, scopeA, kay, one.id, { is_default_billing: false }),
    ).toMatchObject({ is_default_shipping: true, is_default_billing: false });
    expect(await flags(me.id)).toEqual([
      { id: one.id, is_default_shipping: true, is_default_billing: false },
      { id: two.id, is_default_shipping: false, is_default_billing: true },
      { id: three.id, is_default_shipping: false, is_default_billing: false },
    ]);
    // one shipping default and one billing default, always
    const rows = await flags(me.id);
    expect(rows.filter((r) => r.is_default_shipping)).toHaveLength(1);
    expect(rows.filter((r) => r.is_default_billing)).toHaveLength(1);
  });

  it("delete: answers the remaining addresses; a default the deleted address held moves to the oldest remaining one; the last address leaves no default; another customer's id, another store and an unknown id are a 404", async () => {
    const lou = who('lou');
    const me = await resolveCustomer(a, scopeA, lou);
    const one = await addCustomerAddress(a, scopeA, lou, home);
    const two = await addCustomerAddress(a, scopeA, lou, { ...home, line1: 'Second 2' });
    const three = await addCustomerAddress(a, scopeA, lou, { ...home, line1: 'Third 3' });
    await pin(one.id, '2026-09-01T10:00:00Z');
    await pin(two.id, '2026-09-01T10:01:00Z');
    await pin(three.id, '2026-09-01T10:02:00Z');

    // isolation first: another customer (ida) of the same store, the same subject in store B, an unknown id
    for (const [client, scope, identity, id] of [
      [a, scopeA, who('ida'), one.id],
      [b, scopeB, lou, one.id],
      [a, scopeA, lou, '00000000-0000-4000-8000-0000000000aa'],
    ] as const) {
      await expect(deleteCustomerAddress(client, scope, identity, id)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(
        updateCustomerAddress(client, scope, identity, id, { city: 'X' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(await flags(me.id)).toHaveLength(3);

    const e0 = (await events(me.id)).length;
    expect((await deleteCustomerAddress(a, scopeA, lou, one.id)).map((x) => x.id)).toEqual([
      two.id,
      three.id,
    ]);
    expect(await flags(me.id)).toEqual([
      { id: two.id, is_default_shipping: true, is_default_billing: true },
      { id: three.id, is_default_shipping: false, is_default_billing: false },
    ]);
    const audit = await owner.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_log WHERE action = 'customer_address.delete' AND entity_id = $1`,
      [one.id],
    );
    expect(audit.rows[0]!.after).toEqual({
      customer_id: me.id,
      defaults_moved: ['is_default_shipping', 'is_default_billing'],
      defaults_moved_to: two.id,
    });
    const ev = await events(me.id);
    expect(ev).toHaveLength(e0 + 1);
    expect(ev[ev.length - 1]!.payload).toMatchObject({ changed_fields: ['addresses'] });

    await deleteCustomerAddress(a, scopeA, lou, three.id);
    expect(await deleteCustomerAddress(a, scopeA, lou, two.id)).toEqual([]);
    expect(await flags(me.id)).toEqual([]);
    expect(await listCustomerAddresses(a, scopeA, lou)).toEqual([]);
    await expect(deleteCustomerAddress(a, scopeA, lou, two.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    // the next address is the first again: the default for both
    expect(await addCustomerAddress(a, scopeA, lou, home)).toMatchObject({
      is_default_shipping: true,
      is_default_billing: true,
    });
  });
});

describe('deleteMe / the erasure tombstone (#470, #482)', () => {
  it('eraseMe: the customer of the token is erased in THIS store only; replay is a no-op; the same subject is a 401 everywhere after and never gets a fresh row', async () => {
    const zed = who('zed', { emailVerified: true });
    const me = await registerCustomer(a, scopeA, zed, {
      email: 'zed@example.test',
      first_name: 'Zed',
      marketing_consent: true,
    });
    await addCustomerAddress(a, scopeA, zed, {
      first_name: 'Zed',
      last_name: 'Zee',
      line1: 'Zstreet 1',
      city: 'Zwolle',
      postal_code: '8011 AA',
      country: 'NL',
    });
    // the same person in store B stays untouched
    const inB = await resolveCustomer(b, scopeB, zed);
    const before = await totals();

    expect(await eraseMe(a, scopeA, zed)).toEqual({ erased: true });
    const [row] = await rowsOf(A, `erased+${me.customer.id}@invalid`);
    expect(row).toMatchObject({
      id: me.customer.id,
      status: 'erased',
      first_name: null,
      keycloak_subject: 'sub-zed',
    });
    expect((await rowsOf(A, 'zed@example.test')).length).toBe(0);
    const ev = await events(me.customer.id);
    expect(ev.filter((e) => e.topic === 'customer.erased')).toHaveLength(1);
    expect((await audits(me.customer.id)).map((x) => x.action)).toContain('customer.erase');
    expect((await audits(me.customer.id)).find((x) => x.action === 'customer.erase')).toMatchObject(
      {
        actor_type: 'customer',
        actor_id: me.customer.id,
      },
    );
    expect((await rowsOf(B, 'zed@example.test'))[0]).toMatchObject({
      id: inB.id,
      status: 'registered',
    });

    // replay: nothing written
    const after = await totals();
    expect(await eraseMe(a, scopeA, zed)).toEqual({ erased: false });
    expect(await totals()).toEqual(after);
    expect(Number(after.customers)).toBe(Number(before.customers));

    // the tombstone: the same login (even with a new email) is refused everywhere, no fresh row
    for (const identity of [zed, { ...zed, email: 'zed.new@example.test' }]) {
      await expect(resolveCustomer(a, scopeA, identity)).rejects.toMatchObject({
        code: 'unauthorized',
      });
      await expect(
        registerCustomer(a, scopeA, identity, { email: identity.email! }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(listCustomerAddresses(a, scopeA, identity)).rejects.toMatchObject({
        code: 'unauthorized',
      });
    }
    expect(await totals()).toEqual(after);
    expect(await findCustomerForSubject(a, A, 'sub-zed')).toEqual({
      id: me.customer.id,
      status: 'erased',
    });
  });

  it('the admin erase (#414) keeps the tombstone too: one erase shape — the same login is a 401, not a new account', async () => {
    const yan = who('yan');
    const me = await resolveCustomer(a, scopeA, yan);
    expect(await eraseCustomer(a, A, me.id, { id: null, type: 'system' })).toEqual({
      erased: true,
    });
    const count = (await totals()).customers;
    await expect(resolveCustomer(a, scopeA, yan)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await totals()).customers).toBe(count);
    expect((await rowsOf(A, `erased+${me.id}@invalid`))[0]).toMatchObject({
      keycloak_subject: 'sub-yan',
    });
  });

  it('a subject with no row here is a no-op: nothing provisioned, nothing adopted, nothing written (#487 review)', async () => {
    const guestId = await insertRow(A, 'wim@example.test');
    const wim = who('wim', { emailVerified: true });
    const before = await totals();
    expect(await eraseMe(a, scopeA, wim)).toEqual({ erased: false });
    expect(await totals()).toEqual(before);
    // the guest row with wim's verified email is untouched: not adopted, not erased
    expect((await rowsOf(A, 'wim@example.test'))[0]).toMatchObject({
      id: guestId,
      status: 'guest',
      keycloak_subject: null,
    });
    expect(await events(guestId)).toEqual([]);
  });

  it('deleteMe racing a write (#487 review): a write that starts after the erase sees the erased row (401, no address on it); one that holds the lock first wins and the erasure removes what it wrote', async () => {
    const home: AddressInput = {
      first_name: 'Rae',
      last_name: 'Racer',
      line1: 'Racestreet 1',
      city: 'Amsterdam',
      postal_code: '1015 CJ',
      country: 'NL',
    };
    const addressesOf = async (id: string) =>
      (await owner.query('SELECT 1 FROM customer_address WHERE customer_id = $1', [id])).rowCount ??
      0;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    type Tx = Parameters<Parameters<typeof a.transaction>[0]>[0];
    /** `a`, with a hook before the first query of every transaction (after BEGIN). */
    const before = (hook: () => Promise<void>) =>
      Object.assign(Object.create(a) as typeof a, {
        transaction: <T>(fn: (tx: Tx) => Promise<T>) =>
          a.transaction(async (tx) => {
            await hook();
            return fn(tx);
          }),
      });
    /** `a`, pausing AFTER the first query of the transaction (the locked read of the customer row). */
    const afterFirstQuery = (onFirst: () => void, release: Promise<void>) =>
      Object.assign(Object.create(a) as typeof a, {
        transaction: <T>(fn: (tx: Tx) => Promise<T>) =>
          a.transaction(async (tx) => {
            let n = 0;
            const slow = Object.assign(Object.create(tx) as Tx, {
              query: async (...args: Parameters<Tx['query']>) => {
                const r = await tx.query(...args);
                if (++n === 1) {
                  onFirst();
                  await release;
                }
                return r;
              },
            });
            return fn(slow);
          }),
      });

    // (1) the add's transaction is open BEFORE the erase commits and reads AFTER it: 401, nothing written
    const ria = who('ria');
    const riaRow = await resolveCustomer(a, scopeA, ria);
    let erased: Promise<unknown> = Promise.resolve();
    const lateAdd = addCustomerAddress(
      before(async () => {
        erased = eraseMe(a, scopeA, ria);
        await erased;
      }),
      scopeA,
      ria,
      home,
    );
    await expect(lateAdd).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await erased).toEqual({ erased: true });
    expect(await addressesOf(riaRow.id)).toBe(0);
    expect((await rowsOf(A, `erased+${riaRow.id}@invalid`))[0]).toMatchObject({ status: 'erased' });

    // (2) the add holds the customer-row lock first: the erase WAITS, the add lands, the erase then deletes it
    const rex = who('rex');
    const rexRow = await resolveCustomer(a, scopeA, rex);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockHeld = new Promise<void>((r) => (locked = r));
    const earlyAdd = addCustomerAddress(afterFirstQuery(locked, gate), scopeA, rex, home);
    await lockHeld;
    const lateErase = eraseMe(a, scopeA, rex);
    expect(
      await Promise.race([lateErase.then(() => 'done'), sleep(400).then(() => 'waiting')]),
    ).toBe('waiting');
    release();
    expect(await earlyAdd).toMatchObject({ line1: 'Racestreet 1' });
    expect(await lateErase).toEqual({ erased: true });
    expect(await addressesOf(rexRow.id)).toBe(0);
    expect((await rowsOf(A, `erased+${rexRow.id}@invalid`))[0]).toMatchObject({ status: 'erased' });
    const out = await owner.query<{ doc: string }>(
      `SELECT payload::text AS doc FROM outbox WHERE aggregate_id = $1
       UNION ALL SELECT coalesce(after::text, '') FROM audit_log WHERE entity_id = $1`,
      [rexRow.id],
    );
    expect(out.rows.map((r) => r.doc).join('\n')).not.toContain('Racestreet');
  });
});

describe('consent ledger (#471, db 0194, Store API 0.5.7)', () => {
  const ledgerOf = async (customerId: string) =>
    (
      await owner.query<{
        purpose: string;
        granted: boolean;
        source: string;
        policy_version: string;
        recorded_at: Date;
      }>(
        `SELECT purpose, granted, source, policy_version, recorded_at FROM customer_consent
         WHERE customer_id = $1 ORDER BY recorded_at, id`,
        [customerId],
      )
    ).rows;

  it('never asked = no row, granted null; a flip writes ONE ledger row + the projection in one transaction, with the version the client sent; the same answer again writes nothing', async () => {
    const cleo = who('cleo');
    const me = await resolveCustomer(a, scopeA, cleo);
    expect(await getMyConsents(a, scopeA, cleo)).toEqual([
      {
        purpose: 'marketing_email',
        granted: null,
        source: null,
        policy_version: null,
        recorded_at: null,
      },
    ]);
    expect(await ledgerOf(me.id)).toEqual([]);
    const e0 = (await events(me.id)).length;

    const granted = await putMyConsents(a, scopeA, cleo, {
      policy_version: '2026-10',
      consents: [{ purpose: 'marketing_email', granted: true }],
    });
    expect(granted).toEqual([
      {
        purpose: 'marketing_email',
        granted: true,
        source: 'storefront',
        policy_version: '2026-10',
        recorded_at: expect.any(String),
      },
    ]);
    const [row] = await ledgerOf(me.id);
    expect(row).toMatchObject({ granted: true, source: 'storefront', policy_version: '2026-10' });
    // the projection carries the ledger row's own timestamp — window 17's segments read exactly this shape
    const projected = (await rowsOf(A, 'cleo@example.test'))[0]!.consent;
    expect(projected).toEqual({
      marketing_email: { granted: true, at: row!.recorded_at.toISOString(), source: 'storefront' },
    });
    expect((await resolveCustomer(a, scopeA, cleo)).marketing_consent).toBe(true);
    const ev = await events(me.id);
    expect(ev).toHaveLength(e0 + 1);
    expect(ev[ev.length - 1]).toMatchObject({
      topic: 'customer.updated',
      payload: expect.objectContaining({
        marketing_consent: true,
        changed_fields: ['marketing_consent'],
      }),
    });

    // the same answer under a NEWER policy version: nothing written (the answer did not change)
    expect(
      await putMyConsents(a, scopeA, cleo, {
        policy_version: '2026-11',
        consents: [{ purpose: 'marketing_email', granted: true }],
      }),
    ).toEqual(granted);
    expect(await ledgerOf(me.id)).toHaveLength(1);
    expect(await events(me.id)).toHaveLength(e0 + 1);

    // the opt-out: a second row; the projection follows; the first row is untouched (append-only)
    const declined = await putMyConsents(a, scopeA, cleo, {
      policy_version: '2026-11',
      consents: [{ purpose: 'marketing_email', granted: false }],
    });
    expect(declined[0]).toMatchObject({ granted: false, policy_version: '2026-11' });
    expect((await ledgerOf(me.id)).map((r) => [r.granted, r.policy_version])).toEqual([
      [true, '2026-10'],
      [false, '2026-11'],
    ]);
    expect((await rowsOf(A, 'cleo@example.test'))[0]!.consent).toMatchObject({
      marketing_email: { granted: false },
    });
    // the app role cannot rewrite a decision (append-only ledger)
    await expect(
      a.query(`UPDATE customer_consent SET granted = true WHERE customer_id = $1`, [me.id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('validation: a blank policy_version, an empty list, an unknown or repeated purpose and a non-boolean are a 400 naming the field; nothing written', async () => {
    const dot = who('dot');
    const me = await resolveCustomer(a, scopeA, dot);
    for (const [input, field] of [
      [
        { policy_version: '  ', consents: [{ purpose: 'marketing_email', granted: true }] },
        'policy_version',
      ],
      [{ policy_version: 'v1', consents: [] }, 'consents'],
      [
        { policy_version: 'v1', consents: [{ purpose: 'marketing_sms', granted: true }] },
        'consents.0.purpose',
      ],
      [
        {
          policy_version: 'v1',
          consents: [
            { purpose: 'marketing_email', granted: true },
            { purpose: 'marketing_email', granted: false },
          ],
        },
        'consents.1.purpose',
      ],
      [
        {
          policy_version: 'v1',
          consents: [{ purpose: 'marketing_email', granted: 'yes' as unknown as boolean }],
        },
        'consents.0.granted',
      ],
    ] as const) {
      await expect(putMyConsents(a, scopeA, dot, input)).rejects.toMatchObject({
        code: 'validation_error',
        details: { [field]: expect.any(String) },
      });
    }
    expect(await ledgerOf(me.id)).toEqual([]);
  });

  it("per brand: the same subject in store B has its own ledger and never sees store A's answer; a disabled customer cannot read or answer (401)", async () => {
    const eve = who('eve');
    await putMyConsents(a, scopeA, eve, {
      policy_version: 'v1',
      consents: [{ purpose: 'marketing_email', granted: true }],
    });
    expect((await getMyConsents(b, scopeB, eve))[0]).toMatchObject({ granted: null });
    const inB = await resolveCustomer(b, scopeB, eve);
    expect(await ledgerOf(inB.id)).toEqual([]);
    await owner.query(`UPDATE customer SET status = 'disabled' WHERE id = $1`, [inB.id]);
    await expect(getMyConsents(b, scopeB, eve)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      putMyConsents(b, scopeB, eve, {
        policy_version: 'v1',
        consents: [{ purpose: 'marketing_email', granted: true }],
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('erase deletes the ledger and counts it in the audit row; the export carries the ledger oldest first', async () => {
    const fay = who('fay');
    const me = await resolveCustomer(a, scopeA, fay);
    await putMyConsents(a, scopeA, fay, {
      policy_version: 'v1',
      consents: [{ purpose: 'marketing_email', granted: true }],
    });
    await putMyConsents(a, scopeA, fay, {
      policy_version: 'v2',
      consents: [{ purpose: 'marketing_email', granted: false }],
    });
    const bundle = await buildCustomerExport(a, A, me.id);
    expect(bundle.consents.map((c) => [c.purpose, c.granted, c.source, c.policy_version])).toEqual([
      ['marketing_email', true, 'storefront', 'v1'],
      ['marketing_email', false, 'storefront', 'v2'],
    ]);
    expect(bundle.consents[0]).not.toHaveProperty('id');

    expect(await eraseMe(a, scopeA, fay)).toEqual({ erased: true });
    expect(await ledgerOf(me.id)).toEqual([]);
    const audit = (await audits(me.id)).find((x) => x.action === 'customer.erase');
    expect(audit?.after).toMatchObject({ consents_deleted: 2 });
    const docs = await owner.query<{ doc: string }>(
      `SELECT payload::text AS doc FROM outbox WHERE aggregate_id = $1`,
      [me.id],
    );
    expect(docs.rows.map((r) => r.doc).join()).not.toContain('fay@');
  });

  it('the store\'s settings.privacy.policy_version is what the one-checkbox shortcut records; blank or missing = "unversioned"', async () => {
    await owner.query(
      `UPDATE store SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{privacy}', '{"policy_version": " 2026-10 "}'::jsonb) WHERE id = $1`,
      [B],
    );
    try {
      const gil = who('gil');
      const me = await registerCustomer(b, scopeB, gil, {
        email: 'gil@example.test',
        marketing_consent: true,
      });
      expect((await ledgerOf(me.customer.id))[0]).toMatchObject({
        policy_version: '2026-10',
        source: 'storefront',
      });
    } finally {
      await owner.query(`UPDATE store SET settings = settings - 'privacy' WHERE id = $1`, [B]);
    }
  });

  it("backfill (migration 0194): one ledger row per existing projection with the projection's own timestamp and source, policy_version pre-ledger; running it twice adds nothing; erased rows and never-asked rows are skipped", async () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../../../packages/db/migrations/0194_customer_consent.sql', import.meta.url),
      ),
      'utf8',
    );
    const backfill = sql.slice(sql.indexOf('INSERT INTO customer_consent'));
    expect(backfill).toMatch(/^INSERT INTO customer_consent/);
    const at = '2026-09-01T10:00:00.000Z';
    const legacyIn = await insertRow(A, 'legacy.in@example.test', {
      subject: 'sub-legacy-in',
      status: 'registered',
    });
    const legacyOut = await insertRow(A, 'legacy.out@example.test', {
      subject: 'sub-legacy-out',
      status: 'registered',
    });
    const legacyErased = await insertRow(A, 'legacy.erased@example.test', {
      subject: 'sub-legacy-erased',
      status: 'erased',
    });
    const never = await insertRow(A, 'legacy.never@example.test', {
      subject: 'sub-legacy-never',
      status: 'registered',
    });
    await owner.query(`UPDATE customer SET consent = $2::jsonb WHERE id = $1`, [
      legacyIn,
      JSON.stringify({ marketing_email: { granted: true, at, source: 'storefront' } }),
    ]);
    await owner.query(`UPDATE customer SET consent = $2::jsonb WHERE id = $1`, [
      legacyOut,
      JSON.stringify({ marketing_email: { granted: false, at, source: 'weird' } }),
    ]);
    await owner.query(`UPDATE customer SET consent = $2::jsonb WHERE id = $1`, [
      legacyErased,
      JSON.stringify({ marketing_email: { granted: true, at, source: 'storefront' } }),
    ]);
    await owner.query(backfill);
    await owner.query(backfill);
    expect(await ledgerOf(legacyIn)).toEqual([
      {
        purpose: 'marketing_email',
        granted: true,
        source: 'storefront',
        policy_version: 'pre-ledger',
        recorded_at: new Date(at),
      },
    ]);
    expect(await ledgerOf(legacyOut)).toEqual([
      {
        purpose: 'marketing_email',
        granted: false,
        source: 'import',
        policy_version: 'pre-ledger',
        recorded_at: new Date(at),
      },
    ]);
    expect(await ledgerOf(legacyErased)).toEqual([]);
    expect(await ledgerOf(never)).toEqual([]);
    // the ledger and the API agree afterwards
    expect(
      (
        await getMyConsents(a, scopeA, {
          subject: 'sub-legacy-out',
          email: 'legacy.out@example.test',
          emailVerified: false,
        })
      )[0],
    ).toMatchObject({
      granted: false,
      policy_version: 'pre-ledger',
    });
  });
});

describe('export delivery (#472, db 0195 customer_export, Store API 0.5.8)', () => {
  const T0 = new Date('2026-10-18T10:00:00.000Z');
  const DAY = 86_400_000;
  const exportRows = async (customerId: string) =>
    (
      await owner.query<{
        id: string;
        status: string;
        reason: string | null;
        bundle: Buffer | null;
        bundle_size: number | null;
        expires_at: Date | null;
        purged_at: Date | null;
        download_count: number;
        event_id: string;
      }>(
        `SELECT id, status, reason, bundle, bundle_size, expires_at, purged_at, download_count, event_id
         FROM customer_export WHERE customer_id = $1 ORDER BY created_at, id`,
        [customerId],
      )
    ).rows;
  const readyEvents = async (customerId: string) =>
    (await events(customerId)).filter((e) => e.topic === 'customer.export_ready');
  const asCustomer = (id: string) => ({ id, type: 'customer' as const, requestId: 'req-export' });

  it('claim → build → ready: one row per request event (replay never builds twice), the bundle is the export, one customer.export_ready, expires in 30 days; list and download for the customer only', async () => {
    const mia = who('mia');
    const me = await registerCustomer(a, scopeA, mia, {
      email: 'mia@example.test',
      first_name: 'Mia',
    });
    await addCustomerAddress(a, scopeA, mia, {
      first_name: 'Mia',
      last_name: 'Mason',
      line1: 'Exportlane 5',
      city: 'Amsterdam',
      postal_code: '1015 CJ',
      country: 'NL',
    });
    // two requests (the customer, then "staff"), as the Store / Admin routes record them
    await requestCustomerExport(a, A, me.customer.id, asCustomer(me.customer.id));
    await requestCustomerExport(a, A, me.customer.id, {
      id: '00000000-0000-4000-8000-000000000044',
      type: 'staff',
      requestId: 'req-export',
    });

    expect(await claimExportRequests(a, A)).toEqual({ scanned: 2, claimed: 2 });
    expect(await claimExportRequests(a, A)).toEqual({ scanned: 0, claimed: 0 });
    let rows = await exportRows(me.customer.id);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect((await listMyExports(a, scopeA, mia)).map((x) => x.status)).toEqual([
      'pending',
      'pending',
    ]);
    // pending: nothing to download yet
    await expect(getMyExport(a, scopeA, mia, rows[0]!.id)).rejects.toMatchObject({
      code: 'not_found',
    });

    const built = await buildPendingExports(a, A, { now: T0 });
    expect(built.built.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(built.expired).toEqual([]);
    expect(await buildPendingExports(a, A, { now: T0 })).toEqual({ built: [], expired: [] });
    rows = await exportRows(me.customer.id);
    expect(rows.map((r) => r.status)).toEqual(['ready', 'ready']);
    expect(rows[0]!.expires_at).toEqual(new Date(T0.getTime() + 30 * DAY));
    const bundle = JSON.parse(gunzipSync(rows[0]!.bundle!).toString('utf8'));
    expect(bundle).toMatchObject({
      format: 'customer-export/v1',
      store_id: A,
      customer: { id: me.customer.id, email: 'mia@example.test', first_name: 'Mia' },
    });
    expect(bundle.addresses.map((x: { line1: string }) => x.line1)).toEqual(['Exportlane 5']);
    const ready = await readyEvents(me.customer.id);
    expect(ready).toHaveLength(2);
    expect(ready.map((e) => e.payload.requested_by_type).sort()).toEqual(['customer', 'staff']);
    expect(ready[0]!.payload).toEqual({
      export_id: expect.any(String),
      customer_id: me.customer.id,
      requested_by: expect.any(String),
      requested_by_type: expect.any(String),
      expires_at: new Date(T0.getTime() + 30 * DAY).toISOString(),
    });

    // the list and the download (own only)
    const listed = await listMyExports(a, scopeA, mia);
    expect(listed[0]).toEqual({
      id: expect.any(String),
      status: 'ready',
      requested_at: expect.any(String),
      ready_at: T0.toISOString(),
      expires_at: new Date(T0.getTime() + 30 * DAY).toISOString(),
      size_bytes: rows[0]!.bundle_size,
      reason: null,
    });
    const file = await getMyExport(a, scopeA, mia, rows[0]!.id);
    expect(file.filename).toBe(`customer-export-${rows[0]!.id}.json`);
    expect(JSON.parse(file.body.toString('utf8'))).toEqual(bundle);
    expect((await exportRows(me.customer.id))[0]!.download_count).toBe(1);
    const audit = await owner.query<{
      action: string;
      actor_type: string;
      after: Record<string, unknown>;
    }>(
      `SELECT action, actor_type, after FROM audit_log WHERE entity_type = 'customer_export' AND entity_id = $1`,
      [rows[0]!.id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'customer_export.download',
        actor_type: 'customer',
        after: { bytes: file.body.length },
      },
    ]);
    await expect(getMyExport(a, scopeA, who('nico'), rows[0]!.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(getMyExport(b, scopeB, mia, rows[0]!.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await listMyExports(b, scopeB, mia)).toEqual([]);

    // purge after the TTL: the bundle goes, the bare row stays, the download is 410 `expired` with the date
    expect(await purgeExpiredExports(a, A, new Date(T0.getTime() + 30 * DAY - 1))).toBe(0);
    expect(await purgeExpiredExports(a, A, new Date(T0.getTime() + 30 * DAY))).toBe(2);
    rows = await exportRows(me.customer.id);
    expect(rows.map((r) => [r.status, r.bundle, r.purged_at !== null])).toEqual([
      ['expired', null, true],
      ['expired', null, true],
    ]);
    await expect(getMyExport(a, scopeA, mia, rows[0]!.id)).rejects.toMatchObject({
      code: 'expired',
      status: 410,
      details: { expires_at: new Date(T0.getTime() + 30 * DAY).toISOString() },
    });
    expect((await listMyExports(a, scopeA, mia))[0]).toMatchObject({
      status: 'expired',
      size_bytes: null,
    });
    // nothing personal in the outbox or the audit rows
    const docs = await owner.query<{ doc: string }>(
      `SELECT payload::text AS doc FROM outbox WHERE aggregate_id = $1
       UNION ALL SELECT coalesce(after::text, '') FROM audit_log WHERE entity_id = ANY($2)`,
      [me.customer.id, rows.map((r) => r.id)],
    );
    for (const pii of ['mia@', 'Mia', 'Exportlane'])
      expect(docs.rows.map((r) => r.doc).join()).not.toContain(pii);
  });

  it('the size cap: a bundle above maxBytes becomes expired / too_large with no bundle and no event; a customer gone by build time becomes expired / customer_gone', async () => {
    const olga = who('olga');
    const me = await resolveCustomer(a, scopeA, olga);
    await requestCustomerExport(a, A, me.id, asCustomer(me.id));
    await claimExportRequests(a, A);
    const capped = await buildPendingExports(a, A, { now: T0, maxBytes: 16 });
    expect(capped.built).toEqual([]);
    expect(capped.expired).toEqual([{ id: expect.any(String), reason: 'too_large' }]);
    expect((await exportRows(me.id))[0]).toMatchObject({
      status: 'expired',
      reason: 'too_large',
      bundle: null,
    });
    expect(await readyEvents(me.id)).toEqual([]);
    expect((await listMyExports(a, scopeA, olga))[0]).toMatchObject({
      status: 'expired',
      reason: 'too_large',
    });

    // gone: request, erase, then the job runs — the request event is still in the outbox
    const pia = who('pia');
    const p = await resolveCustomer(a, scopeA, pia);
    await requestCustomerExport(a, A, p.id, asCustomer(p.id));
    expect(await eraseMe(a, scopeA, pia)).toEqual({ erased: true });
    expect(await claimExportRequests(a, A)).toMatchObject({ claimed: 1 });
    const gone = await buildPendingExports(a, A, { now: T0 });
    expect(gone.expired).toEqual([{ id: expect.any(String), reason: 'customer_gone' }]);
    expect((await exportRows(p.id))[0]).toMatchObject({
      status: 'expired',
      reason: 'customer_gone',
      bundle: null,
    });
    expect(await readyEvents(p.id)).toEqual([]);
  });

  it('erase deletes every export of the customer, ready bundles included, counted in the audit row', async () => {
    const quin = who('quin');
    const me = await resolveCustomer(a, scopeA, quin);
    await requestCustomerExport(a, A, me.id, asCustomer(me.id));
    await claimExportRequests(a, A);
    expect((await buildPendingExports(a, A, { now: T0 })).built).toHaveLength(1);
    expect((await exportRows(me.id))[0]).toMatchObject({ status: 'ready' });
    expect(await eraseMe(a, scopeA, quin)).toEqual({ erased: true });
    expect(await exportRows(me.id)).toEqual([]);
    const audit = (await audits(me.id)).find((x) => x.action === 'customer.erase');
    expect(audit?.after).toMatchObject({ exports_deleted: 1 });
  });
});

describe("re-consent audiences (#489 condition, window 17's segment evaluation read-only)", () => {
  const consentRule = (op: 'granted' | 'not_granted' | 'never_asked'): SegmentRules =>
    ({
      v: 1,
      all: [{ any: [{ field: 'consent', op, value: 'email' }] }],
    }) as unknown as SegmentRules;
  const ids = async (op: 'granted' | 'not_granted' | 'never_asked') => {
    const q = segmentQuery(consentRule(op), 'c.id');
    // `$1` is the store id in window 17's FROM block; the rule parameters follow (as previewSegment binds them)
    return new Set((await a.query<{ id: string }>(q.text, [A, ...q.params])).rows.map((r) => r.id));
  };

  it('granted → the granted customer only; not_granted → the never-asked AND the refuser (a suppression list, not an invitation)', async () => {
    const hal = who('hal.granted');
    const ivy = who('ivy.refused');
    const jon = who('jon.never');
    const [h, i, j] = await Promise.all([
      resolveCustomer(a, scopeA, hal),
      resolveCustomer(a, scopeA, ivy),
      resolveCustomer(a, scopeA, jon),
    ]);
    await putMyConsents(a, scopeA, hal, {
      policy_version: 'v1',
      consents: [{ purpose: 'marketing_email', granted: true }],
    });
    await putMyConsents(a, scopeA, ivy, {
      policy_version: 'v1',
      consents: [{ purpose: 'marketing_email', granted: false }],
    });
    const granted = await ids('granted');
    expect(granted.has(h.id)).toBe(true);
    expect(granted.has(i.id)).toBe(false);
    expect(granted.has(j.id)).toBe(false);
    const notGranted = await ids('not_granted');
    expect(notGranted.has(h.id)).toBe(false);
    expect(notGranted.has(i.id)).toBe(true);
    expect(notGranted.has(j.id)).toBe(true);
    // the ledger tells the two apart, which the projection alone cannot for a re-consent audience
    expect((await getMyConsents(a, scopeA, ivy))[0]!.granted).toBe(false);
    expect((await getMyConsents(a, scopeA, jon))[0]!.granted).toBeNull();
  });

  it.todo(
    "never_asked → the never-asked customer ONLY: the refuser is never in a re-consent audience (REQUEST #491 — window 17's operator; until it lands no re-consent send may use not_granted)",
  );
});

describe('no personal data leaves the row', () => {
  it('no event, no audit row and no log line carries an email, a name or a subject', async () => {
    const logged: string[] = [];
    const spies = (['info', 'warn', 'error', 'log', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    try {
      await registerCustomer(a, scopeA, who('private.person', { subject: 'sub-private' }), {
        email: 'private.person@example.test',
        first_name: 'Privatename',
        last_name: 'Familyname',
        marketing_consent: true,
      });
      await expect(
        registerCustomer(a, scopeA, who('private.person', { subject: 'sub-private' }), {
          email: 'other.person@example.test',
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      await updateCustomer(a, scopeA, who('private.person', { subject: 'sub-private' }), {
        phone: '+31 6 9999 9999',
      });
      await addCustomerAddress(a, scopeA, who('private.person', { subject: 'sub-private' }), {
        first_name: 'Privatename',
        last_name: 'Familyname',
        line1: 'Secretstreet 9',
        city: 'Hiddentown',
        postal_code: '9999 ZZ',
        country: 'NL',
        phone: '+31 6 8888 8888',
      });
      await expect(
        addCustomerAddress(a, scopeA, who('private.person', { subject: 'sub-private' }), {
          first_name: 'Privatename',
          last_name: 'Familyname',
          line1: '',
          city: 'Hiddentown',
          postal_code: '9999 ZZ',
          country: 'NL',
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      // #470: edit, delete, erase
      const privateIdentity = who('private.person', { subject: 'sub-private' });
      const [mine] = await listCustomerAddresses(a, scopeA, privateIdentity);
      await updateCustomerAddress(a, scopeA, privateIdentity, mine!.id, {
        line1: 'Quietlane 4',
        phone: '+31 6 5555 5555',
      });
      await expect(
        updateCustomerAddress(a, scopeA, privateIdentity, mine!.id, { country: 'Hiddenland' }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      await deleteCustomerAddress(a, scopeA, privateIdentity, mine!.id);
      await putMyConsents(a, scopeA, privateIdentity, {
        policy_version: 'secret-policy-9',
        consents: [{ purpose: 'marketing_email', granted: false }],
      });
      await eraseMe(a, scopeA, privateIdentity);
      await eraseMe(a, scopeA, privateIdentity);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const out = await owner.query<{ doc: string }>(
      `SELECT (payload::text || headers::text) AS doc FROM outbox WHERE aggregate_type = 'customer'
       UNION ALL
       SELECT (coalesce(before::text, '') || coalesce(after::text, '')) FROM audit_log
       WHERE entity_type IN ('customer', 'customer_address')`,
    );
    const all = [...out.rows.map((r) => r.doc), ...logged].join('\n').toLowerCase();
    for (const secret of [
      '@example.test',
      'privatename',
      'familyname',
      'sub-private',
      'sub-ada',
      'secretstreet',
      'hiddentown',
      '9999 zz',
      '6 9999',
      '6 8888',
      'quietlane',
      'hiddenland',
      '6 5555',
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
