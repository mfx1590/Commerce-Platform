// Role management through the hq-rbac HTTP layer, against docker Postgres (throw-away db) + docker OpenFGA
// (throw-away store). Issue #12.
import {
  assignRole,
  createOpenFgaClient,
  revokeRole,
  seedOpenFga,
  type OpenFgaClient,
  type RolesDeps,
  type StaffPrincipal,
} from '@platform/auth-sdk';
import { createOrganizationClient, seed, SEED_IDS, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHqRbac, HQ_RBAC_ROUTES } from '../index.js';

const ORG = SEED_IDS.organization;
const U = SEED_IDS.users;
const S = SEED_IDS.stores;
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const fgaUp = await up(`${API}/healthz`);
const dbUp = Boolean(process.env.DATABASE_URL);

const principal = (userId: string): StaffPrincipal => ({
  userId,
  subject: `seed-${userId.slice(-2)}`,
  organizationId: ORG,
});
const owner = principal(U.owner);
const storeAdmin = principal(U.storeAdmin);

describe.runIf(fgaUp && dbUp)('hq-rbac roles (live Postgres + OpenFGA)', () => {
  let db: TestDatabase;
  let fga: OpenFgaClient;
  let fgaStoreId: string;
  const changed: string[] = [];
  let rbac: ReturnType<typeof createHqRbac>;
  let hq: ScopedClient;

  const check = (u: string, relation: string, object: string) =>
    fga.check({ user: `user:${u}`, relation, object }).then((r) => r.allowed === true);
  const countRows = async (sql: string, params: unknown[] = []) =>
    Number(
      (await hq.query<{ n: string }>(`SELECT count(*)::text n FROM ${sql}`, params)).rows[0]!.n,
    );

  beforeAll(async () => {
    db = await createTestDatabase('platform_rbac');
    await seed(db.owner, { productsPerStore: 1, log: () => {} });
    const seeded = await seedOpenFga({ apiUrl: API, storeName: `rbac-test-${Date.now()}` });
    fga = seeded.client;
    fgaStoreId = seeded.storeId;
    rbac = createHqRbac({ pool: db.app, fga, onRoleChange: (id) => changed.push(id) });
    hq = createOrganizationClient(db.app, { organizationId: ORG });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
  });

  it('exposes exactly the contract routes with owner on organization:hq', () => {
    expect(HQ_RBAC_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /admin/users',
      'GET /admin/users/{userId}/roles',
      'POST /admin/users/{userId}/roles',
      'DELETE /admin/users/{userId}/roles/{assignmentId}',
    ]);
    for (const r of HQ_RBAC_ROUTES)
      expect(r.permission).toEqual({ relation: 'owner', object: 'organization:hq' });
  });

  it('returns null for paths it does not own and 401 without a principal', async () => {
    expect(
      await rbac.handle({ method: 'GET', path: '/admin/stores', principal: owner }),
    ).toBeNull();
    const res = await rbac.handle({ method: 'GET', path: '/admin/users', principal: null });
    expect(res).toEqual({
      status: 401,
      body: { code: 'unauthorized', message: 'Missing bearer token', details: {} },
    });
  });

  it('store-admin (two stores) gets the contract 403 on every roles route', async () => {
    const expected = {
      status: 403,
      body: {
        code: 'forbidden',
        message: 'requires owner on organization:hq',
        details: { relation: 'owner', object: 'organization:hq' },
      },
    };
    const reqs = [
      { method: 'GET', path: '/admin/users' },
      { method: 'GET', path: `/admin/users/${U.storeAdmin}/roles` },
      {
        method: 'POST',
        path: `/admin/users/${U.storeAdmin}/roles`,
        body: { relation: 'store_admin', object_type: 'store', object_id: S.brandC },
      },
      { method: 'DELETE', path: `/admin/users/${U.storeAdmin}/roles/${U.storeAdmin}` },
    ];
    for (const r of reqs)
      expect(await rbac.handle({ ...r, principal: storeAdmin }), r.path).toEqual(expected);
    expect(await check(U.storeAdmin, 'store_admin', `store:${S.brandC}`)).toBe(false);
  });

  it('owner lists users (7 seeded, searchable, paged) and a user’s roles', async () => {
    const all = await rbac.handle({ method: 'GET', path: '/admin/users', principal: owner });
    expect(all?.status).toBe(200);
    const page = all!.body as {
      page: number;
      limit: number;
      total: number;
      items: { email: string }[];
    };
    expect(page.total).toBe(7);
    expect(page.items.map((u) => u.email)).toContain('store-admin@example.com');

    const q = await rbac.handle({
      method: 'GET',
      path: '/admin/users',
      principal: owner,
      query: { q: 'store', limit: '1', page: '2' },
    });
    const qb = q!.body as {
      total: number;
      items: { email: string }[];
      page: number;
      limit: number;
    };
    expect(qb).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(qb.items).toHaveLength(1);

    const roles = await rbac.handle({
      method: 'GET',
      path: `/admin/users/${U.storeAdmin}/roles`,
      principal: owner,
    });
    const items = (roles!.body as { items: { relation: string; object_id: string }[] }).items;
    expect(items.map((i) => `${i.relation}@${i.object_id}`).sort()).toEqual(
      [`store_admin@${S.brandA}`, `store_admin@${S.brandB}`].sort(),
    );
  });

  it('rejects bad assignments with 400 and unknown users with 404', async () => {
    const post = (userId: string, body: unknown) =>
      rbac.handle({ method: 'POST', path: `/admin/users/${userId}/roles`, principal: owner, body });
    const bad = [
      { relation: 'viewer', object_type: 'store', object_id: S.brandA },
      { relation: 'analyst', object_type: 'store', object_id: S.brandA }, // analyst is org-only in the model
      { relation: 'store_admin', object_type: 'organization', object_id: ORG },
      { relation: 'store_admin', object_type: 'store', object_id: 'not-a-uuid' },
      { relation: 'store_admin', object_type: 'store', object_id: U.owner }, // uuid, not a store
      { relation: 'finance', object_type: 'organization', object_id: S.brandA }, // not the org
    ];
    for (const body of bad) {
      const res = await post(U.storeStaff, body);
      expect(res?.status, JSON.stringify(body)).toBe(400);
      expect((res?.body as { code: string }).code).toBe('validation_error');
    }
    const missing = await post('00000000-0000-4000-8000-0000000000ff', {
      relation: 'store_admin',
      object_type: 'store',
      object_id: S.brandA,
    });
    expect(missing?.status).toBe(404);
    expect(
      await rbac.handle({ method: 'GET', path: '/admin/users/nope/roles', principal: owner }),
    ).toMatchObject({ status: 404 });
  });

  it('assign: tuple first, then mirror + audit; idempotent on repeat', async () => {
    const body = { relation: 'store_admin', object_type: 'store', object_id: S.brandC };
    const before = await countRows('audit_log');
    const res = await rbac.handle({
      method: 'POST',
      path: `/admin/users/${U.storeStaff}/roles`,
      principal: owner,
      body,
      requestId: 'req-1',
    });
    expect(res?.status).toBe(201);
    const a = res!.body as {
      id: string;
      relation: string;
      object_type: string;
      object_id: string;
      created_at: string;
    };
    expect(a).toMatchObject(body);
    expect(a.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await check(U.storeStaff, 'store_admin', `store:${S.brandC}`)).toBe(true);
    expect(await countRows('role_assignment WHERE id = $1', [a.id])).toBe(1);
    const auditRows = await hq.query<{
      action: string;
      actor_id: string;
      store_id: string;
      request_id: string;
      after: { id: string };
    }>(`SELECT action, actor_id, store_id, request_id, after FROM audit_log WHERE entity_id = $1`, [
      a.id,
    ]);
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]).toMatchObject({
      action: 'role_assignment.create',
      actor_id: U.owner,
      store_id: S.brandC,
      request_id: 'req-1',
    });
    expect(auditRows.rows[0]!.after.id).toBe(a.id);
    expect(changed).toContain(U.storeStaff);

    const again = await rbac.handle({
      method: 'POST',
      path: `/admin/users/${U.storeStaff}/roles`,
      principal: owner,
      body,
    });
    expect(again?.status).toBe(201);
    expect((again!.body as { id: string }).id).toBe(a.id);
    expect(
      await countRows('role_assignment WHERE staff_user_id = $1 AND object_id = $2', [
        U.storeStaff,
        S.brandC,
      ]),
    ).toBe(1);
    expect(await countRows('audit_log')).toBe(before + 1);
  });

  it('revoke: tuple deleted, row deleted, audit with before; second revoke → 404', async () => {
    const roles = await rbac.handle({
      method: 'GET',
      path: `/admin/users/${U.storeStaff}/roles`,
      principal: owner,
    });
    const target = (roles!.body as { items: { id: string; object_id: string }[] }).items.find(
      (i) => i.object_id === S.brandC,
    )!;
    const res = await rbac.handle({
      method: 'DELETE',
      path: `/admin/users/${U.storeStaff}/roles/${target.id}`,
      principal: owner,
    });
    expect(res).toEqual({ status: 204 });
    expect(await check(U.storeStaff, 'store_admin', `store:${S.brandC}`)).toBe(false);
    expect(await countRows('role_assignment WHERE id = $1', [target.id])).toBe(0);
    const auditRows = await hq.query<{ action: string; before: { id: string }; after: null }>(
      `SELECT action, before, after FROM audit_log WHERE entity_id = $1 ORDER BY created_at`,
      [target.id],
    );
    expect(auditRows.rows.map((r) => r.action)).toEqual([
      'role_assignment.create',
      'role_assignment.delete',
    ]);
    expect(auditRows.rows[1]!.before.id).toBe(target.id);
    expect(auditRows.rows[1]!.after).toBeNull();

    const again = await rbac.handle({
      method: 'DELETE',
      path: `/admin/users/${U.storeStaff}/roles/${target.id}`,
      principal: owner,
    });
    expect(again?.status).toBe(404);
    // store-staff still holds the seeded store_staff on brand-a
    expect(await check(U.storeStaff, 'store_staff', `store:${S.brandA}`)).toBe(true);
  });

  it('assign on the organization object resolves organization:hq', async () => {
    const res = await rbac.handle({
      method: 'POST',
      path: `/admin/users/${U.storeStaff}/roles`,
      principal: owner,
      body: { relation: 'analyst', object_type: 'organization', object_id: ORG },
    });
    expect(res?.status).toBe(201);
    expect(await check(U.storeStaff, 'analyst', 'organization:hq')).toBe(true);
    expect(await check(U.storeStaff, 'viewer', `store:${S.brandC}`)).toBe(true); // analyst from organization
    await rbac.handle({
      method: 'DELETE',
      path: `/admin/users/${U.storeStaff}/roles/${(res!.body as { id: string }).id}`,
      principal: owner,
    });
    expect(await check(U.storeStaff, 'analyst', 'organization:hq')).toBe(false);
  });

  it('rolls the tuple back when the mirror transaction fails (assign) and restores it (revoke)', async () => {
    const real = createOrganizationClient(db.app, { organizationId: ORG, actorId: U.owner });
    const broken: ScopedClient = {
      ...real,
      transaction: async () => {
        throw new Error('db down');
      },
    };
    const deps: RolesDeps = { fga, db: broken };
    await expect(
      assignRole(deps, {
        staffUserId: U.storeStaff,
        relation: 'store_admin',
        objectType: 'store',
        objectId: S.brandB,
      }),
    ).rejects.toThrow('db down');
    expect(await check(U.storeStaff, 'store_admin', `store:${S.brandB}`)).toBe(false);
    expect(
      await countRows('role_assignment WHERE staff_user_id = $1 AND object_id = $2', [
        U.storeStaff,
        S.brandB,
      ]),
    ).toBe(0);

    const seededRow = await hq.query<{ id: string }>(
      'SELECT id FROM role_assignment WHERE staff_user_id = $1 AND object_id = $2',
      [U.storeStaff, S.brandA],
    );
    await expect(
      revokeRole(deps, { staffUserId: U.storeStaff, assignmentId: seededRow.rows[0]!.id }),
    ).rejects.toThrow('db down');
    expect(await check(U.storeStaff, 'store_staff', `store:${S.brandA}`)).toBe(true);
    expect(await countRows('role_assignment WHERE id = $1', [seededRow.rows[0]!.id])).toBe(1);
  });

  it('answers 503 (fail closed) when OpenFGA is unreachable', async () => {
    const down = createHqRbac({
      pool: db.app,
      fga: createOpenFgaClient({ apiUrl: 'http://127.0.0.1:9', storeId: fgaStoreId }),
    });
    const res = await down.handle({ method: 'GET', path: '/admin/users', principal: owner });
    expect(res?.status).toBe(503);
  });
});
