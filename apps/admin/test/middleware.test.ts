/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from '@/lib/auth/session';
import { REFRESH_SKEW_MS, joinChunks, openSession, sealSession } from '@/lib/auth/session';

const SECRET = 'test-session-secret-at-least-32-characters';

const refreshTokens = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/oidc', () => ({ refreshTokens }));

const { middleware } = await import('@/middleware');

function session(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    idToken: 'id-old',
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

async function requestWith(value: Session | null, path = '/stores'): Promise<NextRequest> {
  const request = new NextRequest(new URL(`http://localhost:3000${path}`));
  if (value !== null) {
    const sealed = await sealSession(value, SECRET);
    request.cookies.set('admin_session.0', sealed);
  }
  return request;
}

function setCookieJar(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair !== undefined && index > 0) {
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  return jar;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the gate', () => {
  it('sends an unauthenticated request to sign in, remembering where it was going', async () => {
    const response = await middleware(await requestWith(null, '/stores?page=2'));
    const location = response.headers.get('location') ?? '';

    expect(location).toContain('/api/auth/login');
    expect(decodeURIComponent(location)).toContain('returnTo=/stores?page=2');
  });

  it('does not add a returnTo for the root path', async () => {
    const response = await middleware(await requestWith(null, '/'));
    expect(response.headers.get('location')).toEqual('http://localhost:3000/api/auth/login');
  });

  it('treats an undecryptable cookie as signed out rather than crashing', async () => {
    const request = new NextRequest(new URL('http://localhost:3000/stores'));
    request.cookies.set('admin_session.0', 'not-a-sealed-session');

    const response = await middleware(request);
    expect(response.headers.get('location')).toContain('/api/auth/login');
    // And it clears the bad cookie, so the next request is not stuck in a loop.
    expect(setCookieJar(response).get('admin_session.0')).toEqual('');
  });

  it('lets a valid session through untouched', async () => {
    const response = await middleware(await requestWith(session()));

    expect(response.headers.get('location')).toBeNull();
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('refreshes a token that is inside the skew window', async () => {
    const refreshed = session({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: Date.now() + 600_000,
    });
    refreshTokens.mockResolvedValue(refreshed);

    const expiring = session({ expiresAt: Date.now() + REFRESH_SKEW_MS - 5_000 });
    const response = await middleware(await requestWith(expiring));

    expect(refreshTokens).toHaveBeenCalledWith('refresh-old');
    expect(response.headers.get('location')).toBeNull();

    // The browser gets the new token...
    const jar = setCookieJar(response);
    const sealed = joinChunks((name) => jar.get(name));
    expect(sealed).not.toBeNull();
    await expect(openSession(sealed as string, SECRET)).resolves.toMatchObject({
      accessToken: 'access-new',
    });
  });

  it('gives the refreshed token to the current request too', async () => {
    // A server component reads cookies from the request, not the response; without this the page
    // would render with the token that is about to expire.
    const refreshed = session({ accessToken: 'access-new', expiresAt: Date.now() + 600_000 });
    refreshTokens.mockResolvedValue(refreshed);

    const request = await requestWith(session({ expiresAt: Date.now() + 1_000 }));
    await middleware(request);

    const sealed = joinChunks((name) => request.cookies.get(name)?.value);
    expect(sealed).not.toBeNull();
    await expect(openSession(sealed as string, SECRET)).resolves.toMatchObject({
      accessToken: 'access-new',
    });
  });

  it('starts a clean sign-in when the refresh token is spent', async () => {
    refreshTokens.mockRejectedValue(new Error('Token endpoint returned 400: invalid_grant'));

    const response = await middleware(
      await requestWith(session({ expiresAt: Date.now() + 1_000 })),
    );

    // Rendering with a token the Admin API will reject would show a 401 panel on every screen.
    expect(response.headers.get('location')).toContain('/api/auth/login');
    expect(setCookieJar(response).get('admin_session.0')).toEqual('');
  });

  it('starts a clean sign-in when Keycloak is unreachable', async () => {
    refreshTokens.mockRejectedValue(new Error('fetch failed'));
    const response = await middleware(await requestWith(session({ expiresAt: Date.now() - 1 })));
    expect(response.headers.get('location')).toContain('/api/auth/login');
  });

  it('refreshes an already-expired session rather than giving up on it', async () => {
    refreshTokens.mockResolvedValue(session({ accessToken: 'access-new' }));
    const response = await middleware(
      await requestWith(session({ expiresAt: Date.now() - 60_000 })),
    );

    expect(refreshTokens).toHaveBeenCalled();
    expect(response.headers.get('location')).toBeNull();
  });
});
