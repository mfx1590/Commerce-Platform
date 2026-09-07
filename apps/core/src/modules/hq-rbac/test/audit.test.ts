// Audit writer + GET /admin/audit-log (issue #14) against a throw-away Postgres db and OpenFGA store.
import {
  audit,
  createOpenFgaClient,
  REDACTED,
  seedOpenFga,
  type OpenFgaClient,
  type StaffPrincipal,
  type StaffScope,
} from '@platform/auth-sdk';
import { createOrganizationClient, seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHqRbac } from '../index.js';

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
const live = (await up(`${API}/healthz`)) && Boolean(process.env.DATABASE_URL);

const principal = (userId: string): StaffPrincipal => ({
  userId,
  subject: `sub-${userId.slice(-2)}`,
  organizationId: ORG,
});
const orgScope = (userId: string, relations: StaffScope['organizationRelations']): StaffScope => ({
  userId,
  subject: `sub-${userId.slice(-2)}`,
  email: 'x@example.com',
  displayName: 'X',
  organizationId: ORG,
  organizationRelations: relations,
  storeIds: [S.brandA, S.brandB, S.brandC],
  scope: 'organization',
});
const storeScope = (userId: string, storeIds: string[]): StaffScope => ({
  userId,
  subject: `sub-${userId.slice(-2)}`,
  email: 'x@example.com',
  displayName: 'X',
  organizationId: ORG,
  organizationRelations: [],
  storeIds,
  scope: 'store',
});

