// inviteUser + session revocation on role change (issue #415, tasks 3.1b/c) against the shared Keycloak
// (staff realm with the core-admin service account), a throw-away Postgres database and a throw-away OpenFGA
// store. The invited user is a throwaway (`invite-<uuid>@example.com`) deleted in afterAll — loudly, so a
// leftover is a failed test, never a surprise in the realm. Seeded users are never changed in Keycloak; the
// role change of store-admin happens in the throw-away database and store, and only its sessions are ended.
import { randomUUID } from 'node:crypto';
import {
  can,
  createKeycloakAdmin,
  createOpenFgaClient,
  requirePermission,
  ScopeCache,
  SCOPE_CACHE_MAX_TTL_MS,
  seedOpenFga,
  type KeycloakAdmin,
  type OpenFgaClient,
  type StaffPrincipal,
  type StaffScope,
} from '@platform/auth-sdk';
import { clearStaffTokenMemo, staffToken } from '@platform/auth-sdk/testing';
import { seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHqRbac, createStaffScopeMiddleware } from '../index.js';

const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const ORG = SEED_IDS.organization;
const S = SEED_IDS.stores;
// The dev realm export's service-account secret (.env.example, REQUEST #418); CI has no .env.
process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ??= 'dev-only-core-admin-secret';

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const live =
  (await up(`${KC}/realms/staff/.well-known/openid-configuration`)) &&
  (await up(`${API}/healthz`)) &&
  Boolean(process.env.DATABASE_URL);

const principalOf = (scope: StaffScope): StaffPrincipal => ({
  userId: scope.userId,
  subject: scope.subject,
  organizationId: ORG,
});

