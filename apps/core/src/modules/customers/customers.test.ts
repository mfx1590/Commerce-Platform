// Customers module (#303): resolve-or-provision from a verified token, register, the email collision rule,
// disabled / erased, and what reaches the outbox and the audit log. Runs as platform_app (RLS enforced) over a
// seeded throwaway database. The seed has no customers, so every row here is made by the test. Keys are words.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ADDRESS_LIMIT,
  addCustomerAddress,
  customerEmailHash,
  findCustomerForSubject,
  listCustomerAddresses,
  registerCustomer,
  resolveCustomer,
  updateCustomer,
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

  it('a "false" on a customer who was never asked records no consent decision', async () => {
    const { customer } = await registerCustomer(a, scopeA, who('barbara'), {
      email: 'barbara@example.test',
      marketing_consent: false,
    });
    expect(customer.marketing_consent).toBe(false);
    expect((await rowsOf(A, 'barbara@example.test'))[0]!.consent).toEqual({});
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
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
