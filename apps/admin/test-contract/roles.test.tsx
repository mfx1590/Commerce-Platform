/**
 * HQ roles (#428) against the spec's own examples (Admin API 0.4.12): the six operations the
 * screen and its actions call, and the refusals the spec documents. Prism's `/admin/me` example is
 * a store_admin, not an owner — so the actions are refused by the server-side guard before the API
 * here, and the operations themselves are exercised through the wrappers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

// 4211–4217 are taken by the other suites.
const BASE = 'http://127.0.0.1:4218';
let prism: PrismHandle | undefined;
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test-token' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const api = await import('@/lib/api/admin');
const { adminRequest } = await import('@/lib/api/admin-client');
const actions = await import('@/app/actions/roles');

const USER = '00000000-0000-4000-8000-000000000044';
const ASSIGNMENT = '00000000-0000-4000-8000-000000000071';

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('the roles reads reach the paths the spec documents', () => {
  it('lists users with the fields the table renders', async () => {
    const result = await api.listUsers();
    if (!result.ok) throw new Error(`listUsers failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      id: expect.any(String),
      email: expect.any(String),
      display_name: expect.any(String),
      status: expect.stringMatching(/^(active|disabled)$/),
    });
    expect(result.data.items[0]).toHaveProperty('last_login_at');
  });

  it("lists a user's role assignments", async () => {
    const result = await api.listUserRoles(USER);
    if (!result.ok) throw new Error(`listUserRoles failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      id: expect.any(String),
      relation: expect.any(String),
      object_type: expect.stringMatching(/^(organization|store)$/),
      object_id: expect.any(String),
    });
  });

  it('reads the audit log for one actor on one store', async () => {
    const result = await api.listAuditLog({ actor_id: USER, store_id: SEED_STORE_ID, limit: 20 });
    if (!result.ok) throw new Error(`listAuditLog failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      action: expect.any(String),
      entity_type: expect.any(String),
      created_at: expect.any(String),
    });
  });
});

describe('the roles mutations against the spec', () => {
  it('inviteUser answers 201 with the staff user', async () => {
    const result = await api.inviteUser({ email: 'new@example.com', display_name: 'New Person' });
    expect(result).toMatchObject({ ok: true, data: { email: expect.any(String) } });
  });

  it('assignRole answers 201 with the assignment; revokeRole answers 204', async () => {
    const assigned = await api.assignRole(USER, {
      relation: 'store_admin',
      object_type: 'store',
      object_id: SEED_STORE_ID,
    });
    expect(assigned).toMatchObject({ ok: true, data: { relation: expect.any(String) } });
    const revoked = await api.revokeRole(USER, ASSIGNMENT);
    expect(revoked.ok).toBe(true);
  });

  it("every roles action is refused for Prism's store_admin before the API (owner on hq)", async () => {
    const refusal = {
      status: 'error',
      refusal: {
        status: 403,
        error: { details: { relation: 'owner', object: 'organization:hq' } },
      },
    };
    expect(
      await actions.inviteUserAction({ email: 'new@example.com', display_name: 'New Person' }),
    ).toMatchObject(refusal);
    expect(
      await actions.assignRoleAction(USER, {
        relation: 'support',
        object_type: 'store',
        object_id: SEED_STORE_ID,
      }),
    ).toMatchObject(refusal);
    expect(await actions.revokeRoleAction(USER, ASSIGNMENT)).toMatchObject(refusal);
  });

  it('the documented 409 on inviteUser is a conflict', async () => {
    const result = await adminRequest<'inviteUser'>({
      baseUrl: BASE,
      path: '/admin/users',
      method: 'POST',
      body: { email: 'store-admin@example.com', display_name: 'Sam' },
      accessToken: 'contract-test-token',
      headers: preferring(409),
    });
    if (result.ok) throw new Error('expected 409');
    expect(result.status).toBe(409);
    expect(result.error.code).toBe('conflict');
  });
});
