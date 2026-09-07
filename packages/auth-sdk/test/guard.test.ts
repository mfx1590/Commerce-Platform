// Public guard API (issue #15): can / allowedStores / resolveScope / requirePermission, the x-permission
// contract sweep, and verifyCustomerToken's store binding. Unit tests run on a mocked OpenFGA client; the
// integration part uses docker OpenFGA (throw-away store) and docker Keycloak when reachable.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELATIONS } from '@platform/contracts';
import { SEED_IDS } from '@platform/db';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedStores,
  ANY_STORE,
  can,
  createCustomerTokenVerifier,
  createOpenFgaClient,
  requirePermission,
  resolvePermissionObject,
  resolveScope,
  seedOpenFga,
  type OpenFgaClient,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const U = SEED_IDS.users;
const S = SEED_IDS.stores;

// ---------------------------------------------------------------- x-permission sweep (static, always runs)
describe('every x-permission in admin-api.yaml is resolvable', () => {
  const spec = readFileSync(resolve(here, '../../contracts/openapi/admin-api.yaml'), 'utf8');
  const permissions = [
    ...spec.matchAll(/x-permission:\s*\{\s*relation:\s*(\w+),\s*object:\s*'([^']+)'\s*\}/g),
  ].map((m) => ({ relation: m[1]!, object: m[2]! }));

  it('finds the permissions (sanity)', () => {
    expect(permissions.length).toBeGreaterThanOrEqual(30);
  });

  it.each(
    [...new Set(permissions.map((p) => JSON.stringify(p)))].map(
      (p) => JSON.parse(p) as { relation: string; object: string },
    ),
  )('$relation on $object', ({ relation, object }) => {
    expect([...RELATIONS, 'viewer']).toContain(relation);
    const params: Record<string, string> = {};
    for (const [, name] of object.matchAll(/\{(\w+)\}/g)) params[name!] = S.brandA;
    const resolved = resolvePermissionObject(object, params);
    expect(resolved).toMatch(/^(organization:hq|store:(\*|[0-9a-f-]{36}))$/);
    if (object !== ANY_STORE) expect(resolved).not.toContain('{');
  });

  it('a template with a missing route param is a 400, never a silent pass', () => {
    expect(() => resolvePermissionObject('store:{storeId}', {})).toThrowError(
      expect.objectContaining({ status: 400, code: 'validation_error' }),
    );
  });
});

