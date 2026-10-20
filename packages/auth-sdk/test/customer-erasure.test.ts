// customer.erased consumer (issue #483): delete the customers-realm Keycloak user of an erased row unless a
// live row of the organization still carries the subject. Unit part: scripted db + admin client, every outcome
// and the envelope guard. Live part: a throw-away Postgres database (two stores, one fake subject) and the
// test's OWN customers-realm Keycloak user created and deleted through the core-admin service account — the
// seeded Jane is never touched.
import { randomUUID } from 'node:crypto';
import {
  ApiError,
  createCustomerErasureConsumer,
  createKeycloakAdmin,
  deleteErasedCustomerIdentity,
  onCustomerErased,
  type CustomerErasureDeps,
  type KeycloakAdmin,
} from '../src/index.js';
import { createOrganizationClient, seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const ORG = SEED_IDS.organization;
const S = SEED_IDS.stores;

// ------------------------------------------------------------------------------------------------------- unit
interface Scripted {
  rows: Record<string, { status: string; keycloak_subject: string | null; store_id: string }>;
  liveBySubject: Record<string, number>;
  deleted: string[];
  audits: unknown[];
  deleteAnswer?: 'deleted' | 'not_found' | 'down';
}
function scripted(script: Scripted): CustomerErasureDeps {
  const db = {
    context: { organizationId: ORG, actorId: null },
    scope: 'organization' as const,
    async query(text: string, params: unknown[] = []) {
      if (text.startsWith('SELECT status, keycloak_subject, store_id')) {
        const r = script.rows[String(params[0])];
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 } as never;
      }
      if (text.includes('count(*)')) {
        return {
          rows: [{ n: String(script.liveBySubject[String(params[0])] ?? 0) }],
          rowCount: 1,
        } as never;
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const tx = {
        async query(text: string, params: unknown[]) {
          if (text.includes('INSERT INTO audit_log')) {
            script.audits.push(params);
            return { rows: [{ id: randomUUID() }], rowCount: 1 };
          }
          throw new Error(`unexpected tx query: ${text}`);
        },
      };
      return fn(tx as never);
    },
  };
  const keycloak: Pick<KeycloakAdmin, 'deleteUser' | 'realm'> = {
    realm: 'customers',
    async deleteUser(subject) {
      if (script.deleteAnswer === 'down') {
        throw new ApiError(503, 'internal', 'identity provider unavailable', {
          what: 'delete user',
        });
      }
      script.deleted.push(subject);
      return script.deleteAnswer ?? 'deleted';
    },
  };
  return { db: db as unknown as CustomerErasureDeps['db'], keycloak };
}
const erasedRow = (subject: string | null, store = S.brandA) => ({
  status: 'erased',
  keycloak_subject: subject,
  store_id: store,
});

describe('deleteErasedCustomerIdentity (unit, scripted)', () => {
  const customerId = randomUUID();
  const subject = `kc-${randomUUID()}`;

  it('erased row, no live row elsewhere → the Keycloak user is deleted, one audit row with ids and the outcome', async () => {
    const s: Scripted = {
      rows: { [customerId]: erasedRow(subject) },
      liveBySubject: {},
      deleted: [],
      audits: [],
    };
    const r = await deleteErasedCustomerIdentity(scripted(s), { customerId });
    expect(r).toEqual({ customerId, outcome: 'deleted', liveRows: 0 });
    expect(s.deleted).toEqual([subject]);
    expect(s.audits).toHaveLength(1);
    expect(JSON.stringify(s.audits)).not.toContain(subject); // never in the audit row
  });

  it('erased row while another store still has a live row with the subject → kept, nothing deleted', async () => {
    const s: Scripted = {
      rows: { [customerId]: erasedRow(subject) },
      liveBySubject: { [subject]: 1 },
      deleted: [],
      audits: [],
    };
    const r = await deleteErasedCustomerIdentity(scripted(s), { customerId });
    expect(r).toEqual({ customerId, outcome: 'kept_live_elsewhere', liveRows: 1 });
    expect(s.deleted).toEqual([]);
    expect(s.audits).toHaveLength(1);
  });

  it('replay: Keycloak has no such user any more → already_gone (no error, audited)', async () => {
    const s: Scripted = {
      rows: { [customerId]: erasedRow(subject) },
      liveBySubject: {},
      deleted: [],
      audits: [],
      deleteAnswer: 'not_found',
    };
    const r = await deleteErasedCustomerIdentity(scripted(s), { customerId });
    expect(r.outcome).toBe('already_gone');
  });

  it('nothing to delete: unknown id, a row that is not erased, a guest row without a subject — no audit row', async () => {
    const live = randomUUID();
    const guest = randomUUID();
    const s: Scripted = {
      rows: {
        [live]: { status: 'registered', keycloak_subject: subject, store_id: S.brandA },
        [guest]: erasedRow(null),
      },
      liveBySubject: {},
      deleted: [],
      audits: [],
    };
    for (const id of [randomUUID(), live, guest]) {
      const r = await deleteErasedCustomerIdentity(scripted(s), { customerId: id });
      expect(r.outcome, id).toBe('nothing_to_delete');
    }
    expect(s.deleted).toEqual([]);
    expect(s.audits).toEqual([]);
  });

  it('Keycloak unreachable → 503 fail closed, nothing audited (the consumer retries later)', async () => {
    const s: Scripted = {
      rows: { [customerId]: erasedRow(subject) },
      liveBySubject: {},
      deleted: [],
      audits: [],
      deleteAnswer: 'down',
    };
    await expect(deleteErasedCustomerIdentity(scripted(s), { customerId })).rejects.toMatchObject({
      status: 503,
    });
    expect(s.audits).toEqual([]);
  });

  it('refuses a non-uuid id (400) and a client bound to another realm (500) before touching anything', async () => {
    const s: Scripted = { rows: {}, liveBySubject: {}, deleted: [], audits: [] };
    await expect(
      deleteErasedCustomerIdentity(scripted(s), { customerId: 'nope' }),
    ).rejects.toMatchObject({
      status: 400,
    });
    const staffBound = {
      ...scripted(s),
      keycloak: { realm: 'staff', deleteUser: async () => 'deleted' as const },
    };
    await expect(deleteErasedCustomerIdentity(staffBound, { customerId })).rejects.toMatchObject({
      status: 500,
    });
  });

  it('onCustomerErased: handles customer.erased v1 of this organization, ignores anything else with a typed reason', async () => {
    const s: Scripted = {
      rows: { [customerId]: erasedRow(subject) },
      liveBySubject: {},
      deleted: [],
      audits: [],
    };
    const base = {
      event_id: randomUUID(),
      topic: 'customer.erased',
      version: 1,
      organization_id: ORG,
      payload: { customer_id: customerId },
    };
    expect(await onCustomerErased(scripted(s), { ...base, topic: 'customer.updated' })).toEqual({
      handled: false,
      reason: 'wrong_topic',
    });
    expect(await onCustomerErased(scripted(s), { ...base, version: 2 })).toEqual({
      handled: false,
      reason: 'unsupported_version',
    });
    expect(await onCustomerErased(scripted(s), { ...base, organization_id: randomUUID() })).toEqual(
      {
        handled: false,
        reason: 'wrong_organization',
      },
    );
    expect(s.deleted).toEqual([]);
    const handled = await onCustomerErased(scripted(s), base);
    expect(handled).toEqual({
      handled: true,
      result: { customerId, outcome: 'deleted', liveRows: 0 },
    });
  });
});

// ------------------------------------------------------------------------------------------------------- live
async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const live =
  (await up(`${KC}/realms/customers/.well-known/openid-configuration`)) &&
  Boolean(process.env.DATABASE_URL);

describe.runIf(live)(
  'customer erasure (live Keycloak customers realm + throw-away Postgres)',
  () => {
    let db: TestDatabase;
    let admin: KeycloakAdmin;
    const created: string[] = [];

    beforeAll(async () => {
      db = await createTestDatabase('platform_erasure');
      await seed(db.owner, { productsPerStore: 1, log: () => {} });
      // customer_erasure_claim comes with the migrations (db 0.3.13 / 0199, CONTRACT CHANGE #512).
      admin = createKeycloakAdmin({
        realm: 'customers',
        clientId: process.env.KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_ID ?? 'core-admin',
        clientSecret: process.env.KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_SECRET,
      });
    }, 120_000);
    afterAll(async () => {
      const failures: string[] = [];
      for (const subject of created) {
        await admin
          .deleteUser(subject)
          .catch((e: Error) => failures.push(`${subject}: ${e.message}`));
      }
      await db?.drop();
      if (failures.length) throw new Error(`erasure cleanup failed: ${failures.join('; ')}`);
    });

    /** A throwaway customers-realm user; its subject goes on the customer rows below. */
    async function throwawayUser(): Promise<string> {
      const u = await admin.createUser({
        email: `erasure-${randomUUID()}@example.com`,
        displayName: 'Erasure Throwaway',
      });
      created.push(u.subject);
      return u.subject;
    }
    async function customerRow(
      storeId: string,
      subject: string | null,
      status: string,
    ): Promise<string> {
      const id = randomUUID();
      await db.owner.query(
        `INSERT INTO customer (id, organization_id, store_id, keycloak_subject, email, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ORG, storeId, subject, `erasure-${id}@example.com`, status],
      );
      return id;
    }
    const deps = (): CustomerErasureDeps => ({
      db: createOrganizationClient(db.app, { organizationId: ORG, actorId: null }),
      keycloak: admin,
    });

    it('erase in store A while store B still has a live row with the subject → kept; erase in B → deleted; replay → no-op', async () => {
      const subject = await throwawayUser();
      const a = await customerRow(S.brandA, subject, 'erased');
      const b = await customerRow(S.brandB, subject, 'registered');

      const kept = await deleteErasedCustomerIdentity(deps(), { customerId: a });
      expect(kept).toEqual({ customerId: a, outcome: 'kept_live_elsewhere', liveRows: 1 });
      expect(await admin.getUser(subject)).not.toBeNull();

      await db.owner.query(`UPDATE customer SET status = 'erased' WHERE id = $1`, [b]);
      const gone = await deleteErasedCustomerIdentity(deps(), { customerId: b });
      expect(gone).toEqual({ customerId: b, outcome: 'deleted', liveRows: 0 });
      expect(await admin.getUser(subject)).toBeNull();

      const replay = await onCustomerErased(deps(), {
        event_id: randomUUID(),
        topic: 'customer.erased',
        version: 1,
        organization_id: ORG,
        payload: { customer_id: b },
      });
      expect(replay).toEqual({
        handled: true,
        result: { customerId: b, outcome: 'already_gone', liveRows: 0 },
      });

      const audits = await db.owner.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_log WHERE action = 'customer.identity_deleted' AND entity_id = ANY($1) ORDER BY created_at`,
        [[a, b]],
      );
      expect(audits.rows.map((r) => r.after.outcome)).toEqual([
        'kept_live_elsewhere',
        'deleted',
        'already_gone',
      ]);
      expect(JSON.stringify(audits.rows)).not.toContain(subject);
      expect(JSON.stringify(audits.rows)).not.toContain('@example.com');
    }, 60_000);

    it('a guest row (no subject) has nothing to delete; the seeded Jane is never touched', async () => {
      const guest = await customerRow(S.brandC, null, 'erased');
      expect((await deleteErasedCustomerIdentity(deps(), { customerId: guest })).outcome).toBe(
        'nothing_to_delete',
      );
      expect(await admin.getUser('seed-jane')).not.toBeNull();
    });

    /** A customer.erased v1 outbox row, as gdpr.ts writes it (ids only). */
    async function erasedEvent(storeId: string, customerId: string): Promise<string> {
      const id = randomUUID();
      await db.owner.query(
        `INSERT INTO outbox (id, organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, headers, occurred_at)
       VALUES ($1, $2, $3, 'customer.erased', 1, 'customer', $4, $5, '{}'::jsonb, now())`,
        [
          id,
          ORG,
          storeId,
          customerId,
          JSON.stringify({
            customer_id: customerId,
            identity_id: null,
            erased_at: new Date().toISOString(),
          }),
        ],
      );
      return id;
    }

    it('consumer: settles each unclaimed event with one claim row after a definitive outcome; a settled event is never re-read; a Keycloak outage leaves no claim and is retried', async () => {
      const subject = await throwawayUser();
      const a = await customerRow(S.brandA, subject, 'erased');
      const b = await customerRow(S.brandB, subject, 'registered');
      const eventA = await erasedEvent(S.brandA, a);
      const guest = await customerRow(S.brandC, null, 'erased');
      const eventGuest = await erasedEvent(S.brandC, guest);
      const consumer = createCustomerErasureConsumer({
        pool: db.app,
        organizationId: ORG,
        keycloak: admin,
      });

      const first = await consumer.runOnce();
      expect(first).toMatchObject({
        processed: 2,
        retry: 0,
        outcomes: { kept_live_elsewhere: 1, nothing_to_delete: 1 },
      });
      expect(await consumer.claimOf(eventA)).toEqual({
        outcome: 'kept_live_elsewhere',
        live_rows: 1,
      });
      expect(await consumer.claimOf(eventGuest)).toEqual({
        outcome: 'nothing_to_delete',
        live_rows: 0,
      });
      expect(await admin.getUser(subject)).not.toBeNull();

      // Settled: nothing is re-read, Keycloak is not asked again.
      expect(await consumer.runOnce()).toMatchObject({ processed: 0, retry: 0 });

      // Store B erases too: with Keycloak refusing, the event stays unclaimed and is counted for retry …
      await db.owner.query(`UPDATE customer SET status = 'erased' WHERE id = $1`, [b]);
      const eventB = await erasedEvent(S.brandB, b);
      const refusing = createCustomerErasureConsumer({
        pool: db.app,
        organizationId: ORG,
        keycloak: {
          realm: 'customers',
          deleteUser: async () => {
            throw new ApiError(503, 'internal', 'identity provider unavailable', {
              what: 'delete user',
            });
          },
        },
      });
      expect(await refusing.runOnce()).toMatchObject({ processed: 0, retry: 1 });
      expect(await consumer.claimOf(eventB)).toBeNull();
      expect(await admin.getUser(subject)).not.toBeNull();

      // … and the next run with Keycloak back deletes the user and settles the event.
      expect(await consumer.runOnce()).toMatchObject({
        processed: 1,
        retry: 0,
        outcomes: { deleted: 1 },
      });
      expect(await consumer.claimOf(eventB)).toEqual({ outcome: 'deleted', live_rows: 0 });
      expect(await admin.getUser(subject)).toBeNull();
      expect(await consumer.runOnce()).toMatchObject({ processed: 0, retry: 0 });

      const claims = await db.owner.query<{ outcome: string; customer_id: string }>(
        'SELECT outcome, customer_id FROM customer_erasure_claim WHERE event_id = ANY($1) ORDER BY event_seq',
        [[eventA, eventGuest, eventB]],
      );
      expect(claims.rows.map((r) => r.outcome)).toEqual([
        'kept_live_elsewhere',
        'nothing_to_delete',
        'deleted',
      ]);
      expect(JSON.stringify(claims.rows)).not.toContain(subject);
    }, 90_000);
  },
);
