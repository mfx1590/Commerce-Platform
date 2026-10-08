// inviteUser + session revocation on role change (issue #415, tasks 3.1b/c; #422) against the shared Keycloak
// (staff realm with the core-admin service account), a throw-away Postgres database and a throw-away OpenFGA
// store. Every user these tests touch is a throwaway invited here (`invite-<uuid>@example.com`), deleted in
// afterAll — loudly, so a leftover is a failed test, never a surprise in the realm. Seeded users are never
// changed and never logged out (#422 item 5): the revocation test invites its own user, gives it a dev-only
// password through the bootstrap admin (what the invitation mail would lead to) and signs it in.
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
// The dev realm export's service-account secret (.env.example, #418); CI has no .env.
process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ??= 'dev-only-core-admin-secret';
/** Password the bootstrap admin sets on the throwaway user (allowlisted dev-only shape, never a real one). */
const THROWAWAY_PASSWORD = 'dev-only-invited-password';

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

/** Bootstrap admin (dev/CI only): stands in for the invitation mail — sets a password, clears the required actions. */
async function completeInvitation(subject: string): Promise<void> {
  const tok = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: process.env.KEYCLOAK_ADMIN ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  if (!tok.ok) throw new Error(`bootstrap admin token: ${tok.status}`);
  const { access_token } = (await tok.json()) as { access_token: string };
  const headers = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  const base = `${KC}/admin/realms/staff/users/${subject}`;
  const got = await fetch(base, { headers });
  if (!got.ok) throw new Error(`read invited user: ${got.status}`);
  const user = (await got.json()) as Record<string, unknown>;
  const put = await fetch(base, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...user, requiredActions: [], emailVerified: true }),
  });
  if (put.status !== 204) throw new Error(`clear required actions: ${put.status}`);
  const pw = await fetch(`${base}/reset-password`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ type: 'password', value: THROWAWAY_PASSWORD, temporary: false }),
  });
  if (pw.status !== 204) throw new Error(`set password: ${pw.status}`);
}

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

    const invite = async (principal: StaffPrincipal, email: string, displayName: string) =>
      rbac.handle({
        method: 'POST',
        path: '/admin/users',
        principal,
        body: { email, display_name: displayName },
      });

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

    it('POST /admin/users as owner: Keycloak user with both required actions, staff_user row, audit row; 409 twice; 403 for store-admin; 400 on a bad body', async () => {
      const email = `invite-${randomUUID()}@example.com`;
      const res = await invite(owner, email, 'Invited Person');
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

      const again = await invite(owner, email.toUpperCase(), 'Again');
      expect(again).toMatchObject({ status: 409, body: { code: 'conflict' } });

      // The seeded store-admin only resolves a scope here (no role change, no logout of a seeded user).
      const storeAdmin = principalOf(await mw.resolve(`Bearer ${await staffToken('store-admin')}`));
      const denied = await invite(storeAdmin, `invite-${randomUUID()}@example.com`, 'Nope');
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

    it('revokeRole on a throwaway invited user: the SAME token is refused on the next request and its Keycloak sessions are gone; a fresh assignment + token works again', async () => {
      const email = `invite-${randomUUID()}@example.com`;
      const created = await invite(owner, email, 'Throwaway Admin');
      expect(created?.status).toBe(201);
      const userId = (created?.body as { id: string }).id;
      const subject = (
        await db.owner.query<{ keycloak_subject: string }>(
          'SELECT keycloak_subject FROM staff_user WHERE id = $1',
          [userId],
        )
      ).rows[0]!.keycloak_subject;
      invited.push(subject);
      await completeInvitation(subject);

      const assigned = await rbac.handle({
        method: 'POST',
        path: `/admin/users/${userId}/roles`,
        principal: owner,
        body: { relation: 'store_admin', object_type: 'store', object_id: S.brandA },
      });
      expect(assigned?.status).toBe(201);
      const assignmentId = (assigned?.body as { id: string }).id;

      const token = await staffToken(email, { password: THROWAWAY_PASSWORD });
      const before = await mw.resolve(`Bearer ${token}`);
      expect(before.subject).toBe(subject);
      expect(before.storeIds).toEqual([S.brandA]);
      await expect(can(before, 'viewer', `store:${S.brandA}`, { fga })).resolves.toBe(true);
      const guard = requirePermission('store_admin', `store:${S.brandA}`);
      await expect(guard(before, { storeId: S.brandA }, { fga })).resolves.toBeUndefined();
      expect((await admin.listUserSessions(subject)).length).toBeGreaterThan(0);

      const revoked = await rbac.handle({
        method: 'DELETE',
        path: `/admin/users/${userId}/roles/${assignmentId}`,
        principal: owner,
      });
      expect(revoked?.status).toBe(204);

      // Same bearer token: the scope is re-resolved (cache invalidated) and brand A is gone.
      const after = await mw.resolve(`Bearer ${token}`);
      expect(after.storeIds).toEqual([]);
      await expect(can(after, 'viewer', `store:${S.brandA}`, { fga })).resolves.toBe(false);
      await expect(guard(after, { storeId: S.brandA }, { fga })).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
      expect(await admin.listUserSessions(subject)).toEqual([]);

      const reassigned = await rbac.handle({
        method: 'POST',
        path: `/admin/users/${userId}/roles`,
        principal: owner,
        body: { relation: 'store_admin', object_type: 'store', object_id: S.brandA },
      });
      expect(reassigned?.status).toBe(201);
      clearStaffTokenMemo(); // a fresh grant (no TOTP enrolled on the throwaway user)
      const fresh = await mw.resolve(
        `Bearer ${await staffToken(email, { password: THROWAWAY_PASSWORD })}`,
      );
      expect(fresh.storeIds).toEqual([S.brandA]);
      await expect(guard(fresh, { storeId: S.brandA }, { fga })).resolves.toBeUndefined();
    }, 90_000);
  },
);
