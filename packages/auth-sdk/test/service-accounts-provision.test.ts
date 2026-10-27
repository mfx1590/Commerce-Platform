// Production provisioning of the service accounts (#632): `provisionServiceAccounts` against a throw-away Postgres
// database (seeded, then the service-account rows removed = a production database before the run) and a throw-away
// OpenFGA store with NO tuples. Dry run writes nothing; the first run creates 2 rows + 3 assignments (tuple + mirror
// + audit); the second changes nothing; an unknown store code changes nothing; extra assignments are reported,
// never removed; a row with another subject is refused. The CLI's argument / environment refusals run too.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrganizationClient, seed, SEED_IDS, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOpenFgaClient,
  provisionServiceAccounts,
  SERVICE_ACCOUNTS,
  seedOpenFga,
  type OpenFgaClient,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const IDS = SERVICE_ACCOUNTS.map((a) => a.staffUserId);
const CRM = SEED_IDS.serviceAccounts.crmSync;
const ANALYTICS = SEED_IDS.serviceAccounts.analyticsSync;

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const fgaUp = await up(`${API}/healthz`);
const dbUp = Boolean(process.env.DATABASE_URL);

describe('provision:service-accounts CLI refusals (no database touched)', () => {
  const cli = createRequire(import.meta.url).resolve('tsx/cli');
  const script = resolve(here, '../scripts/provision-service-accounts.ts');
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [cli, script, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('refuses without --crm-sync-stores', () => {
    const r = run([], { OPENFGA_STORE_ID: 'unit-store' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--crm-sync-stores is required');
  });

  it('refuses without OPENFGA_STORE_ID (an empty value counts as unset)', () => {
    const r = run(['--crm-sync-stores', 'brand-a', '--dry-run'], { OPENFGA_STORE_ID: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('OPENFGA_STORE_ID is not set');
  });

  it('refuses an unknown argument', () => {
    const r = run(['--crm-sync-stores', 'brand-a', '--force'], { OPENFGA_STORE_ID: 'unit-store' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown argument --force');
  });
});

describe.runIf(fgaUp && dbUp)(
  'provisionServiceAccounts (live OpenFGA + throw-away Postgres)',
  () => {
    let db: TestDatabase;
    let fga: OpenFgaClient;
    let fgaStoreId: string;
    let org: ScopedClient;

    const counts = async () => {
      const q = async (sql: string) =>
        Number((await db.owner.query<{ n: string }>(sql, [IDS])).rows[0]!.n);
      return {
        users: await q('SELECT count(*) AS n FROM staff_user WHERE id = ANY($1)'),
        roles: await q('SELECT count(*) AS n FROM role_assignment WHERE staff_user_id = ANY($1)'),
        audit: await q(
          `SELECT count(*) AS n FROM audit_log
         WHERE entity_id::text = ANY($1::text[]) OR (after->>'staff_user_id') = ANY($1::text[])`,
        ),
      };
    };
    const tuplesOf = async (staffUserId: string) =>
      (await fga.read({ user: `user:${staffUserId}`, object: 'store:' })).tuples.length +
      (await fga.read({ user: `user:${staffUserId}`, object: 'organization:' })).tuples.length;

    beforeAll(async () => {
      db = await createTestDatabase('platform_provision_service_accounts');
      await seed(db.owner, { productsPerStore: 1, log: () => {} });
      // A production database before the run: no service-account rows.
      await db.owner.query('DELETE FROM role_assignment WHERE staff_user_id = ANY($1)', [IDS]);
      await db.owner.query('DELETE FROM staff_user WHERE id = ANY($1)', [IDS]);
      const seeded = await seedOpenFga({
        apiUrl: API,
        storeName: `provision-service-accounts-${Date.now()}`,
        tuples: [],
      });
      fga = seeded.client;
      fgaStoreId = seeded.storeId;
      org = createOrganizationClient(db.app, {
        organizationId: SEED_IDS.organization,
        actorId: null,
      });
    }, 120_000);

    afterAll(async () => {
      await db?.drop();
      if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
    });

    it('an unknown store code refuses before any write', async () => {
      await expect(
        provisionServiceAccounts({ db: org, fga }, { crmSyncStoreCodes: ['brand-a', 'brand-zz'] }),
      ).rejects.toMatchObject({ status: 400, details: { field: 'crm_sync_store_codes' } });
      await expect(
        provisionServiceAccounts({ db: org, fga }, { crmSyncStoreCodes: [' ', ''] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await counts()).toEqual({ users: 0, roles: 0, audit: 0 });
    });

    it('dry run reports what it would do and writes nothing', async () => {
      const r = await provisionServiceAccounts(
        { db: org, fga },
        { crmSyncStoreCodes: ['brand-a'], dryRun: true },
      );
      expect(r.dryRun).toBe(true);
      expect(r.users.map((u) => u.status)).toEqual(['created', 'created']);
      expect(r.assignments).toEqual([
        { clientId: 'crm-sync', relation: 'support', object: 'store:brand-a', status: 'created' },
        {
          clientId: 'analytics-sync',
          relation: 'analyst',
          object: 'organization:hq',
          status: 'created',
        },
        {
          clientId: 'analytics-sync',
          relation: 'finance',
          object: 'organization:hq',
          status: 'created',
        },
      ]);
      expect(await counts()).toEqual({ users: 0, roles: 0, audit: 0 });
      expect(await tuplesOf(CRM)).toBe(0);
    });

    it('first run: the two rows (fixed ids, pinned subjects) and the three assignments, audited as the system', async () => {
      const r = await provisionServiceAccounts(
        { db: org, fga },
        { crmSyncStoreCodes: ['brand-a'] },
      );
      expect(r.users).toEqual([
        { clientId: 'crm-sync', staffUserId: CRM, status: 'created' },
        { clientId: 'analytics-sync', staffUserId: ANALYTICS, status: 'created' },
      ]);
      expect(r.assignments.every((a) => a.status === 'created')).toBe(true);
      expect(r.extra).toEqual([]);

      const rows = await db.owner.query<{ id: string; keycloak_subject: string; status: string }>(
        'SELECT id, keycloak_subject, status FROM staff_user WHERE id = ANY($1) ORDER BY id',
        [IDS],
      );
      expect(rows.rows).toEqual([
        { id: CRM, keycloak_subject: 'seed-crm-sync', status: 'active' },
        { id: ANALYTICS, keycloak_subject: 'seed-analytics-sync', status: 'active' },
      ]);
      expect(await counts()).toEqual({ users: 2, roles: 3, audit: 5 });
      const actors = await db.owner.query<{ actor_type: string; actor_id: string | null }>(
        `SELECT DISTINCT actor_type, actor_id FROM audit_log
       WHERE entity_id::text = ANY($1::text[]) OR (after->>'staff_user_id') = ANY($1::text[])`,
        [IDS],
      );
      expect(actors.rows).toEqual([{ actor_type: 'system', actor_id: null }]);

      // The tuples decide: crm-sync support on brand A only; analytics-sync analyst + finance on the organization.
      const check = async (u: string, relation: string, object: string) =>
        (await fga.check({ user: `user:${u}`, relation, object })).allowed;
      expect(await check(CRM, 'support', `store:${SEED_IDS.stores.brandA}`)).toBe(true);
      expect(await check(CRM, 'support', `store:${SEED_IDS.stores.brandB}`)).toBe(false);
      expect(await check(ANALYTICS, 'analyst', 'organization:hq')).toBe(true);
      expect(await check(ANALYTICS, 'finance', 'organization:hq')).toBe(true);
      expect(await check(ANALYTICS, 'owner', 'organization:hq')).toBe(false);
    });

    it('second run: nothing changes (idempotent), and a dry run now reports everything present', async () => {
      const before = await counts();
      const r = await provisionServiceAccounts(
        { db: org, fga },
        { crmSyncStoreCodes: ['brand-a'] },
      );
      expect(r.users.map((u) => u.status)).toEqual(['present', 'present']);
      expect(r.assignments.map((a) => a.status)).toEqual(['present', 'present', 'present']);
      expect(await counts()).toEqual(before);
      const dry = await provisionServiceAccounts(
        { db: org, fga },
        { crmSyncStoreCodes: ['brand-a'], dryRun: true },
      );
      expect([...dry.users, ...dry.assignments].every((x) => x.status === 'present')).toBe(true);
    });

    it('an assignment beyond the requested ones is reported as extra, never removed', async () => {
      await provisionServiceAccounts(
        { db: org, fga },
        { crmSyncStoreCodes: ['brand-a', 'brand-b'] },
      );
      const r = await provisionServiceAccounts(
        { db: org, fga },
        { crmSyncStoreCodes: ['brand-a'] },
      );
      expect(r.extra).toEqual([
        { clientId: 'crm-sync', relation: 'support', object: 'store:brand-b' },
      ]);
      expect((await counts()).roles).toBe(4);
    });

    it('a row holding the fixed id with another subject is refused, never rewritten', async () => {
      await db.owner.query(
        `UPDATE staff_user SET keycloak_subject = 'someone-else' WHERE id = $1`,
        [CRM],
      );
      try {
        await expect(
          provisionServiceAccounts({ db: org, fga }, { crmSyncStoreCodes: ['brand-a'] }),
        ).rejects.toMatchObject({ status: 409, code: 'conflict' });
        const row = await db.owner.query<{ keycloak_subject: string }>(
          'SELECT keycloak_subject FROM staff_user WHERE id = $1',
          [CRM],
        );
        expect(row.rows[0]!.keycloak_subject).toBe('someone-else');
      } finally {
        await db.owner.query(
          `UPDATE staff_user SET keycloak_subject = 'seed-crm-sync' WHERE id = $1`,
          [CRM],
        );
      }
    });
  },
);
