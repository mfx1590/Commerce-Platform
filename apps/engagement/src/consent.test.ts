// The consent gate (pure) and the two projection reads (on a throwaway database).
//
// The DB half matters more than it looks: it is the only thing proving we read the projection window 13
// actually maintains, in the shape the core actually writes. The fixtures therefore go through the same
// `jsonb_set` shape the core's consent ledger produces (`{granted, at, source}` per purpose), not a shape
// invented here.

import { createHash } from 'node:crypto';
import { createTenantClient, SEED_IDS, seed, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSENT_PURPOSE,
  gate,
  readCustomerFacts,
  readOrderCustomerFacts,
  type CustomerFacts,
} from './consent.js';

const ORG = SEED_IDS.organization;
const STORE_A = SEED_IDS.stores.brandA;
const STORE_B = SEED_IDS.stores.brandB;
// Computed, never a literal: the schema needs a real 64-hex sha256, and a hex literal of that length in a
// committed test is exactly the shape gitleaks flags across every branch (Memory-main). This is also how
// apps/core builds its own email_hash fixtures.
const EMAIL_HASH = createHash('sha256').update('cdp-fixture@example.test').digest('hex');

// ---- the gate, pure -----------------------------------------------------------------------------------------

const facts = (over: Partial<CustomerFacts> = {}): CustomerFacts => ({
  found: true,
  customerId: 'cust-1',
  status: 'registered',
  consent: { granted: true, at: '2026-10-20T10:00:00.000Z' },
  ...over,
});

describe('gate — consent-gated calls', () => {
  it('sends when the projection says granted', () => {
    expect(gate({ gated: true, facts: facts() })).toEqual({
      send: true,
      identity: { userId: 'cust-1', anonymousId: null },
    });
  });

  it('carries the payload s email_hash alongside the customer id when there is one', () => {
    const d = gate({ gated: true, facts: facts(), emailHash: EMAIL_HASH });
    expect(d).toEqual({ send: true, identity: { userId: 'cust-1', anonymousId: EMAIL_HASH } });
  });

  it('drops when consent was never answered', () => {
    expect(gate({ gated: true, facts: facts({ consent: { granted: null, at: null } }) })).toEqual({
      send: false,
      reason: 'consent_absent',
    });
  });

  it('drops when consent was revoked', () => {
    expect(
      gate({
        gated: true,
        facts: facts({ consent: { granted: false, at: '2026-10-21T10:00:00.000Z' } }),
      }),
    ).toEqual({ send: false, reason: 'consent_revoked' });
  });

  it('drops an erased customer even if the projection still says granted', () => {
    expect(gate({ gated: true, facts: facts({ status: 'erased' }) })).toEqual({
      send: false,
      reason: 'customer_erased',
    });
  });

  it('DROPS a guest: an email_hash alone is not an identity for a gated call', () => {
    // The manager's ruling: conservative while the lawyer question is open. An email_hash with no customer
    // row has no consent to check, so a pseudonymous track would be a decision nobody made.
    expect(
      gate({
        gated: true,
        facts: facts({ found: false, customerId: null }),
        emailHash: EMAIL_HASH,
      }),
    ).toEqual({ send: false, reason: 'no_identity' });
  });

  it('reports a vanished customer row separately from a guest', () => {
    expect(gate({ gated: true, facts: facts({ found: true, customerId: null }) })).toEqual({
      send: false,
      reason: 'customer_not_found',
    });
  });

  it('drops when the order the event points at is gone', () => {
    expect(gate({ gated: true, facts: facts(), orderFound: false })).toEqual({
      send: false,
      reason: 'order_not_found',
    });
  });
});

describe('gate — an erasure is not consent-gated', () => {
  it('sends a suppression for a customer who revoked everything', () => {
    const d = gate({ gated: false, facts: facts({ consent: { granted: false, at: null } }) });
    expect(d).toEqual({ send: true, identity: { userId: 'cust-1', anonymousId: null } });
  });

  it('sends a suppression for a customer who never answered, and for an erased one', () => {
    expect(
      gate({ gated: false, facts: facts({ consent: { granted: null, at: null } }) }).send,
    ).toBe(true);
    expect(gate({ gated: false, facts: facts({ status: 'erased' }) }).send).toBe(true);
  });

  it('suppresses by email_hash when the customer row is already gone', () => {
    const d = gate({
      gated: false,
      facts: facts({ found: false, customerId: null }),
      emailHash: EMAIL_HASH,
    });
    expect(d).toEqual({ send: true, identity: { userId: null, anonymousId: EMAIL_HASH } });
  });

  it('still needs some identity', () => {
    expect(gate({ gated: false, facts: facts({ found: false, customerId: null }) })).toEqual({
      send: false,
      reason: 'no_identity',
    });
  });
});

