// Keycloak admin service-account client (issue #415). Unit: a fake Keycloak (node:http) with the token
// endpoint (client_credentials), users, logout, sessions. The live part against the real staff realm lives in
// apps/core/src/modules/hq-rbac/test/invite.test.ts (needs the core-admin client of the dev realm export).
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKeycloakAdmin, INVITE_REQUIRED_ACTIONS } from '../src/index.js';

const SECRET = 'dev-only-fake-admin-secret';

function fakeKeycloakAdmin() {
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, { id: string }[]>();
  const state = { tokens: 0, lastCreateBody: null as Record<string, unknown> | null };
  let next = 1;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (url === '/realms/staff/protocol/openid-connect/token' && req.method === 'POST') {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (
          body.get('grant_type') !== 'client_credentials' ||
          body.get('client_id') !== 'core-admin' ||
          body.get('client_secret') !== SECRET
        ) {
          return json(401, { error: 'unauthorized_client' });
        }
        state.tokens++;
        return json(200, { access_token: `sa-token-${state.tokens}`, expires_in: 300 });
      }
      if (req.headers.authorization !== `Bearer sa-token-${state.tokens}` || state.tokens === 0) {
        return json(401, { error: 'HTTP 401 Unauthorized' });
      }
      const m = url.match(/^\/admin\/realms\/staff\/users(?:\/([^/]+))?(?:\/(logout|sessions))?$/);
      if (!m) return json(404, { error: 'not found' });
      const [, id, sub] = m;
      if (!id && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        state.lastCreateBody = body;
        if ([...users.values()].some((u) => u.username === body.username)) {
          return json(409, { errorMessage: 'User exists with same username' });
        }
        const newId = `kc-${next++}`;
        users.set(newId, { id: newId, ...body });
        sessions.set(newId, [{ id: `sess-${newId}` }]);
        return json(201, undefined, { location: `http://fake/admin/realms/staff/users/${newId}` });
      }
      if (id && !sub && req.method === 'GET') {
        return users.has(id) ? json(200, users.get(id)) : json(404, { error: 'User not found' });
      }
      if (id && !sub && req.method === 'DELETE') {
        if (!users.has(id)) return json(404, { error: 'User not found' });
        users.delete(id);
        sessions.delete(id);
        return json(204);
      }
      if (id && sub === 'logout' && req.method === 'POST') {
        if (!users.has(id)) return json(404, { error: 'User not found' });
        sessions.set(id, []);
        return json(204);
      }
      if (id && sub === 'sessions' && req.method === 'GET') {
        return json(200, sessions.get(id) ?? []);
      }
      return json(405, { error: 'method' });
    });
  });
  return { server, state, users, sessions };
}