describe.runIf(live)(
  'inviteUser + session revocation (live Keycloak, throw-away Postgres + OpenFGA)',
  () => {
    let db: TestDatabase;
    let fga: OpenFgaClient;
    let fgaStoreId: string;
    let admin: KeycloakAdmin;
    let mw: ReturnType<typeof createStaffScopeMiddleware>;
    let rbac: ReturnType<typeof createHqRbac>;
    let owner: StaffPrincipal;
    const invited: string[] = []; // Keycloak subjects to delete

    beforeAll(async () => {
      db = await createTestDatabase('platform_invite');
      await seed(db.owner, { productsPerStore: 1, log: () => {} });
      const seeded = await seedOpenFga({ apiUrl: API, storeName: `invite-test-${Date.now()}` });
      fga = seeded.client;
      fgaStoreId = seeded.storeId;
      admin = createKeycloakAdmin();
      mw = createStaffScopeMiddleware({
        pool: db.app,
        fga,
        organizationId: ORG,
        cache: new ScopeCache(SCOPE_CACHE_MAX_TTL_MS),
      });
      rbac = createHqRbac({ pool: db.app, fga, keycloak: admin, onRoleChange: mw.invalidate });
      owner = principalOf(await mw.resolve(`Bearer ${await staffToken('owner')}`));
    }, 120_000);

    afterAll(async () => {
      const failures: string[] = [];
      for (const subject of invited) {
        await admin
          .deleteUser(subject)
          .catch((e: Error) => failures.push(`${subject}: ${e.message}`));
      }
      await db?.drop();
      if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
      if (failures.length) throw new Error(`invite cleanup failed: ${failures.join('; ')}`);
    });

    it('POST /admin/users as owner: Keycloak user with both required actions, staff_user row, audit row; 409 twice; 403 for store-admin', async () => {
      const email = `invite-${randomUUID()}@example.com`;
      const res = await rbac.handle({
        method: 'POST',
        path: '/admin/users',
        principal: owner,
        body: { email, display_name: 'Invited Person' },
      });
      expect(res?.status).toBe(201);
      const user = res?.body as {
        id: string;
        email: string;
        display_name: string;
        status: string;
        last_login_at: null;
      };
      expect(user).toMatchObject({
        email,
        display_name: 'Invited Person',
        status: 'active',
        last_login_at: null,
      });

      const row = await db.owner.query<{ keycloak_subject: string }>(
        'SELECT keycloak_subject FROM staff_user WHERE id = $1',
        [user.id],
      );
      expect(row.rowCount).toBe(1);
      const subject = row.rows[0]!.keycloak_subject;
      invited.push(subject);

      const kc = await admin.getUser(subject);
      expect(kc).toMatchObject({ username: email, email, enabled: true, emailVerified: false });
      expect([...(kc?.requiredActions ?? [])].sort()).toEqual([
        'CONFIGURE_TOTP',
        'UPDATE_PASSWORD',
      ]);

      const auditRows = await db.owner.query<{
        action: string;
        after: { keycloak_subject?: string };
      }>(
        "SELECT action, after FROM audit_log WHERE entity_type = 'staff_user' AND entity_id = $1",
        [user.id],
      );
      expect(auditRows.rows.map((r) => r.action)).toEqual(['staff_user.create']);
      expect(auditRows.rows[0]!.after.keycloak_subject).toBe(subject);

      const again = await rbac.handle({
        method: 'POST',
        path: '/admin/users',
        principal: owner,
        body: { email: email.toUpperCase(), display_name: 'Again' },
      });
      expect(again).toMatchObject({ status: 409, body: { code: 'conflict' } });

      const storeAdmin = principalOf(await mw.resolve(`Bearer ${await staffToken('store-admin')}`));
      const denied = await rbac.handle({
        method: 'POST',
        path: '/admin/users',
        principal: storeAdmin,
        body: { email: `invite-${randomUUID()}@example.com`, display_name: 'Nope' },
      });
      expect(denied).toEqual({
        status: 403,
        body: {
          code: 'forbidden',
          message: 'requires owner on organization:hq',
          details: { relation: 'owner', object: 'organization:hq' },
        },
      });
      const bad = await rbac.handle({
        method: 'POST',
        path: '/admin/users',
        principal: owner,
        body: { email },
      });
      expect(bad).toMatchObject({ status: 400, body: { code: 'validation_error' } });
    }, 60_000);

    it('revokeRole: the SAME store-admin token is refused on the next request, its Keycloak sessions are gone; a fresh assignment + token works again', async () => {
      const token = await staffToken('store-admin');
      const before = await mw.resolve(`Bearer ${token}`);
      expect(before.storeIds).toContain(S.brandA);
      await expect(can(before, 'viewer', `store:${S.brandA}`, { fga })).resolves.toBe(true);
      const guard = requirePermission('store_admin', `store:${S.brandA}`);
      await expect(guard(before, { storeId: S.brandA }, { fga })).resolves.toBeUndefined();
      expect((await admin.listUserSessions(before.subject)).length).toBeGreaterThan(0);

      const roles = await rbac.handle({
        method: 'GET',
        path: `/admin/users/${before.userId}/roles`,
        principal: owner,
      });
      const items = (
        roles?.body as { items: { id: string; object_id: string; relation: string }[] }
      ).items;
      const brandA = items.find((a) => a.object_id === S.brandA && a.relation === 'store_admin')!;
      expect(brandA).toBeDefined();
      const revoked = await rbac.handle({
        method: 'DELETE',
        path: `/admin/users/${before.userId}/roles/${brandA.id}`,
        principal: owner,
      });
      expect(revoked?.status).toBe(204);

      // Same bearer token: the scope is re-resolved (cache invalidated) and brand A is gone.
      const after = await mw.resolve(`Bearer ${token}`);
      expect(after.storeIds).not.toContain(S.brandA);
      await expect(can(after, 'viewer', `store:${S.brandA}`, { fga })).resolves.toBe(false);
      await expect(guard(after, { storeId: S.brandA }, { fga })).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
      expect(await admin.listUserSessions(before.subject)).toEqual([]);

      const reassigned = await rbac.handle({
        method: 'POST',
        path: `/admin/users/${before.userId}/roles`,
        principal: owner,
        body: { relation: 'store_admin', object_type: 'store', object_id: S.brandA },
      });
      expect(reassigned?.status).toBe(201);
      clearStaffTokenMemo(); // a fresh grant (no TOTP for store-admin)
      const fresh = await mw.resolve(`Bearer ${await staffToken('store-admin')}`);
      expect(fresh.storeIds).toContain(S.brandA);
      await expect(guard(fresh, { storeId: S.brandA }, { fga })).resolves.toBeUndefined();
    }, 60_000);
  },
);