// ---- the projection reads, on a database --------------------------------------------------------------------

let db: TestDatabase;
let storeA: ScopedClient;
let storeB: ScopedClient;

/** Writes the projection block exactly as apps/core's consent ledger does (jsonb_set per purpose). */
async function setProjection(
  customerId: string,
  purpose: string,
  block: { granted: boolean; at: string; source: string } | null,
): Promise<void> {
  if (block === null) {
    await db.owner.query(`UPDATE customer SET consent = '{}'::jsonb WHERE id = $1`, [customerId]);
    return;
  }
  await db.owner.query(
    `UPDATE customer SET consent = jsonb_set(coalesce(consent, '{}'::jsonb), $2::text[], $3::jsonb)
      WHERE id = $1`,
    [customerId, [purpose], JSON.stringify(block)],
  );
}

async function makeCustomer(storeId: string, status = 'registered'): Promise<string> {
  const r = await db.owner.query(
    `INSERT INTO customer (organization_id, store_id, email, status, consent)
     VALUES ($1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [ORG, storeId, `cdp-${Math.random().toString(36).slice(2, 10)}@example.test`, status],
  );
  return (r.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  db = await createTestDatabase('platform_cdp');
  await seed(db.owner);
  storeA = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
  storeB = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
}, 120_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.owner.query(`DELETE FROM "order" WHERE store_id = ANY($1::uuid[])`, [
    [STORE_A, STORE_B],
  ]);
  await db.owner.query(`DELETE FROM customer WHERE store_id = ANY($1::uuid[])`, [
    [STORE_A, STORE_B],
  ]);
});

describe('readCustomerFacts', () => {
  it('reads granted consent out of the projection the core writes', async () => {
    const id = await makeCustomer(STORE_A);
    await setProjection(id, CONSENT_PURPOSE, {
      granted: true,
      at: '2026-10-20T10:00:00.000Z',
      source: 'storefront',
    });

    const f = await readCustomerFacts(storeA, id);
    expect(f).toEqual({
      found: true,
      customerId: id,
      status: 'registered',
      consent: { granted: true, at: '2026-10-20T10:00:00.000Z' },
    });
    expect(gate({ gated: true, facts: f }).send).toBe(true);
  });

  it('reads a revoked decision, and the gate drops it', async () => {
    const id = await makeCustomer(STORE_A);
    await setProjection(id, CONSENT_PURPOSE, {
      granted: false,
      at: '2026-10-21T10:00:00.000Z',
      source: 'admin',
    });
    const f = await readCustomerFacts(storeA, id);
    expect(f.consent.granted).toBe(false);
    expect(gate({ gated: true, facts: f })).toEqual({ send: false, reason: 'consent_revoked' });
  });

  it('an empty projection is "never answered", not "revoked"', async () => {
    const id = await makeCustomer(STORE_A);
    const f = await readCustomerFacts(storeA, id);
    expect(f.consent).toEqual({ granted: null, at: null });
    expect(gate({ gated: true, facts: f })).toEqual({ send: false, reason: 'consent_absent' });
  });

  it('a block for ANOTHER purpose does not grant ours', async () => {
    const id = await makeCustomer(STORE_A);
    await setProjection(id, 'some_other_purpose', {
      granted: true,
      at: '2026-10-20T10:00:00.000Z',
      source: 'import',
    });
    const f = await readCustomerFacts(storeA, id);
    expect(f.consent.granted).toBeNull();
  });

  it('a malformed block is "never answered" rather than a crash or a false grant', async () => {
    const id = await makeCustomer(STORE_A);
    await db.owner.query(
      `UPDATE customer SET consent = jsonb_build_object($2::text, '"yes"'::jsonb) WHERE id = $1`,
      [id, CONSENT_PURPOSE],
    );
    const f = await readCustomerFacts(storeA, id);
    expect(f.consent.granted).toBeNull();
  });

  it('a missing customer is not found, and the gate says so', async () => {
    const f = await readCustomerFacts(storeA, '99999999-9999-4999-8999-999999999999');
    expect(f.found).toBe(false);
    expect(gate({ gated: true, facts: f })).toEqual({ send: false, reason: 'no_identity' });
  });

  it('CONSENT IS PER STORE: another store s client cannot see this customer at all', async () => {
    const id = await makeCustomer(STORE_A);
    await setProjection(id, CONSENT_PURPOSE, {
      granted: true,
      at: '2026-10-20T10:00:00.000Z',
      source: 'storefront',
    });
    // This is why the read is scoped to the event's own store (0194: never propagated across stores).
    const fromB = await readCustomerFacts(storeB, id);
    expect(fromB.found).toBe(false);
    expect(gate({ gated: true, facts: fromB }).send).toBe(false);
  });

  it('is read-only: the gate path never writes the projection or the ledger', async () => {
    const id = await makeCustomer(STORE_A);
    await setProjection(id, CONSENT_PURPOSE, {
      granted: true,
      at: '2026-10-20T10:00:00.000Z',
      source: 'storefront',
    });
    const before = await db.owner.query(`SELECT consent, updated_at FROM customer WHERE id = $1`, [
      id,
    ]);
    await readCustomerFacts(storeA, id);
    const after = await db.owner.query(`SELECT consent, updated_at FROM customer WHERE id = $1`, [
      id,
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const ledger = await db.owner.query(`SELECT count(*)::int AS n FROM customer_consent`);
    expect((ledger.rows[0] as { n: number }).n).toBe(0);
  });
});

describe('readOrderCustomerFacts', () => {
  /** The real 0006 columns: no legal_entity_id on `order`, and a sales channel and addresses are required. */
  async function makeOrder(storeId: string, customerId: string | null): Promise<string> {
    const channel = await db.owner.query(
      `SELECT id FROM sales_channel WHERE store_id = $1 LIMIT 1`,
      [storeId],
    );
    const r = await db.owner.query(
      `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, customer_id, email,
                            currency, locale, shipping_address, billing_address,
                            subtotal_minor, shipping_minor, tax_minor, total_minor)
       VALUES ($1, $2, $3, $4, $5, $6, 'EUR', 'en-GB', '{}'::jsonb, '{}'::jsonb, 9000, 499, 1495, 10994)
       RETURNING id`,
      [
        ORG,
        storeId,
        Math.floor(Math.random() * 1_000_000) + 1000,
        (channel.rows[0] as { id: string }).id,
        customerId,
        'cdp-order@example.test',
      ],
    );
    return (r.rows[0] as { id: string }).id;
  }

  it('resolves the customer AND the consent from the order in one read', async () => {
    const customerId = await makeCustomer(STORE_A);
    await setProjection(customerId, CONSENT_PURPOSE, {
      granted: true,
      at: '2026-10-20T10:00:00.000Z',
      source: 'storefront',
    });
    const orderId = await makeOrder(STORE_A, customerId);

    const f = await readOrderCustomerFacts(storeA, orderId);
    expect(f.orderFound).toBe(true);
    expect(f.customerId).toBe(customerId);
    expect(f.consent.granted).toBe(true);
    expect(gate({ gated: true, facts: f, orderFound: f.orderFound }).send).toBe(true);
  });

  it('a GUEST order resolves no customer, and the gate drops it', async () => {
    const orderId = await makeOrder(STORE_A, null);
    const f = await readOrderCustomerFacts(storeA, orderId);
    expect(f.orderFound).toBe(true);
    expect(f.customerId).toBeNull();
    expect(f.found).toBe(false);
    expect(
      gate({ gated: true, facts: f, orderFound: f.orderFound, emailHash: EMAIL_HASH }),
    ).toEqual({
      send: false,
      reason: 'no_identity',
    });
  });

  it('a revoked customer behind an order is dropped', async () => {
    const customerId = await makeCustomer(STORE_A);
    await setProjection(customerId, CONSENT_PURPOSE, {
      granted: false,
      at: '2026-10-21T10:00:00.000Z',
      source: 'storefront',
    });
    const orderId = await makeOrder(STORE_A, customerId);
    const f = await readOrderCustomerFacts(storeA, orderId);
    expect(gate({ gated: true, facts: f, orderFound: f.orderFound })).toEqual({
      send: false,
      reason: 'consent_revoked',
    });
  });

  it('a missing order is reported as such, not as a missing customer', async () => {
    const f = await readOrderCustomerFacts(storeA, '99999999-9999-4999-8999-999999999999');
    expect(f.orderFound).toBe(false);
    expect(gate({ gated: true, facts: f, orderFound: f.orderFound })).toEqual({
      send: false,
      reason: 'order_not_found',
    });
  });

  it('another store s client cannot resolve this order either', async () => {
    const customerId = await makeCustomer(STORE_A);
    const orderId = await makeOrder(STORE_A, customerId);
    const f = await readOrderCustomerFacts(storeB, orderId);
    expect(f.orderFound).toBe(false);
  });
});
