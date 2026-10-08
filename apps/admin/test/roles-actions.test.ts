/**
 * HQ roles server actions (#428): owner on organization:hq, checked before the API; the table is
 * the yaml's; the forms' rules are re-checked server-side; the contract's 409 lands on the field.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import { SEED } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'owner' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({ inviteUser: vi.fn(), assignRole: vi.fn(), revokeRole: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/roles');
const { ROLES_PERMISSIONS, GRANTABLE } = await import('@/lib/roles');

const USER = '00000000-0000-4000-8000-000000000048';
const ASSIGNMENT = '00000000-0000-4000-8000-000000000071';
const ORG = '00000000-0000-4000-8000-000000000001';
const toStore = {
  relation: 'store_admin' as const,
  object_type: 'store' as const,
  object_id: SEED.stores.brandA,
};
const person = { email: 'new@example.com', display_name: 'New Person' };
const staffUser = { id: USER, ...person, status: 'active', last_login_at: null };

const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'owner';
  api.inviteUser.mockResolvedValue(ok(staffUser, 201));
  api.assignRole.mockResolvedValue(
    ok({ id: ASSIGNMENT, ...toStore, created_at: '2026-10-08T00:00:00Z' }, 201),
  );
  api.revokeRole.mockResolvedValue(ok(null, 204));
});

const calls = {
  inviteUser: () => actions.inviteUserAction(person),
  assignRole: () => actions.assignRoleAction(USER, toStore),
  revokeRole: () => actions.revokeRoleAction(USER, ASSIGNMENT),
} as const;

describe('ROLES_PERMISSIONS is the x-permission admin-api.yaml carries', () => {
  it('every row', () => {
    const spec = readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    for (const [operation, { relation }] of Object.entries(ROLES_PERMISSIONS)) {
      const at = spec.indexOf(`operationId: ${operation}\n`);
      expect(at, operation).toBeGreaterThan(-1);
      const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
        spec.slice(at, at + 1500),
      );
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe('organization:hq');
    }
  });
});

describe('each roles action refuses, server-side, before the API', () => {
  it.each(['storeAdmin', 'finance', 'support'] as const)(
    '%s is refused every action',
    async (role) => {
      principalOf.current = role;
      for (const [name, call] of Object.entries(calls)) {
        expect(await call(), name).toMatchObject({
          status: 'error',
          refusal: {
            status: 403,
            error: { details: { relation: 'owner', object: 'organization:hq' } },
          },
        });
      }
      expect(api.inviteUser).not.toHaveBeenCalled();
      expect(api.assignRole).not.toHaveBeenCalled();
      expect(api.revokeRole).not.toHaveBeenCalled();
    },
  );

  it('owner reaches the API for each', async () => {
    for (const [name, call] of Object.entries(calls)) {
      expect(await call(), name).toMatchObject({ status: 'success' });
    }
  });

  it('path ids that are not uuids never reach the API', async () => {
    expect(await actions.assignRoleAction('u-1', toStore)).toMatchObject({ status: 'error' });
    expect(await actions.revokeRoleAction(USER, '../x')).toMatchObject({ status: 'error' });
    expect(api.assignRole).not.toHaveBeenCalled();
    expect(api.revokeRole).not.toHaveBeenCalled();
  });
});

describe('the model decides what can be granted, and the server re-checks it', () => {
  it('finance only on the organization; analyst never on a store', () => {
    expect(GRANTABLE.organization).toContain('finance');
    expect(GRANTABLE.store).not.toContain('finance');
    expect(GRANTABLE.store).not.toContain('analyst');
  });

  it.each([
    { relation: 'finance', object_type: 'store', object_id: SEED.stores.brandA },
    { relation: 'store_admin', object_type: 'organization', object_id: ORG },
  ] as const)(
    'a manipulated pair ($relation on $object_type) never reaches the API',
    async (pair) => {
      expect(await actions.assignRoleAction(USER, pair)).toMatchObject({
        status: 'error',
        formError: 'That relation cannot be granted on that object',
      });
      expect(api.assignRole).not.toHaveBeenCalled();
    },
  );
});

describe('invite', () => {
  it('a taken email (409) is an error under the email field', async () => {
    api.inviteUser.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: 'conflict', message: 'email already exists' },
    });
    expect(await actions.inviteUserAction(person)).toEqual({
      status: 'error',
      fieldErrors: { email: 'A staff user with this email already exists.' },
      formError: null,
    });
  });

  it('a 400 from the contract lands on the field it names', async () => {
    api.inviteUser.mockResolvedValue({
      ok: false,
      status: 400,
      error: { code: 'validation_error', message: 'must be an email', details: { field: 'email' } },
    });
    expect(await actions.inviteUserAction(person)).toMatchObject({
      status: 'error',
      fieldErrors: { email: 'must be an email' },
    });
  });

  it('the optional initial relation is granted after the 201', async () => {
    const result = await actions.inviteUserAction({ ...person, initial: toStore });
    expect(api.assignRole).toHaveBeenCalledWith(USER, toStore);
    expect(result).toMatchObject({
      status: 'success',
      data: { user: { id: USER }, assignment: { id: ASSIGNMENT }, assignmentError: null },
    });
  });

  it('the user exists even when the initial relation is refused — and the screen is told', async () => {
    api.assignRole.mockResolvedValue({
      ok: false,
      status: 400,
      error: { code: 'validation_error', message: 'nope' },
    });
    expect(await actions.inviteUserAction({ ...person, initial: toStore })).toMatchObject({
      status: 'success',
      data: { assignment: null, assignmentError: expect.stringMatching(/Invited, but .*nope/) },
    });
  });

  it('an invalid email never reaches the API', async () => {
    expect(await actions.inviteUserAction({ ...person, email: 'not-an-email' })).toMatchObject({
      status: 'error',
    });
    expect(api.inviteUser).not.toHaveBeenCalled();
  });
});