describe.runIf(live)('audit log (live Postgres + OpenFGA)', () => {
  let db: TestDatabase;
  let fga: OpenFgaClient;
  let fgaStoreId: string;
  let rbac: ReturnType<typeof createHqRbac>;
  const ENTITY = '11111111-0000-4000-8000-00000000aaaa';

  beforeAll(async () => {
    db = await createTestDatabase('platform_audit');
    await seed(db.owner, { productsPerStore: 1, log: () => {} });
    const seeded = await seedOpenFga({ apiUrl: API, storeName: `audit-test-${Date.now()}` });
    fga = seeded.client;
    fgaStoreId = seeded.storeId;
    rbac = createHqRbac({ pool: db.app, fga });

    // Three rows: brand-a (staff actor), brand-b, and one organization-level (store_id NULL, system).
    const hq = createOrganizationClient(db.app, { organizationId: ORG, actorId: U.owner });
    await hq.transaction(async (tx) => {
      await audit(tx, {
        action: 'customer.update',
        entityType: 'customer',
        entityId: ENTITY,
        before: { id: ENTITY, email: 'old@example.com', status: 'active' },
        after: { id: ENTITY, email: 'new@example.com', status: 'disabled', phone: '+3161234' },
        storeId: S.brandA,
        actor: { id: U.owner, type: 'staff' },
        requestId: 'req-audit-1',
      });
      await audit(tx, {
        action: 'product.update',
        entityType: 'product',
        entityId: ENTITY,
        after: { id: ENTITY, title: 'Tee' },
        storeId: S.brandB,
        actor: { id: U.owner, type: 'staff' },
      });
      await audit(tx, {
        action: 'organization.update',
        entityType: 'organization',
        entityId: ORG,
        after: { id: ORG, settings: { flag: true } },
        storeId: null,
        actor: { id: null, type: 'system' },
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
  });

  it('redacts PII in before/after at write time; ids and status stay readable', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const row = await hq.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM audit_log WHERE action = 'customer.update' AND entity_id = $1`,
      [ENTITY],
    );
    expect(row.rows[0]!.before).toEqual({ id: ENTITY, email: REDACTED, status: 'active' });
    expect(row.rows[0]!.after).toEqual({
      id: ENTITY,
      email: REDACTED,
      status: 'disabled',
      phone: REDACTED,
    });
  });

  it('audit_log is append-only for platform_app: UPDATE and DELETE are denied', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await expect(hq.query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(hq.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
  });

  it('HQ scope sees everything, including store_id IS NULL rows', async () => {
    const res = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: principal(U.owner),
      scope: orgScope(U.owner, ['owner']),
      query: { entity_id: ENTITY },
    });
    expect(res?.status).toBe(200);
    const body = res!.body as { total: number; items: { store_id: string | null }[] };
    expect(body.total).toBe(2); // brand-a + brand-b rows for ENTITY; NULL row has entity_id = ORG
    const all = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: principal(U.owner),
      scope: orgScope(U.owner, ['owner']),
    });
    const items = (all!.body as { items: { store_id: string | null }[] }).items;
    expect(items.some((i) => i.store_id === null)).toBe(true);
  });

  it('store scope sees only its stores and never the NULL-store rows', async () => {
    const res = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: principal(U.storeAdmin),
      scope: storeScope(U.storeAdmin, [S.brandA, S.brandB]),
    });
    expect(res?.status).toBe(200);
    const items = (res!.body as { items: { store_id: string | null }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.store_id === S.brandA || i.store_id === S.brandB)).toBe(true);

    const onlyA = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: principal(U.storeAdmin),
      scope: storeScope(U.storeAdmin, [S.brandA]),
    });
    const itemsA = (onlyA!.body as { items: { store_id: string | null }[] }).items;
    expect(itemsA.every((i) => i.store_id === S.brandA)).toBe(true);
  });

  it('store_id filter re-checks viewer on that store: 403 for a store outside the scope', async () => {
    const denied = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: principal(U.storeAdmin),
      scope: storeScope(U.storeAdmin, [S.brandA, S.brandB]),
      query: { store_id: S.brandC },
    });
    expect(denied).toEqual({
      status: 403,
      body: {
        code: 'forbidden',
        message: `requires viewer on store:${S.brandC}`,
        details: { relation: 'viewer', object: `store:${S.brandC}` },
      },
    });
    const allowed = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: principal(U.storeAdmin),
      scope: storeScope(U.storeAdmin, [S.brandA, S.brandB]),
      query: { store_id: S.brandA },
    });
    expect(allowed?.status).toBe(200);
    expect(
      (allowed!.body as { items: { store_id: string }[] }).items.every(
        (i) => i.store_id === S.brandA,
      ),
    ).toBe(true);
  });

  it('filters, paging and order work; bad filters → 400; no scope → 401', async () => {
    const scope = orgScope(U.owner, ['owner']);
    const p = principal(U.owner);
    const get = (query: Record<string, string>) =>
      rbac.handle({ method: 'GET', path: '/admin/audit-log', principal: p, scope, query });

    const paged = await get({ limit: '1', page: '2', order: 'asc' });
    const pb = paged!.body as { page: number; limit: number; total: number; items: unknown[] };
    expect(pb).toMatchObject({ page: 2, limit: 1 });
    expect(pb.items).toHaveLength(1);
    expect(pb.total).toBeGreaterThanOrEqual(3);

    const byType = await get({ entity_type: 'product' });
    expect((byType!.body as { total: number }).total).toBe(1);
    const byActor = await get({ actor_id: U.owner });
    expect((byActor!.body as { total: number }).total).toBeGreaterThanOrEqual(2);
    const none = await get({ to: '2000-01-01T00:00:00Z' });
    expect((none!.body as { total: number }).total).toBe(0);

    for (const bad of [{ store_id: 'nope' }, { from: 'not-a-date' }, { order: 'sideways' }]) {
      const res = await get(bad as Record<string, string>);
      expect(res?.status, JSON.stringify(bad)).toBe(400);
    }
    const noScope = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: p,
      query: {},
    });
    expect(noScope?.status).toBe(401);
  });

  it('empty store scope (no relations anywhere) → 403, fail closed', async () => {
    const res = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: principal(U.analyst),
      scope: storeScope(U.analyst, []),
    });
    expect(res?.status).toBe(403);
  });
});
