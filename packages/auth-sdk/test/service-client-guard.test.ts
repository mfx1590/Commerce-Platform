// Read-only guard for service-account clients (#565 / #622). Unit, always runs: tokens signed with a throw-away
// RS256 key and served from a local JWKS, so every branch is proven without the stack. The live counterpart
// (real Keycloak tokens through the scope middleware) is apps/core/src/modules/hq-rbac/test/service-clients.test.ts.
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStaffTokenVerifier,
  READ_ONLY_SERVICE_CLIENTS,
  readOnlyServiceClientOf,
  type ServiceClientRefusal,
  type StaffTokenVerifier,
} from '../src/index.js';

const ISSUER_BASE = 'http://keycloak.unit.test';
const ISSUER = `${ISSUER_BASE}/realms/staff`;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let server: Server;
let key: SigningKey;
let verifier: StaffTokenVerifier;
const refusals: ServiceClientRefusal[] = [];

const token = (claims: Record<string, unknown>) =>
  new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'unit' })
    .setIssuer(ISSUER)
    .setAudience('core-api')
    .setSubject(String(claims.sub ?? 'seed-crm-sync'))
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  key = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'unit', alg: 'RS256', use: 'sig' };
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  verifier = createStaffTokenVerifier({
    keycloakUrl: ISSUER_BASE,
    realm: 'staff',
    jwksUri: `http://127.0.0.1:${a.port}/certs`,
    onServiceClientRefusal: (r) => refusals.push(r),
  });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('read-only service clients (unit, local JWKS)', () => {
  it('the set is exactly crm-sync and analytics-sync, a code constant — no environment can change it', async () => {
    expect([...READ_ONLY_SERVICE_CLIENTS].sort()).toEqual(['analytics-sync', 'crm-sync']);
    // An empty or hostile environment changes nothing: the guard never reads one.
    process.env.READ_ONLY_SERVICE_CLIENTS = '';
    try {
      expect(readOnlyServiceClientOf({ azp: 'crm-sync' })).toBe('crm-sync');
    } finally {
      delete process.env.READ_ONLY_SERVICE_CLIENTS;
    }
    // Mutating the exported set cannot widen (or narrow) the guard: it reads its own private list.
    (READ_ONLY_SERVICE_CLIENTS as Set<string>).delete('crm-sync');
    try {
      expect(readOnlyServiceClientOf({ azp: 'crm-sync' })).toBe('crm-sync');
    } finally {
      (READ_ONLY_SERVICE_CLIENTS as Set<string>).add('crm-sync');
    }
  });

  it.each(['GET', 'HEAD', 'get'])(
    '%s: a service-client token passes and is marked',
    async (method) => {
      const claims = await verifier.verify(await token({ azp: 'crm-sync' }), {
        method,
        operationId: 'listCustomers',
      });
      expect(claims.serviceClient).toBe('crm-sync');
      expect(claims.subject).toBe('seed-crm-sync');
    },
  );

  it.each(['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'])(
    '%s: refused with the guard 403 (reason read_only_service_client), logged without PII',
    async (method) => {
      refusals.length = 0;
      await expect(
        verifier.verify(
          await token({
            azp: 'analytics-sync',
            sub: 'seed-analytics-sync',
            email: 'x@service.invalid',
          }),
          {
            method,
            operationId: 'updateStore',
          },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        details: {
          reason: 'read_only_service_client',
          client_id: 'analytics-sync',
          method,
          operation_id: 'updateStore',
        },
      });
      expect(refusals).toEqual([
        {
          event: 'service_client_write_refused',
          client_id: 'analytics-sync',
          method,
          operation_id: 'updateStore',
        },
      ]);
      const line = JSON.stringify(refusals);
      expect(line).not.toContain('seed-analytics-sync'); // no subject
      expect(line).not.toContain('@'); // no email
    },
  );

  it('fail closed: a service-client token without a request context is refused', async () => {
    await expect(verifier.verify(await token({ azp: 'crm-sync' }))).rejects.toMatchObject({
      status: 403,
      details: { reason: 'read_only_service_client', method: null },
    });
  });

  it('the client is read from the verified token: client_id is honoured when azp is absent', async () => {
    await expect(
      verifier.verify(await token({ client_id: 'crm-sync' }), { method: 'PATCH' }),
    ).rejects.toMatchObject({ status: 403, details: { reason: 'read_only_service_client' } });
  });

  it('people are unaffected: a human token passes any method, with or without the request context', async () => {
    for (const azp of ['admin-app', 'test-cli', undefined]) {
      const t = await token({ ...(azp ? { azp } : {}), sub: 'seed-support' });
      for (const request of [
        { method: 'PATCH', operationId: 'updateCustomer' },
        { method: 'POST' },
        undefined,
      ]) {
        const claims = await verifier.verify(t, request);
        expect(claims.serviceClient).toBeUndefined();
      }
    }
  });

  it('an unknown service client (not in the set) is not read-only by this guard — its permissions decide', async () => {
    const claims = await verifier.verify(await token({ azp: 'core-admin' }), { method: 'POST' });
    expect(claims.serviceClient).toBeUndefined();
  });

  it('a forged or expired token never reaches the guard: 401 first', async () => {
    const other = (await generateKeyPair('RS256')).privateKey;
    const forged = await new SignJWT({ azp: 'crm-sync' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unit' })
      .setIssuer(ISSUER)
      .setAudience('core-api')
      .setSubject('seed-crm-sync')
      .setExpirationTime('5m')
      .sign(other);
    await expect(verifier.verify(forged, { method: 'GET' })).rejects.toMatchObject({ status: 401 });
  });
});
