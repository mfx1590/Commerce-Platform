/** @vitest-environment node */
/**
 * Sign out (#353) against the real OIDC helpers, with Keycloak replaced by a stubbed `fetch`:
 * the realm session is ended server-side before the browser is sent anywhere, the local session is
 * dropped whatever Keycloak answers, and the middleware's liveness check fails closed — a copied
 * cookie or a Keycloak outage ends at sign-in, never at a page or a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from '@/lib/auth/session';
import { sealSession } from '@/lib/auth/session';

const SECRET = 'test-session-secret-at-least-32-characters';
const KC = 'http://localhost:8180/realms/staff/protocol/openid-connect';
const METADATA = {
  issuer: 'http://localhost:8180/realms/staff',
  authorization_endpoint: `${KC}/auth`,
  token_endpoint: `${KC}/token`,
  userinfo_endpoint: `${KC}/userinfo`,
  end_session_endpoint: `${KC}/logout`,
};

/** An unsigned ID token built at runtime — no token-shaped literal is kept in git. */
function idToken(claims: Record<string, string>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: 'access-words',
    refreshToken: 'refresh-words',
    idToken: idToken({ sid: 'session-one', sub: 'sub-1', preferred_username: 'store-admin' }),
    expiresAt: Date.now() + 600_000,
    user: {
      subject: 'sub-1',
      username: 'store-admin',
      email: 'store-admin@example.com',
      displayName: 'Sam StoreAdmin',
    },
    ...overrides,
  };
}

async function requestWith(value: Session | null, path: string, method = 'GET') {
  const request = new NextRequest(new URL(`http://localhost:3000${path}`), { method });
  if (value !== null) request.cookies.set('admin_session.0', await sealSession(value, SECRET));
  return request;
}

type Answer = (url: string, init?: RequestInit) => Response | Promise<Response>;
let calls: { url: string; method: string; body: string }[] = [];
function keycloak(answer: Answer) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json(METADATA);
      return answer(url, init);
    }),
  );
}

const oidc = await import('@/lib/auth/oidc');
const liveness = await import('@/lib/auth/liveness');
const { POST } = await import('@/app/api/auth/logout/route');
const { middleware } = await import('@/middleware');

beforeEach(() => {
  calls = [];
  oidc.resetDiscoveryCache();
  liveness.resetLivenessCache();
});
afterEach(() => vi.unstubAllGlobals());

function cleared(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((header) => /^admin_session\.\d=;/.test(header))
    .map((header) => header.split('=')[0] ?? '');
}

describe('Sign out', () => {
  it('ends the Keycloak session server-side, then drops the local one, then redirects', async () => {
    keycloak(() => new Response(null, { status: 204 }));
    const response = await POST(await requestWith(session(), '/api/auth/logout', 'POST'));

    // 1. the realm session, before anything else
    const backchannel = calls.find((call) => call.method === 'POST' && call.url === `${KC}/logout`);
    expect(backchannel).toBeDefined();
    expect(new URLSearchParams(backchannel?.body)).toEqual(
      new URLSearchParams({ client_id: 'admin-app', refresh_token: 'refresh-words' }),
    );
    // 2. the local session: every chunk, the whole cookie jar, nothing cached
    expect(cleared(response)).toEqual(
      expect.arrayContaining(['admin_session.0', 'admin_session.1']),
    );
    expect(response.headers.get('clear-site-data')).toBe('"cookies"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    // 3. the browser to Keycloak's end-session, with the hint and the registered return address
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${KC}/logout`);
    expect(location.searchParams.get('id_token_hint')).toBe(session().idToken);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/');
  });

  it('Keycloak unreachable: the local session is still dropped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const response = await POST(await requestWith(session(), '/api/auth/logout', 'POST'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(cleared(response)).toContain('admin_session.0');
    expect(response.headers.get('clear-site-data')).toBe('"cookies"');
  });

  it('Keycloak refuses the back-channel call: the local session is still dropped', async () => {
    keycloak(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const response = await POST(await requestWith(session(), '/api/auth/logout', 'POST'));
    expect(cleared(response)).toContain('admin_session.0');
    expect(response.headers.get('location')).toContain(`${KC}/logout`);
  });

  it('without a session there is nothing to end: home, cookies cleared anyway', async () => {
    keycloak(() => new Response(null, { status: 204 }));
    const response = await POST(await requestWith(null, '/api/auth/logout', 'POST'));
    expect(calls).toHaveLength(0);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(cleared(response)).toContain('admin_session.0');
  });
});

describe('the session is checked against Keycloak (fail closed)', () => {
  it('sessionIsLive: 200 → live; 401 (session ended) → not; no answer → not', async () => {
    keycloak(() => Response.json({ sub: 'sub-1' }));
    await expect(oidc.sessionIsLive('access-words')).resolves.toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: `${KC}/userinfo`, method: 'GET' });

    keycloak(() => new Response(null, { status: 401 }));
    await expect(oidc.sessionIsLive('access-words')).resolves.toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(oidc.sessionIsLive('access-words')).resolves.toBe(false);
  });

  it('after Sign out, the OLD cookie is redirected to sign in (the realm answers 401)', async () => {
    const old = session();
    keycloak(() => new Response(null, { status: 204 }));
    await POST(await requestWith(old, '/api/auth/logout', 'POST'));

    // The copy kept from before Sign out, replayed: userinfo now answers 401.
    keycloak(() => new Response(null, { status: 401 }));
    const response = await middleware(await requestWith(old, '/brand-a/orders'));
    expect(response.headers.get('location')).toContain('/api/auth/login');
  });

  it('a Keycloak outage during a normal page load sends the user to sign in, not a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const response = await middleware(await requestWith(session(), '/brand-a/orders'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/api/auth/login');
  });

  it('the session id is Keycloak’s `sid`', () => {
    expect(oidc.sessionIdOf(session().idToken)).toBe('session-one');
    expect(oidc.sessionIdOf('not-a-token')).toBe('');
  });
});
