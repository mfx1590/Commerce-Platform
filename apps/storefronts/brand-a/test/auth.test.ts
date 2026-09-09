import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizationUrl,
  codeChallenge,
  createCodeVerifier,
  createState,
  exchangeCode,
  oidcConfigFromEnv,
  safeReturnTo,
} from '@/lib/auth/oidc';
import { isExpired, parseSession, sessionFromTokens } from '@/lib/auth/session';

const CONFIG = {
  issuer: 'http://localhost:8180/realms/customers',
  clientId: 'storefront-brand-a',
  redirectUri: 'http://localhost:3100/auth/callback',
  scope: 'openid profile email',
};

describe('oidcConfigFromEnv', () => {
  it('defaults to the local customers realm and this app’s callback', () => {
    expect(oidcConfigFromEnv({})).toEqual(CONFIG);
  });

  it('follows the environment for Keycloak, realm, client and site URL', () => {
    const config = oidcConfigFromEnv({
      KEYCLOAK_URL: 'https://id.example.com/',
      KEYCLOAK_REALM_CUSTOMERS: 'customers-eu',
      KEYCLOAK_CLIENT_ID: 'storefront-brand-b',
      SITE_URL: 'https://brand-b.example.com/',
    });
    expect(config.issuer).toBe('https://id.example.com/realms/customers-eu');
    expect(config.clientId).toBe('storefront-brand-b');
    expect(config.redirectUri).toBe('https://brand-b.example.com/auth/callback');
  });
});

describe('PKCE', () => {
  it('produces a verifier in the RFC 7636 length range, unique per call', () => {
    const first = createCodeVerifier();
    const second = createCodeVerifier();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('derives the S256 challenge as base64url(sha256(verifier))', () => {
    const verifier = 'a'.repeat(43);
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(codeChallenge(verifier)).toBe(expected);
    expect(codeChallenge(verifier)).not.toContain('=');
  });

  it('matches the RFC 7636 appendix B test vector', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('builds an authorization URL with every parameter the realm requires', () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, { state: 'st', codeVerifier: 'ver-1234' }));
    expect(url.origin + url.pathname).toBe(
      'http://localhost:8180/realms/customers/protocol/openid-connect/auth',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'storefront-brand-a',
      redirect_uri: 'http://localhost:3100/auth/callback',
      scope: 'openid profile email',
      state: 'st',
      code_challenge: codeChallenge('ver-1234'),
      code_challenge_method: 'S256',
    });
  });

  it('creates unguessable state', () => {
    expect(createState()).not.toBe(createState());
  });
});

describe('safeReturnTo', () => {
  it('keeps a same-site path', () => {
    expect(safeReturnTo('/account/orders')).toBe('/account/orders');
    expect(safeReturnTo('/account?tab=addresses')).toBe('/account?tab=addresses');
  });

  it('refuses anything that could leave this site', () => {
    // An open redirect here would hand a freshly signed-in customer to an attacker's page.
    expect(safeReturnTo('https://evil.example/steal')).toBe('/account');
    expect(safeReturnTo('//evil.example')).toBe('/account');
    expect(safeReturnTo('/\\evil.example')).toBe('/account');
    expect(safeReturnTo('\\\\evil.example')).toBe('/account');
    expect(safeReturnTo('javascript:alert(1)')).toBe('/account');
  });

  it('falls back when there is nothing to return to', () => {
    expect(safeReturnTo(null)).toBe('/account');
    expect(safeReturnTo(undefined)).toBe('/account');
    expect(safeReturnTo('')).toBe('/account');
    expect(safeReturnTo(null, '/account/orders')).toBe('/account/orders');
  });
});

describe('session', () => {
  const now = 1_757_000_000_000;
  const tokens = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    id_token: 'id-1',
    expires_in: 300,
    token_type: 'Bearer',
  };

  it('turns a token response into a session with an absolute expiry', () => {
    expect(sessionFromTokens(tokens, now)).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'id-1',
      expiresAt: Math.floor(now / 1000) + 300,
    });
  });

  it('treats a token expiring within the skew window as already expired', () => {
    const session = sessionFromTokens(tokens, now);
    expect(isExpired(session, now)).toBe(false);
    expect(isExpired(session, now + 269_000)).toBe(false);
    // 30 s skew: at t+271 s the remaining life is under the allowance.
    expect(isExpired(session, now + 271_000)).toBe(true);
    expect(isExpired(session, now + 400_000)).toBe(true);
  });

  it('reads back what it wrote', () => {
    const session = sessionFromTokens(tokens, now);
    expect(parseSession(JSON.stringify(session))).toEqual(session);
  });

  it('treats a corrupted or truncated cookie as signed out rather than crashing', () => {
    expect(parseSession(undefined)).toBeNull();
    expect(parseSession('')).toBeNull();
    expect(parseSession('{"accessToken":"a",')).toBeNull();
    expect(parseSession('"a string"')).toBeNull();
    expect(parseSession('{"accessToken":"","expiresAt":1}')).toBeNull();
    expect(parseSession('{"accessToken":"a"}')).toBeNull();
    expect(parseSession('{"accessToken":"a","expiresAt":"soon"}')).toBeNull();
  });
});

describe('exchangeCode', () => {
  it('posts the PKCE verifier as form-encoded and never as a query string', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'a', expires_in: 60, token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await exchangeCode(
      CONFIG,
      { code: 'the-code', codeVerifier: 'the-verifier' },
      fetchImpl as never,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8180/realms/customers/protocol/openid-connect/token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'storefront-brand-a',
      redirect_uri: 'http://localhost:3100/auth/callback',
      code: 'the-code',
      code_verifier: 'the-verifier',
    });
  });

  it('throws without echoing the response body, which can contain the code', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"invalid_grant","code":"leaky"}', { status: 400 }),
    );
    await expect(
      exchangeCode(CONFIG, { code: 'c', codeVerifier: 'v' }, fetchImpl as never),
    ).rejects.toThrow(/returned 400$/);
  });
});