// ---------------------------------------------------------------- unit tests, mocked OpenFGA
type Call = { user: string; relation: string; object?: string; type?: string };
function mockFga(overrides: { allowed?: boolean; stores?: string[]; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const fga = {
    async check(body: { user: string; relation: string; object: string }) {
      calls.push(body);
      if (overrides.fail) throw new Error('connection refused');
      return { allowed: overrides.allowed ?? false };
    },
    async listObjects(body: { user: string; relation: string; type: string }) {
      calls.push(body);
      if (overrides.fail) throw new Error('connection refused');
      return { objects: (overrides.stores ?? []).map((s) => `store:${s}`) };
    },
    async listRelations(body: { user: string; relations: string[] }) {
      calls.push({ user: body.user, relation: body.relations.join('|') });
      if (overrides.fail) throw new Error('connection refused');
      return { relations: [] };
    },
  } as unknown as OpenFgaClient;
  return { fga, calls };
}

describe('can / allowedStores / requirePermission (mocked OpenFGA)', () => {
  it('can() checks user:<id> with the given relation and object', async () => {
    const { fga, calls } = mockFga({ allowed: true });
    await expect(can(U.finance, 'finance', 'organization:hq', { fga })).resolves.toBe(true);
    expect(calls).toEqual([
      { user: `user:${U.finance}`, relation: 'finance', object: 'organization:hq' },
    ]);
    await expect(can({ userId: U.finance }, 'finance', 'organization:hq', { fga })).resolves.toBe(
      true,
    );
  });

  it('store:* means "any visible store" via ListObjects', async () => {
    const none = mockFga({ stores: [] });
    await expect(can(U.storeAdmin, 'viewer', ANY_STORE, { fga: none.fga })).resolves.toBe(false);
    const some = mockFga({ stores: [S.brandA] });
    await expect(can(U.storeAdmin, 'viewer', ANY_STORE, { fga: some.fga })).resolves.toBe(true);
    expect(some.calls[0]).toEqual({
      user: `user:${U.storeAdmin}`,
      relation: 'viewer',
      type: 'store',
    });
  });

  it('allowedStores() strips the store: prefix and sorts', async () => {
    const { fga } = mockFga({ stores: [S.brandB, S.brandA] });
    await expect(allowedStores(U.storeAdmin, { fga })).resolves.toEqual(
      [S.brandA, S.brandB].sort(),
    );
  });

  it('requirePermission passes when allowed and throws the exact contract 403 when not', async () => {
    const ok = mockFga({ allowed: true });
    const guard = requirePermission('store_admin', 'store:{storeId}');
    await expect(
      guard(U.storeAdmin, { storeId: S.brandA }, { fga: ok.fga }),
    ).resolves.toBeUndefined();
    expect(ok.calls[0]).toEqual({
      user: `user:${U.storeAdmin}`,
      relation: 'store_admin',
      object: `store:${S.brandA}`,
    });

    const no = mockFga({ allowed: false });
    await expect(guard(U.storeAdmin, { storeId: S.brandC }, { fga: no.fga })).rejects.toMatchObject(
      {
        status: 403,
        code: 'forbidden',
        message: `requires store_admin on store:${S.brandC}`,
        details: { relation: 'store_admin', object: `store:${S.brandC}` },
      },
    );
  });

  it('accepts a function objectFactory and exposes its relation', async () => {
    const { fga, calls } = mockFga({ allowed: true });
    const guard = requirePermission('finance', () => 'organization:hq');
    expect(guard.relation).toBe('finance');
    await guard(U.finance, undefined, { fga });
    expect(calls[0]).toMatchObject({ object: 'organization:hq' });
  });

  it('fails closed with 503 when OpenFGA is unreachable — can, allowedStores, resolveScope, guard', async () => {
    const { fga } = mockFga({ fail: true });
    const failure = { status: 503, code: 'internal' };
    await expect(can(U.owner, 'owner', 'organization:hq', { fga })).rejects.toMatchObject(failure);
    await expect(allowedStores(U.owner, { fga })).rejects.toMatchObject(failure);
    await expect(resolveScope(U.owner, { fga })).rejects.toMatchObject(failure);
    const guard = requirePermission('viewer', ANY_STORE);
    await expect(guard(U.owner, {}, { fga })).rejects.toMatchObject(failure);
  });
});

// ---------------------------------------------------------------- integration: docker OpenFGA + Keycloak
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const fgaLive = await up(`${API}/healthz`);
const kcLive = await up(`${KC}/realms/customers/.well-known/openid-configuration`);

describe.runIf(fgaLive)('guard API against docker OpenFGA (seeded tuples)', () => {
  let storeId: string;
  afterAll(async () => {
    if (storeId) await createOpenFgaClient({ apiUrl: API, storeId }).deleteStore();
  });

  it('resolveScope/can/allowedStores agree with the seeded model', async () => {
    const seeded = await seedOpenFga({ apiUrl: API, storeName: `guard-test-${Date.now()}` });
    storeId = seeded.storeId;
    const opts = { fga: seeded.client };

    await expect(can(U.storeAdmin, 'store_admin', `store:${S.brandA}`, opts)).resolves.toBe(true);
    await expect(can(U.storeAdmin, 'finance', 'organization:hq', opts)).resolves.toBe(false);
    await expect(allowedStores(U.storeAdmin, opts)).resolves.toEqual([S.brandA, S.brandB].sort());
    await expect(resolveScope(U.finance, opts)).resolves.toMatchObject({
      scope: 'organization',
      organizationRelations: ['finance'],
    });
    const financeGate = requirePermission('finance', 'organization:hq');
    await expect(financeGate(U.storeAdmin, {}, opts)).rejects.toMatchObject({
      status: 403,
      details: { relation: 'finance', object: 'organization:hq' },
    });
    await expect(financeGate(U.finance, {}, opts)).resolves.toBeUndefined();
  });
});

describe.runIf(kcLive)('verifyCustomerToken (live Keycloak)', () => {
  async function customerToken(): Promise<string> {
    const res = await fetch(`${KC}/realms/customers/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'test-cli',
        grant_type: 'password',
        username: 'jane@example.com',
        password: 'jane',
      }),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  }

  it('accepts the bound store, rejects another store, missing claim and garbage', async () => {
    const verifier = createCustomerTokenVerifier();
    const token = await customerToken(); // customers test-cli stamps store_code=brand-a (dev-only)
    const claims = await verifier.verify(`Bearer ${token}`, 'brand-a');
    expect(claims).toMatchObject({
      subject: 'seed-jane',
      storeCode: 'brand-a',
      email: 'jane@example.com',
    });
    await expect(verifier.verify(token, 'brand-b')).rejects.toMatchObject({
      status: 401,
      details: { reason: 'store_mismatch' },
    });
    // A token without the claim (staff realm has no store_code): no_store_code.
    const staffish = createCustomerTokenVerifier({ realm: 'staff' });
    const staffToken = await fetch(`${KC}/realms/staff/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'test-cli',
        grant_type: 'password',
        username: 'support',
        password: 'support',
      }),
    }).then((r) => r.json() as Promise<{ access_token: string }>);
    await expect(staffish.verify(staffToken.access_token, 'brand-a')).rejects.toMatchObject({
      status: 401,
      details: { reason: 'no_store_code' },
    });
    await expect(verifier.verify(undefined, 'brand-a')).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify('Bearer not.a.jwt', 'brand-a')).rejects.toMatchObject({
      status: 401,
    });
  });
});
