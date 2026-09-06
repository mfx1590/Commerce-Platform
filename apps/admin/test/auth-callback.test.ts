/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from '@/lib/auth/session';
import { joinChunks, openSession } from '@/lib/auth/session';
import {
  OIDC_RETURN_TO_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
} from '@/lib/auth/oidc-cookies';

const SECRET = 'test-session-secret-at-least-32-characters';

const exchangeCode = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/oidc', () => ({ exchangeCode }));

const { GET } = await import('@/app/api/auth/callback/route');

const SESSION: Session = {
  accessToken: 'access',
  refreshToken: 'refresh',
  idToken: 'id',
  expiresAt: Date.now() + 300_000,
  user: {
    subject: 'sub-1',
    username: 'store-admin',
    email: 'store-admin@example.com',
    displayName: 'Sam StoreAdmin',
  },
};

function callback(
  query: Record<string, string>,
  cookies: Record<string, string> = {
    [OIDC_STATE_COOKIE]: 'state-123',
    [OIDC_VERIFIER_COOKIE]: 'verifier-123',
  },
): NextRequest {
  const url = new URL('http://localhost:3000/api/auth/callback');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const request = new NextRequest(url);
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value);
  return request;
}

function location(response: Response): string {
  return response.headers.get('location') ?? '';
}

/** Reads the session back out of the Set-Cookie headers the route wrote. */
async function sessionFrom(response: Response): Promise<Session | null> {
  const jar = new Map<string, string>();
  for (const [name, value] of Object.entries(
    Object.fromEntries(
      response.headers
        .getSetCookie()
        .map((header) => header.split(';')[0]?.split('=') ?? [])
        .filter((pair): pair is [string, string] => pair.length === 2),
    ),
  )) {
    jar.set(name, value);
  }
  const sealed = joinChunks((name) => jar.get(name));
  return sealed === null || sealed === '' ? null : openSession(sealed, SECRET);
}

beforeEach(() => {
  vi.clearAllMocks();
  exchangeCode.mockResolvedValue(SESSION);
});

describe('/api/auth/callback', () => {
  it('redeems the code and seals the session into the cookie', async () => {
    const response = await GET(callback({ code: 'auth-code', state: 'state-123' }));

    expect(exchangeCode).toHaveBeenCalledWith(
      'auth-code',
      'verifier-123',
      'http://localhost:3000/api/auth/callback',
    );
    await expect(sessionFrom(response)).resolves.toEqual(SESSION);
  });

  it('never puts a readable token in a cookie', async () => {
    const response = await GET(callback({ code: 'auth-code', state: 'state-123' }));
    const headers = response.headers.getSetCookie().join('\n');

    expect(headers).not.toContain('access');
    expect(headers).not.toContain('refresh');
    expect(headers).toContain('HttpOnly');
  });

  it('returns the user to where they were going', async () => {
    const response = await GET(
      callback(
        { code: 'auth-code', state: 'state-123' },
        {
          [OIDC_STATE_COOKIE]: 'state-123',
          [OIDC_VERIFIER_COOKIE]: 'verifier-123',
          [OIDC_RETURN_TO_COOKIE]: '/stores?page=2',
        },
      ),
    );
    expect(location(response)).toEqual('http://localhost:3000/stores?page=2');
  });

  it('clears the transient PKCE cookies once they are spent', async () => {
    const response = await GET(callback({ code: 'auth-code', state: 'state-123' }));
    const cleared = response.headers
      .getSetCookie()
      .filter(
        (header) => header.includes('Max-Age=0') || header.includes('Expires=Thu, 01 Jan 1970'),
      );

    for (const name of [OIDC_STATE_COOKIE, OIDC_VERIFIER_COOKIE, OIDC_RETURN_TO_COOKIE]) {
      expect(cleared.some((header) => header.startsWith(`${name}=`))).toBe(true);
    }
  });

  it('refuses a state that does not match the cookie, without redeeming the code', async () => {
    // This is the CSRF check: a code delivered with someone else's state must not be spent.
    const response = await GET(callback({ code: 'auth-code', state: 'not-the-state' }));

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(location(response)).toContain('/auth/error?reason=');
    expect(decodeURIComponent(location(response))).toContain('state did not match');
    await expect(sessionFrom(response)).resolves.toBeNull();
  });

  it('refuses when the verifier cookie is gone', async () => {
    const response = await GET(
      callback({ code: 'auth-code', state: 'state-123' }, { [OIDC_STATE_COOKIE]: 'state-123' }),
    );
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(decodeURIComponent(location(response))).toContain('expired');
  });

  it('refuses when there is no code at all', async () => {
    const response = await GET(callback({ state: 'state-123' }));
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(location(response)).toContain('/auth/error');
  });

  it('surfaces a provider error instead of trying to redeem nothing', async () => {
    const response = await GET(
      callback({ error: 'access_denied', error_description: 'User cancelled' }),
    );
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(decodeURIComponent(location(response))).toContain('User cancelled');
  });

  it('shows the reason when the token endpoint rejects the exchange', async () => {
    exchangeCode.mockRejectedValue(new Error('Token endpoint returned 400: invalid_grant'));
    const response = await GET(callback({ code: 'auth-code', state: 'state-123' }));

    expect(decodeURIComponent(location(response))).toContain('invalid_grant');
    await expect(sessionFrom(response)).resolves.toBeNull();
  });
});