describe('createKeycloakAdmin (unit, fake Keycloak)', () => {
  const kc = fakeKeycloakAdmin();
  let url = '';
  beforeAll(async () => {
    await new Promise<void>((r) => kc.server.listen(0, '127.0.0.1', r));
    const a = kc.server.address();
    if (!a || typeof a === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${a.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => kc.server.close(() => r()));
  });
  beforeEach(() => {
    kc.users.clear();
    kc.sessions.clear();
    kc.state.tokens = 0;
    kc.state.lastCreateBody = null;
  });
  const admin = (secret: string | undefined = SECRET) =>
    createKeycloakAdmin({
      baseUrl: url,
      realm: 'staff',
      clientId: 'core-admin',
      clientSecret: secret,
    });

  it('creates the user with email = username, no password, both invite required actions; one token per client', async () => {
    const a = admin();
    const u = await a.createUser({ email: 'New.Person@Example.com ', displayName: ' New Person ' });
    expect(u.subject).toBe('kc-1');
    expect(u.username).toBe('new.person@example.com');
    expect(u.email).toBe('new.person@example.com');
    expect(u.firstName).toBe('New');
    expect(u.lastName).toBe('Person'); // the realm's user profile requires both names
    expect(u.enabled).toBe(true);
    expect(u.emailVerified).toBe(false);
    expect(u.requiredActions).toEqual([...INVITE_REQUIRED_ACTIONS]);
    expect(kc.state.lastCreateBody).not.toHaveProperty('credentials');
    expect(kc.state.lastCreateBody).toMatchObject({ enabled: true, emailVerified: false });
    expect(kc.state.tokens).toBe(1); // reused for the follow-up read
    expect(await a.getUser('kc-1')).toMatchObject({ subject: 'kc-1' });
    expect(kc.state.tokens).toBe(1);
  });

  it('a one-word display name is stored as first and last name (the profile requires both)', async () => {
    const u = await admin().createUser({ email: 'one@example.com', displayName: 'Madonna' });
    expect([u.firstName, u.lastName]).toEqual(['Madonna', 'Madonna']);
    const v = await admin().createUser({
      email: 'three@example.com',
      displayName: 'Ana Maria de Souza',
    });
    expect([v.firstName, v.lastName]).toEqual(['Ana', 'Maria de Souza']);
  });

  it('409 conflict when the email exists; 400 before any call for a bad email or an empty name', async () => {
    const a = admin();
    await a.createUser({ email: 'dup@example.com', displayName: 'Dup' });
    await expect(
      a.createUser({ email: 'dup@example.com', displayName: 'Dup 2' }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { field: 'email' } });
    await expect(a.createUser({ email: 'not-an-address', displayName: 'X' })).rejects.toMatchObject(
      {
        status: 400,
        details: { field: 'email' },
      },
    );
    await expect(
      a.createUser({ email: 'ok@example.com', displayName: '  ' }),
    ).rejects.toMatchObject({
      status: 400,
      details: { field: 'display_name' },
    });
    expect(kc.users.size).toBe(1);
  });

  it('logoutUser ends the sessions; listUserSessions shows none afterwards; deleteUser removes the user', async () => {
    const a = admin();
    const u = await a.createUser({ email: 'gone@example.com', displayName: 'Gone' });
    expect(await a.listUserSessions(u.subject)).toEqual([{ id: `sess-${u.subject}` }]);
    await a.logoutUser(u.subject);
    expect(await a.listUserSessions(u.subject)).toEqual([]);
    await a.deleteUser(u.subject);
    expect(await a.getUser(u.subject)).toBeNull();
    await expect(a.deleteUser(u.subject)).resolves.toBeUndefined(); // idempotent (404 tolerated)
    await expect(a.logoutUser(u.subject)).resolves.toBeUndefined();
  });

  it('503 on a wrong secret (operator problem, never the caller)', async () => {
    await expect(
      admin('dev-only-wrong-secret').createUser({ email: 'a@example.com', displayName: 'A' }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'internal',
      details: { what: 'service account token' },
    });
  });

  it('503 when no secret is configured: no silent fallback', async () => {
    const prev = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
    delete process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
    const noSecret = createKeycloakAdmin({ baseUrl: url, realm: 'staff', clientId: 'core-admin' });
    if (prev !== undefined) process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = prev;
    await expect(noSecret.getUser('kc-1')).rejects.toMatchObject({
      status: 503,
      details: { cause: 'KEYCLOAK_ADMIN_CLIENT_SECRET is not set' },
    });
  });

  it('503 when Keycloak is unreachable (connection refused on the discard port)', async () => {
    const nobody = createKeycloakAdmin({
      baseUrl: 'http://127.0.0.1:9',
      clientSecret: SECRET,
      timeoutMs: 2_000,
    });
    await expect(nobody.getUser('kc-1')).rejects.toMatchObject({ status: 503, code: 'internal' });
  });

  it('reads the defaults from the environment: realm staff, client core-admin', () => {
    const prev = { ...process.env };
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'core-admin';
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = SECRET;
    process.env.KEYCLOAK_URL = url;
    try {
      expect(createKeycloakAdmin().realm).toBe('staff');
    } finally {
      process.env = prev;
    }
  });
});
