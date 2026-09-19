// Segments against a seeded throwaway database (#147): rule evaluation per operator, preview == materialised
// count, consent exclusion, organization templates and their RLS, and the window 16 sync payload.
//
// The seed creates no customers at all, so this file builds its own. Keys and names are words, never digit or
// hex tails (standing rule) — `vip-buyers`, `lapsed-dutch`, `ada@example.test`.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSegment,
  createSegmentTemplate,
  deleteSegment,
  deleteSegmentTemplate,
  getSegment,
  getSegmentTemplate,
  listSegments,
  listSegmentTemplates,
  materializeSegment,
  previewSegment,
  segmentSyncPayload,
  emailHash,
  updateSegment,
  type SegmentRules,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-segments' };

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let hq: ReturnType<typeof createOrganizationClient>;

interface CustomerSpec {
  handle: string;
  storeId?: string;
  consent?: Record<string, { granted: boolean }>;
  tags?: unknown;
  country?: string | null;
  groupId?: string | null;
  orders?: { totalMinor: number; placedAt: string; status?: string }[];
}

/** Creates a customer with optional default shipping address and orders. Returns the customer id. */
async function makeCustomer(spec: CustomerSpec): Promise<string> {
  const storeId = spec.storeId ?? A;
  const res = await db.owner.query<{ id: string }>(
    `INSERT INTO customer (organization_id, store_id, email, first_name, status, consent, metadata,
                           customer_group_id)
     VALUES ($1, $2, $3, $4, 'registered', $5, $6, $7)
     RETURNING id`,
    [
      ORG,
      storeId,
      `${spec.handle}@example.test`,
      spec.handle,
      JSON.stringify(spec.consent ?? {}),
      JSON.stringify(spec.tags === undefined ? {} : { tags: spec.tags }),
      spec.groupId ?? null,
    ],
  );
  const id = res.rows[0]!.id;

  if (spec.country) {
    await db.owner.query(
      `INSERT INTO customer_address (organization_id, store_id, customer_id, first_name, last_name, line1, city,
                                     postal_code, country, is_default_shipping)
       VALUES ($1, $2, $3, $4, 'Tester', 'One Test Street', 'Amsterdam', '1011AA', $5, true)`,
      [ORG, storeId, id, spec.handle, spec.country],
    );
  }

  for (const order of spec.orders ?? []) {
    const channel = await db.owner.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
      [storeId],
    );
    const address = JSON.stringify({
      first_name: spec.handle,
      last_name: 'Tester',
      line1: 'One Test Street',
      city: 'Amsterdam',
      postal_code: '1011AA',
      country: spec.country ?? 'NL',
    });
    await db.owner.query(
      `INSERT INTO "order" (organization_id, store_id, sales_channel_id, customer_id, email, currency, locale,
                            status, shipping_address, billing_address, subtotal_minor, total_minor, placed_at)
       VALUES ($1, $2, $3, $4, $5, 'EUR', 'en-GB', $6, $7, $7, $8, $8, $9)`,
      [
        ORG,
        storeId,
        channel.rows[0]!.id,
        id,
        `${spec.handle}@example.test`,
        order.status ?? 'confirmed',
        address,
        order.totalMinor,
        order.placedAt,
      ],
    );
  }
  return id;
}

const optedIn = { marketing_email: { granted: true } };
const optedOut = { marketing_email: { granted: false } };

async function makeSegment(rules: SegmentRules, name = 'vip-buyers') {
  return createSegment(a, A, { name, rules }, actor);
}

/** Both numbers #147 requires to agree: the preview count and what materialisation actually wrote. */
async function previewAndMaterialise(segmentId: string) {
  const preview = await previewSegment(a, A, segmentId);
  const materialised = await materializeSegment(a, A, segmentId, actor);
  const members = await db.owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM segment_member WHERE segment_id = $1`,
    [segmentId],
  );
  return {
    preview: preview.count,
    counter: materialised.materialised_count,
    rows: Number(members.rows[0]!.count),
  };
}

beforeAll(async () => {
  db = await createTestDatabase('core_segments');
  await seed(db.owner, { productsPerStore: 2, log: () => {} });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A], actorId: actor.id });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B], actorId: actor.id });
  hq = createOrganizationClient(db.app, { organizationId: ORG, actorId: SEED_IDS.users.owner });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.owner.query('DELETE FROM segment_member');
  await db.owner.query('DELETE FROM campaign');
  await db.owner.query('DELETE FROM segment');
  await db.owner.query('DELETE FROM "order"');
  await db.owner.query('DELETE FROM customer_address');
  await db.owner.query('DELETE FROM customer');
});

describe('rule evaluation, per operator', () => {
  it('counts orders, spend and recency from real orders, ignoring cancelled ones', async () => {
    await makeCustomer({
      handle: 'ada',
      orders: [
        { totalMinor: 30_000, placedAt: '2026-01-10T10:00:00Z' },
        { totalMinor: 40_000, placedAt: '2026-06-10T10:00:00Z' },
      ],
    });
    await makeCustomer({
      handle: 'grace',
      orders: [
        { totalMinor: 5_000, placedAt: '2026-02-10T10:00:00Z' },
        { totalMinor: 900_000, placedAt: '2026-02-11T10:00:00Z', status: 'cancelled' },
      ],
    });
    await makeCustomer({ handle: 'linus' }); // never ordered

    const count = async (rules: SegmentRules) =>
      (await previewSegment(a, A, (await makeSegment(rules, `probe-${Math.random()}`)).id)).count;

    expect(
      await count({ v: 1, all: [{ any: [{ field: 'orders_count', op: 'gte', value: 2 }] }] }),
    ).toBe(1);
    // A customer with no orders is zero orders, not "unknown" — linus and nobody else.
    expect(
      await count({ v: 1, all: [{ any: [{ field: 'orders_count', op: 'lte', value: 0 }] }] }),
    ).toBe(1);
    // A cancelled order is not revenue: grace counts 5 000, not 905 000.
    expect(
      await count({
        v: 1,
        all: [{ any: [{ field: 'total_spent_minor', op: 'gte', value: 70_000 }] }],
      }),
    ).toBe(1);
    expect(
      await count({
        v: 1,
        all: [{ any: [{ field: 'last_order_at', op: 'after', value: '2026-05-01T00:00:00Z' }] }],
      }),
    ).toBe(1);
    expect(
      await count({
        v: 1,
        all: [{ any: [{ field: 'last_order_at', op: 'before', value: '2026-05-01T00:00:00Z' }] }],
      }),
    ).toBe(1);
  });

  it('reads tags from customer.metadata.tags and treats anything else as no tags', async () => {
    await makeCustomer({ handle: 'wholesaler', tags: ['wholesale', 'priority'] });
    await makeCustomer({ handle: 'retail', tags: ['retail'] });
    await makeCustomer({ handle: 'untagged' }); // no tags key at all
    await makeCustomer({ handle: 'malformed', tags: 'wholesale' }); // a string, not an array

    const count = async (rules: SegmentRules) =>
      (await previewSegment(a, A, (await makeSegment(rules, `probe-${Math.random()}`)).id)).count;

    // The malformed row must neither match nor throw: the grammar is total over real data.
    expect(
      await count({
        v: 1,
        all: [{ any: [{ field: 'tags', op: 'includes', value: 'wholesale' }] }],
      }),
    ).toBe(1);
    expect(
      await count({
        v: 1,
        all: [{ any: [{ field: 'tags', op: 'excludes', value: 'wholesale' }] }],
      }),
    ).toBe(3);
  });

  it('matches country on the default shipping address only', async () => {
    const dutch = await makeCustomer({ handle: 'dutch', country: 'NL' });
    await makeCustomer({ handle: 'german', country: 'DE' });
    await makeCustomer({ handle: 'addressless' });

    // A second, non-default address must not pull someone into a geo campaign (manager decision).
    await db.owner.query(
      `INSERT INTO customer_address (organization_id, store_id, customer_id, first_name, last_name, line1, city,
                                     postal_code, country, is_default_shipping)
       VALUES ($1, $2, $3, 'dutch', 'Tester', 'Old Street', 'Berlin', '10115', 'DE', false)`,
      [ORG, A, dutch],
    );

    const count = async (rules: SegmentRules) =>
      (await previewSegment(a, A, (await makeSegment(rules, `probe-${Math.random()}`)).id)).count;

    expect(
      await count({ v: 1, all: [{ any: [{ field: 'country', op: 'in', value: ['DE'] }] }] }),
    ).toBe(1);
    expect(
      await count({ v: 1, all: [{ any: [{ field: 'country', op: 'in', value: ['NL', 'DE'] }] }] }),
    ).toBe(2);
    // No address at all counts as "not in NL", so not_in is total too.
    expect(
      await count({ v: 1, all: [{ any: [{ field: 'country', op: 'not_in', value: ['NL'] }] }] }),
    ).toBe(2);
  });

  it('matches customer_group_ids against the single group column', async () => {
    const group = await db.owner.query<{ id: string }>(
      `INSERT INTO customer_group (organization_id, store_id, code, name) VALUES ($1, $2, 'trade', 'Trade')
       RETURNING id`,
      [ORG, A],
    );
    const groupId = group.rows[0]!.id;
    await makeCustomer({ handle: 'trader', groupId });
    await makeCustomer({ handle: 'ungrouped' });

    const count = async (rules: SegmentRules) =>
      (await previewSegment(a, A, (await makeSegment(rules, `probe-${Math.random()}`)).id)).count;

    expect(
      await count({
        v: 1,
        all: [{ any: [{ field: 'customer_group_ids', op: 'in', value: [groupId] }] }],
      }),
    ).toBe(1);
    expect(
      await count({
        v: 1,
        all: [{ any: [{ field: 'customer_group_ids', op: 'not_in', value: [groupId] }] }],
      }),
    ).toBe(1);
  });

  it('combines groups as AND and predicates inside a group as OR', async () => {
    await makeCustomer({
      handle: 'big-spender',
      consent: optedIn,
      orders: [{ totalMinor: 80_000, placedAt: '2026-03-01T10:00:00Z' }],
    });
    await makeCustomer({
      handle: 'frequent',
      consent: optedIn,
      orders: [
        { totalMinor: 1_000, placedAt: '2026-03-01T10:00:00Z' },
        { totalMinor: 1_000, placedAt: '2026-03-02T10:00:00Z' },
        { totalMinor: 1_000, placedAt: '2026-03-03T10:00:00Z' },
      ],
    });
    await makeCustomer({
      handle: 'silent',
      consent: optedOut,
      orders: [{ totalMinor: 90_000, placedAt: '2026-03-01T10:00:00Z' }],
    });

    const segment = await makeSegment({
      v: 1,
      all: [
        {
          any: [
            { field: 'total_spent_minor', op: 'gte', value: 50_000 },
            { field: 'orders_count', op: 'gte', value: 3 },
          ],
        },
        { any: [{ field: 'consent', op: 'granted', value: 'email' }] },
      ],
    });
    // big-spender and frequent qualify on the OR; silent fails the consent AND.
    expect((await previewSegment(a, A, segment.id)).count).toBe(2);
  });
});

describe('consent', () => {
  it('excludes customers who have not opted in, including malformed consent blocks', async () => {
    await makeCustomer({ handle: 'subscriber', consent: optedIn });
    await makeCustomer({ handle: 'refuser', consent: optedOut });
    await makeCustomer({ handle: 'never-asked' }); // {}
    await db.owner.query(
      `INSERT INTO customer (organization_id, store_id, email, status, consent)
       VALUES ($1, $2, 'odd@example.test', 'registered', '{"marketing_email": "yes"}'::jsonb)`,
      [ORG, A],
    );

    const granted = await makeSegment(
      { v: 1, all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }] },
      'opted-in',
    );
    // Only a real boolean true counts; a string "yes" is not consent and must not throw either.
    expect((await previewSegment(a, A, granted.id)).count).toBe(1);

    const notGranted = await makeSegment(
      { v: 1, all: [{ any: [{ field: 'consent', op: 'not_granted', value: 'email' }] }] },
      'not-opted-in',
    );
    expect((await previewSegment(a, A, notGranted.id)).count).toBe(3);
  });

  it('never counts an erased or disabled customer', async () => {
    await makeCustomer({ handle: 'active', consent: optedIn });
    for (const status of ['erased', 'disabled']) {
      await db.owner.query(
        `INSERT INTO customer (organization_id, store_id, email, status, consent)
         VALUES ($1, $2, $3, $4, '{"marketing_email": {"granted": true}}'::jsonb)`,
        [ORG, A, `${status}@example.test`, status],
      );
    }
    const segment = await makeSegment({ v: 1, all: [] }, 'everyone');
    expect((await previewSegment(a, A, segment.id)).count).toBe(1);
  });
});

describe('preview and materialise agree', () => {
  it('writes exactly the customers the preview counted, and updates the counters', async () => {
    await makeCustomer({
      handle: 'ada',
      consent: optedIn,
      orders: [{ totalMinor: 60_000, placedAt: '2026-03-01T10:00:00Z' }],
    });
    await makeCustomer({
      handle: 'grace',
      consent: optedIn,
      orders: [{ totalMinor: 70_000, placedAt: '2026-03-02T10:00:00Z' }],
    });
    await makeCustomer({
      handle: 'linus',
      consent: optedOut,
      orders: [{ totalMinor: 80_000, placedAt: '2026-03-03T10:00:00Z' }],
    });

    const segment = await makeSegment({
      v: 1,
      all: [
        { any: [{ field: 'total_spent_minor', op: 'gte', value: 50_000 }] },
        { any: [{ field: 'consent', op: 'granted', value: 'email' }] },
      ],
    });

    const counts = await previewAndMaterialise(segment.id);
    expect(counts).toEqual({ preview: 2, counter: 2, rows: 2 });

    const stored = await getSegment(a, A, segment.id);
    expect(stored.materialised_count).toBe(2);
    expect(stored.last_materialised_at).not.toBeNull();
  });

  it('replaces members rather than accumulating them', async () => {
    const ada = await makeCustomer({ handle: 'ada', consent: optedIn });
    await makeCustomer({ handle: 'grace', consent: optedIn });
    const segment = await makeSegment(
      { v: 1, all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }] },
      'opted-in',
    );
    expect((await previewAndMaterialise(segment.id)).rows).toBe(2);

    // Grace withdraws consent; the next materialise must drop her, not keep a stale row.
    await db.owner.query(
      `UPDATE customer SET consent = '{"marketing_email": {"granted": false}}'::jsonb
        WHERE email = 'grace@example.test'`,
    );
    const after = await previewAndMaterialise(segment.id);
    expect(after).toEqual({ preview: 1, counter: 1, rows: 1 });

    const remaining = await db.owner.query<{ customer_id: string }>(
      `SELECT customer_id FROM segment_member WHERE segment_id = $1`,
      [segment.id],
    );
    expect(remaining.rows.map((r) => r.customer_id)).toEqual([ada]);
  });

  it('previews rules from the body without saving them', async () => {
    await makeCustomer({ handle: 'ada', consent: optedIn });
    await makeCustomer({ handle: 'grace', consent: optedOut });
    const segment = await makeSegment({ v: 1, all: [] }, 'everyone');

    const previewed = await previewSegment(a, A, segment.id, {
      v: 1,
      all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }],
    });
    expect(previewed.count).toBe(1);

    // Nothing was saved: the stored rules still match everyone and no members were written.
    expect((await getSegment(a, A, segment.id)).rules).toEqual({ v: 1, all: [] });
    expect((await previewSegment(a, A, segment.id)).count).toBe(2);
    const members = await db.owner.query(`SELECT 1 FROM segment_member`);
    expect(members.rowCount).toBe(0);
  });

  it('rejects rules the grammar does not know, at save and at preview', async () => {
    const segment = await makeSegment({ v: 1, all: [] }, 'everyone');
    await expect(
      createSegment(a, A, { name: 'bad-rules', rules: { orders_count: { gte: 2 } } }, actor),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      previewSegment(a, A, segment.id, {
        v: 1,
        all: [{ any: [{ field: 'moon_phase', op: 'eq', value: 1 }] }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('organization templates', () => {
  const vipRules: SegmentRules = {
    v: 1,
    all: [{ any: [{ field: 'total_spent_minor', op: 'gte', value: 50_000 }] }],
  };

  it('is visible in organization scope and invisible to a store client (RLS store_nullable)', async () => {
    const template = await createSegmentTemplate(
      hq,
      { name: 'vip-template', rules: vipRules },
      actor,
    );
    expect(template.store_id).toBeNull();

    expect((await listSegmentTemplates(hq)).items.map((t) => t.name)).toEqual(['vip-template']);
    expect(await getSegmentTemplate(hq, template.id)).toMatchObject({ name: 'vip-template' });

    // A store client sees no template rows at all — not in its segment list, not by id.
    expect((await listSegments(a, A)).total).toBe(0);
    await expect(getSegment(a, A, template.id)).rejects.toMatchObject({ code: 'not_found' });
    const direct = await a.query(`SELECT id FROM segment WHERE store_id IS NULL`);
    expect(direct.rowCount).toBe(0);
  });

  it('copies the rules into a store segment at creation, and stops tracking the template afterwards', async () => {
    const template = await createSegmentTemplate(
      hq,
      { name: 'vip-template', rules: vipRules },
      actor,
    );
    const segment = await createSegment(
      a,
      A,
      { name: 'vip-buyers', template_id: template.id },
      actor,
      hq,
    );

    expect(segment.template_id).toBe(template.id);
    expect(segment.rules).toEqual(vipRules);

    // Editing the template must not silently change who a live campaign reaches.
    await db.owner.query(`UPDATE segment SET rules = '{"v":1,"all":[]}'::jsonb WHERE id = $1`, [
      template.id,
    ]);
    expect((await getSegment(a, A, segment.id)).rules).toEqual(vipRules);

    // Deleting the template leaves the segment working.
    await deleteSegmentTemplate(hq, template.id, actor);
    expect((await getSegment(a, A, segment.id)).rules).toEqual(vipRules);
  });

  it('refuses a template that does not exist, and rules alongside template_id', async () => {
    await expect(
      createSegment(
        a,
        A,
        { name: 'nope', template_id: '3f2a6d1e-4b7c-4a9e-8d5f-2c6b1a9e7d40' },
        actor,
        hq,
      ),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { template_id: expect.any(String) },
    });

    const template = await createSegmentTemplate(
      hq,
      { name: 'vip-template', rules: vipRules },
      actor,
    );
    await expect(
      createSegment(a, A, { name: 'both', template_id: template.id, rules: vipRules }, actor, hq),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses a template created from a template', async () => {
    const template = await createSegmentTemplate(
      hq,
      { name: 'vip-template', rules: vipRules },
      actor,
    );
    await expect(
      createSegmentTemplate(hq, { name: 'derived', template_id: template.id }, actor),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('store isolation and lifecycle', () => {
  it('keeps segments and members inside their store', async () => {
    await makeCustomer({ handle: 'ada', consent: optedIn });
    await makeCustomer({ handle: 'bruno', storeId: B, consent: optedIn });

    const mine = await makeSegment(
      { v: 1, all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }] },
      'opted-in',
    );
    await materializeSegment(a, A, mine.id, actor);

    // Brand B's customer is not in brand A's segment, and brand B cannot see the segment at all.
    expect((await getSegment(a, A, mine.id)).materialised_count).toBe(1);
    await expect(getSegment(b, B, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(materializeSegment(b, A, mine.id, actor)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('updates and deletes, and refuses to delete a segment a live campaign points at', async () => {
    const segment = await makeSegment({ v: 1, all: [] }, 'everyone');

    const renamed = await updateSegment(
      a,
      A,
      segment.id,
      { name: 'all-customers', rules: { v: 1, all: [] } },
      actor,
    );
    expect(renamed.name).toBe('all-customers');

    await db.owner.query(
      `INSERT INTO campaign (organization_id, store_id, name, type, status, segment_id)
       VALUES ($1, $2, 'spring-mailer', 'email', 'active', $3)`,
      [ORG, A, segment.id],
    );
    await expect(deleteSegment(a, A, segment.id, actor)).rejects.toMatchObject({
      code: 'conflict',
    });

    await db.owner.query(`UPDATE campaign SET status = 'ended' WHERE segment_id = $1`, [
      segment.id,
    ]);
    await deleteSegment(a, A, segment.id, actor);
    await expect(getSegment(a, A, segment.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the window 16 sync payload', () => {
  it('returns materialised members as ids and hashes, never an address', async () => {
    await makeCustomer({
      handle: 'ada',
      consent: { marketing_email: { granted: true }, marketing_sms: { granted: true } },
    });
    await makeCustomer({ handle: 'grace', consent: optedIn });
    await makeCustomer({ handle: 'linus', consent: optedOut });

    const segment = await makeSegment(
      { v: 1, all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }] },
      'opted-in',
    );
    await materializeSegment(a, A, segment.id, actor);

    const payload = await segmentSyncPayload(a, A, segment.id);
    expect(payload).toMatchObject({
      segment_id: segment.id,
      store_id: A,
      name: 'opted-in',
      materialised_count: 2,
      next_cursor: null,
    });
    expect(payload.members).toHaveLength(2);

    // No address anywhere in the payload — only the hash the events convention uses.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('@example.test');
    expect(payload.members.map((m) => m.email_hash)).toContain(emailHash('ada@example.test'));
    expect(payload.members.every((m) => m.consent.includes('email'))).toBe(true);
    expect(
      payload.members.find((m) => m.email_hash === emailHash('ada@example.test'))!.consent,
    ).toEqual(['email', 'sms']);
  });

  it('pages with a stable cursor', async () => {
    for (const handle of ['ada', 'bruno', 'clara', 'dinesh']) {
      await makeCustomer({ handle, consent: optedIn });
    }
    const segment = await makeSegment(
      { v: 1, all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }] },
      'opted-in',
    );
    await materializeSegment(a, A, segment.id, actor);

    const first = await segmentSyncPayload(a, A, segment.id, { limit: 3 });
    expect(first.members).toHaveLength(3);
    expect(first.next_cursor).not.toBeNull();

    const second = await segmentSyncPayload(a, A, segment.id, {
      limit: 3,
      after: first.next_cursor!,
    });
    expect(second.members).toHaveLength(1);
    expect(second.next_cursor).toBeNull();

    const seen = [...first.members, ...second.members].map((m) => m.customer_id);
    expect(new Set(seen).size).toBe(4);
  });

  it('404s for a segment of another store', async () => {
    const segment = await makeSegment({ v: 1, all: [] }, 'everyone');
    await expect(segmentSyncPayload(b, B, segment.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
